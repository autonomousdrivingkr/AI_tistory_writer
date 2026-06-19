import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig, runSource, ROOT } from './config.js';
import {
  currentSlot, slotKey, isPublished, recordPublished,
  pickNextTopic, listPendingTopics, markTopicDone, pendingCount
} from './queue.js';
import { generateArticle } from './generator.js';
import { attachImages } from './images.js';
import { publishToTistory } from './publisher.js';
import { pullLatest, pushState } from './git-sync.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    slot: get('--slot') || 'auto',
    dryRun: args.includes('--dry-run'),
    headful: args.includes('--headful'),
    noPublish: args.includes('--no-publish'),
    force: args.includes('--force'),
    // 자동화(스케줄러에서 TTY 가 잡히는 드문 경우 등)에서 프롬프트를 강제로 끄는 탈출구
    yes: args.includes('--yes') || args.includes('-y')
  };
}

async function main() {
  const opts = parseArgs();
  const config = loadConfig();
  const source = runSource();
  const now = new Date();

  console.log(`\n📝 AI Tistory Writer | 환경: ${source} | ${now.toLocaleString('ko-KR')}`);

  // 0) 상태 동기화 (dry-run 이 아니고 gitSync 켜진 경우)
  if (!opts.dryRun && config.gitSync) pullLatest();

  // 1) 슬롯 결정
  let slot = opts.slot;
  if (slot === 'auto') {
    slot = currentSlot(config, now);
    if (!slot) {
      console.log('⏱️  현재 시간은 발행 시간대(아침/저녁)가 아닙니다. 종료.');
      return;
    }
  }
  console.log(`🎯 슬롯: ${slot} (${slotKey(slot, now)})`);

  // 2) 중복 발행 방지 — 이 슬롯이 이미 발행됐으면 종료 (PC/GitHub 이중 안전망의 핵심)
  if (!opts.force && !opts.dryRun && isPublished(slot, now)) {
    console.log('✅ 이 시간대는 이미 발행되었습니다. (중복 방지) 종료.');
    return;
  }

  // 3) 다음 주제 선택
  //    사람이 터미널에서 직접 실행한 경우(=TTY 가 있고 CI/--yes 가 아닌 경우)에는
  //    dry-run·no-publish·실제발행 어느 쪽이든 주제를 직접 고르거나 새로 입력할 수 있게 한다.
  //    자동 발행(스케줄러·CI 는 TTY 없음)에서는 기존대로 첫 pending 주제를 자동 선택.
  const interactive = process.stdin.isTTY && !process.env.CI && !opts.yes;
  const topicItem = interactive ? await chooseTopicInteractive() : pickNextTopic();
  if (!topicItem) {
    console.log(`📭 발행할 주제가 없습니다. topics.json 에 주제를 추가하세요. (남은 주제: ${pendingCount()})`);
    return;
  }
  console.log(`📌 주제: ${topicItem.topic}`);

  // 4) LLM으로 글 생성
  console.log(`🤖 ${config.llm.provider}(으)로 글 생성 중...`);
  const article = await generateArticle({
    topic: topicItem.topic,
    instructions: topicItem.instructions,
    config
  });
  console.log(`   제목: ${article.title}`);
  console.log(`   태그: ${article.tags.join(', ')}`);
  console.log(`   본문 길이: ${article.html.length}자`);

  // 4.5) 관련 사진 삽입 (config.images.enabled && PEXELS_API_KEY 필요, 실패해도 글은 계속)
  const { html: htmlWithImages, images } = await attachImages(article, config);
  article.html = htmlWithImages;
  if (images.length) console.log(`   🖼️  사진 ${images.length}장 삽입`);

  // 5) dry-run 이면 파일로만 저장하고 종료
  if (opts.dryRun) {
    const outDir = join(ROOT, 'output');
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `${slotKey(slot, now)}.html`);
    writeFileSync(file, renderPreview(article));
    console.log(`\n🧪 dry-run: 미리보기 저장 → ${file}`);
    console.log('   브라우저로 열어 글 품질을 확인하세요. (발행은 하지 않음)\n');
    return;
  }

  // 6) 티스토리 발행
  //    --no-publish: 브라우저에 제목/본문/태그 입력까지만 하고 최종 발행은 건너뛴다(에디터 동작 확인용).
  if (opts.noPublish) config.tistory = { ...config.tistory, publish: false };
  console.log(opts.noPublish ? '🧪 티스토리 에디터 입력 테스트 중 (--no-publish)...' : '🚀 티스토리에 발행 중...');
  const { url } = await publishToTistory(article, config, { headful: opts.headful });

  // --no-publish 는 상태 기록/커밋/주제 소진을 모두 건너뛴다 (반복 테스트해도 데이터가 안 망가지게).
  if (opts.noPublish) {
    console.log('🧪 --no-publish: 입력 동작만 확인하고 종료 (상태 기록·커밋·주제 소진 생략).\n');
    return;
  }
  console.log(`   발행됨: ${url || '(URL 확인 불가 — 블로그 관리에서 확인하세요)'}`);

  // 7) 상태 기록
  recordPublished({
    key: slotKey(slot, now),
    topic: topicItem.topic,
    title: article.title,
    url: url || '',
    at: new Date().toISOString(),
    source
  });
  markTopicDone(topicItem.topic, { url });
  console.log(`📊 남은 주제: ${pendingCount()}`);

  // 8) 변경분 커밋·푸시
  if (config.gitSync) pushState(`chore: 발행 ${slotKey(slot, now)} (${source})`);

  console.log('🎉 완료!\n');
}

