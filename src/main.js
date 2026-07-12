import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig, runSource, ROOT, getBlogs, resolveBlog, defaultBlog } from './config.js';
import {
  currentSlot, slotKey, isPublished, recordPublished,
  pickNextTopic, listPendingTopics, markTopicDone, pendingCount
} from './queue.js';
import { generateArticle } from './generator.js';
import { attachImages, cleanupTemp } from './images.js';
import { relatedLinksHtml } from './related.js';
import { sourceLinksHtml, placeLinksHtml } from './research.js';
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
    // --blog <id> : 자동 실행에서도 특정 블로그를 콕 집어 발행(미지정 시 기본 블로그)
    blog: get('--blog'),
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
  console.log(`🎯 슬롯: ${slot}`);

  // 2) 발행 대상 블로그 결정
  //    - 사람이 터미널에서 직접 실행(TTY) → 어느 블로그(또는 전체)에 발행할지 직접 고른다.
  //    - 자동(스케줄러·CI 는 TTY 없음) → 기본 블로그(config.tistory.defaultBlog) 한 곳만.
  //      (--blog <id> 로 특정 블로그를 지정하면 그 블로그만)
  const interactive = process.stdin.isTTY && !process.env.CI && !opts.yes;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  let targets;
  if (opts.blog) {
    const picked = getBlogs(config).find((b) => b.id === opts.blog || b.blogName === opts.blog);
    if (!picked) {
      console.log(`❓ --blog "${opts.blog}" 에 해당하는 블로그가 config.json 에 없습니다.`);
      if (rl) rl.close();
      return;
    }
    targets = [picked];
  } else if (interactive) {
    targets = await chooseBlogsInteractive(getBlogs(config), rl);
  } else {
    targets = [defaultBlog(config)];
  }

  // 3) 선택된 블로그마다 글 생성 → 발행
  let publishedCount = 0;
  try {
    for (const raw of targets) {
      const blog = resolveBlog(config, raw);
      console.log(`\n━━━━━━ 🏠 ${blog.label} (${blog.blogName}.tistory.com) ━━━━━━`);
      const published = await runForBlog({ blog, slot, now, opts, config, source, rl });
      if (published) publishedCount++;
    }
  } finally {
    if (rl) rl.close();
  }

  // 4) 변경분(state.json / topics.*.json) 한 번에 커밋·푸시
  if (publishedCount && !opts.dryRun && config.gitSync) {
    pushState(`chore: 발행 ${slotKey(slot, now)} (${source})`);
  }

  if (!opts.dryRun && !opts.noPublish) console.log('\n🎉 완료!\n');
}

/**
 * 블로그 한 곳에 대해 주제 선택 → 글 생성 → (이미지) → 발행/미리보기까지 수행한다.
 * @returns {Promise<boolean>} 실제로 발행됐으면 true (커밋 대상이 생겼는지 판단용)
 */