/**
 * 테스트 발행 시 대화형으로 주제를 선택/입력한다.
 *  - Enter        → 기본 주제(첫 번째 대기 주제)
 *  - 번호         → 해당 대기 주제
 *  - 그 외 텍스트 → 직접 입력한 임시 주제(세부 지시사항도 물어봄)
 * 반환: 주제 객체 또는 null(주제 없음·취소)
 */
async function chooseTopicInteractive() {
  const pending = listPendingTopics();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (pending.length) {
      console.log('\n📋 대기 중인 주제:');
      pending.forEach((t, i) => {
        console.log(`   ${i + 1}) ${t.topic}${i === 0 ? '   ← 기본' : ''}`);
      });
    } else {
      console.log('\n📭 대기 중인 주제가 없습니다. 테스트할 주제를 직접 입력하세요.');
    }

    const answer = (await rl.question(
      '\n👉 Enter=기본 주제 / 번호=해당 주제 / 직접 입력=새 주제 : '
    )).trim();

    // Enter → 기본(첫 번째 대기 주제)
    if (answer === '') return pending[0] || null;

    // 번호 선택
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= pending.length) {
      return pending[n - 1];
    }

    // 그 외 → 직접 입력한 임시 주제 (테스트용이므로 topics.json 에는 저장하지 않음)
    const instructions = (await rl.question(
      '   세부 지시사항(선택, Enter 로 건너뛰기): '
    )).trim();
    return { topic: answer, instructions, status: 'pending' };
  } finally {
    rl.close();
  }
}

function renderPreview(article) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>${article.title}</title>
<style>body{max-width:760px;margin:40px auto;padding:0 16px;font-family:system-ui,'Malgun Gothic',sans-serif;line-height:1.8;color:#222}h1{border-bottom:2px solid #eee;padding-bottom:8px}</style>
</head><body>
<h1>${article.title}</h1>
<p style="color:#888"><em>${article.summary}</em></p>
<p style="color:#888">태그: ${article.tags.join(', ')}</p>
<hr>
${article.html}
</body></html>`;
}

main().catch((e) => {
  console.error('\n❌ 실행 실패:', e.message);
  // process.exit(1) 을 동기로 호출하면, 진행 중이던 비동기 핸들(HTTP 소켓·브라우저 파이프)이
  // 정리되는 도중 libuv 가 "닫히는 중인" 핸들에 접근해 Windows 에서 abort 합니다:
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
  // exitCode 만 설정하고 이벤트 루프가 자연히 비워지게 두면 핸들이 깨끗하게 닫힌 뒤 종료됩니다.
  process.exitCode = 1;
});