async function runForBlog({ blog, slot, now, opts, config, source, rl }) {
  const key = slotKey(slot, now, blog.id);

  // 중복 발행 방지 — 이 블로그·이 슬롯이 이미 발행됐으면 건너뛴다 (PC/GitHub 이중 안전망)
  if (!opts.force && !opts.dryRun && isPublished(slot, now, blog.id)) {
    console.log('✅ 이 블로그는 이 시간대에 이미 발행되었습니다. (중복 방지) 건너뜀.');
    return false;
  }

  // 주제 선택
  //   대화형: 이 블로그의 대기 주제를 보여주고 고르거나 새로 입력
  //   자동:   이 블로그의 첫 pending 주제 자동 선택
  const topicItem = rl ? await chooseTopicInteractive(blog, rl) : pickNextTopic(blog.topicsFile);
  if (!topicItem) {
    console.log(`📭 발행할 주제가 없습니다. ${blog.topicsFile} 에 주제를 추가하세요. (남은 주제: ${pendingCount(blog.topicsFile)})`);
    return false;
  }
  console.log(`📌 주제: ${topicItem.topic}`);

  // LLM으로 글 생성
  console.log(`🤖 ${config.llm.provider}(으)로 글 생성 중...`);
  const article = await generateArticle({
    topic: topicItem.topic,
    instructions: topicItem.instructions,
    config
  });
  console.log(`   제목: ${article.title}`);
  console.log(`   태그: ${article.tags.join(', ')}`);
  console.log(`   본문 길이: ${article.html.length}자`);

  // 관련 사진 삽입 (config.images.enabled && PEXELS_API_KEY 필요, 실패해도 글은 계속)
  // thumbnailPath: 대표 사진 1장을 로컬에 받아온 경로 — 발행 시 티스토리에 업로드해 썸네일로 쓴다.
  const { html: htmlWithImages, images, thumbnailPath } = await attachImages(article, config);
  article.html = htmlWithImages;
  if (images.length) console.log(`   🖼️  사진 ${images.length}장 삽입`);

  // 내부 링크(SEO): 같은 블로그의 기존 발행 글을 본문 끝에 "함께 읽으면 좋은 글"로 붙인다.
  // state.json 에 url 이 기록된 글이 있을 때만 추가된다(없으면 조용히 건너뜀).
  const related = relatedLinksHtml(blog.id, article.title, 3);
  if (related) {
    article.html += related;
    console.log('   🔗 관련 글 내부 링크 추가');
  }

  // 참고 자료 출처(웹 검색 리서치가 있었고 config.research.attachSources 가 켜진 경우)
  // 영구 URL(네이버 등)만 노출된다 — Gemini 리다이렉트는 만료되므로 링크로 걸지 않는다.
  if ((config.research?.attachSources ?? true) && article.sources?.length) {
    const sources = sourceLinksHtml(article.sources);
    if (sources) {
      article.html += sources;
      console.log('   🔎 참고 자료 출처 링크 추가');
    }
  }

  // 실존 업체 지도 링크(네이버 지역검색으로 찾은 상호에 한함) — 독자가 클릭해서 바로 찾아갈 수 있도록.
  if ((config.research?.attachSources ?? true) && article.places?.length) {
    const places = placeLinksHtml(article.places);
    if (places) {
      article.html += places;
      console.log(`   📍 위치(지도) 링크 추가 (${article.places.length}곳)`);
    }
  }

  // dry-run 이면 파일로만 저장하고 끝
  if (opts.dryRun) {
    const outDir = join(ROOT, 'output');
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `${key}.html`);
    writeFileSync(file, renderPreview(article));
    console.log(`🧪 dry-run: 미리보기 저장 → ${file} (발행은 하지 않음)`);
    cleanupTemp(thumbnailPath); // dry-run 은 업로드를 안 하므로 받아둔 임시 파일만 정리
    return false;
  }

  // 티스토리 발행
  //   --no-publish: 브라우저에 제목/본문/태그 입력까지만 하고 최종 발행은 건너뛴다(에디터 동작 확인용).
  const blogForPublish = opts.noPublish ? { ...blog, publish: false } : blog;
  console.log(opts.noPublish ? '🧪 티스토리 에디터 입력 테스트 중 (--no-publish)...' : '🚀 티스토리에 발행 중...');
  const { url } = await publishToTistory(article, config, { headful: opts.headful, blog: blogForPublish, thumbnailPath });
  cleanupTemp(thumbnailPath); // 업로드까지 끝났으니 받아둔 임시 썸네일 파일 삭제

  // --no-publish 는 상태 기록/커밋/주제 소진을 모두 건너뛴다 (반복 테스트해도 데이터가 안 망가지게).
  if (opts.noPublish) {
    console.log('🧪 --no-publish: 입력 동작만 확인하고 종료 (상태 기록·커밋·주제 소진 생략).');
    return false;
  }
  console.log(`   발행됨: ${url || '(URL 확인 불가 — 블로그 관리에서 확인하세요)'}`);

  // 상태 기록
  recordPublished({
    key,
    blog: blog.id,
    topic: topicItem.topic,
    title: article.title,
    url: url || '',
    at: new Date().toISOString(),
    source
  });
  markTopicDone(topicItem.topic, blog.topicsFile, { url });
  console.log(`📊 ${blog.label} 남은 주제: ${pendingCount(blog.topicsFile)}`);

  return true;
}

/**
 * 대화형으로 발행할 블로그를 고른다.
 *  - Enter / 1            → 기본(첫 번째) 블로그
 *  - 번호                 → 해당 블로그
 *  - 마지막 번호(전체)    → 모든 블로그에 차례로 발행
 * 반환: 선택된 블로그(원본 설정) 배열
 */
async function chooseBlogsInteractive(blogs, rl) {
  if (blogs.length === 1) return [blogs[0]];

  console.log('\n🏠 발행할 블로그를 선택하세요:');
  blogs.forEach((b, i) => {
    console.log(`   ${i + 1}) ${b.label}  (${b.blogName}.tistory.com)${i === 0 ? '   ← 기본' : ''}`);
  });
  const allChoice = blogs.length + 1;
  console.log(`   ${allChoice}) 전체 (모든 블로그에 발행)`);

  const answer = (await rl.question('\n👉 Enter=기본 / 번호=해당 블로그 / 전체 : ')).trim();
  if (answer === '') return [blogs[0]];

  const n = Number(answer);
  if (n === allChoice) return [...blogs];
  if (Number.isInteger(n) && n >= 1 && n <= blogs.length) return [blogs[n - 1]];

  console.log('   (인식하지 못한 입력 — 기본 블로그로 진행합니다)');
  return [blogs[0]];
}

/**
 * 대화형으로 해당 블로그의 주제를 선택/입력한다.
 *  - Enter        → 기본 주제(첫 번째 대기 주제)
 *  - 번호         → 해당 대기 주제
 *  - 그 외 텍스트 → 직접 입력한 임시 주제(세부 지시사항도 물어봄)
 * 반환: 주제 객체 또는 null(주제 없음·취소)
 */
async function chooseTopicInteractive(blog, rl) {
  const pending = listPendingTopics(blog.topicsFile);

  if (pending.length) {
    console.log(`\n📋 [${blog.label}] 대기 중인 주제:`);
    pending.forEach((t, i) => {
      console.log(`   ${i + 1}) ${t.topic}${i === 0 ? '   ← 기본' : ''}`);
    });
  } else {
    console.log(`\n📭 [${blog.label}] 대기 중인 주제가 없습니다. 발행할 주제를 직접 입력하세요.`);
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

  // 그 외 → 직접 입력한 임시 주제 (테스트용이므로 topics 파일에는 저장하지 않음)
  const instructions = (await rl.question(
    '   세부 지시사항(선택, Enter 로 건너뛰기): '
  )).trim();
  return { topic: answer, instructions, status: 'pending' };
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
