import { chromium } from 'playwright';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ROOT, loadConfig } from './config.js';
import { KAKAO_EMAIL, KAKAO_PASSWORD, autoFillKakao } from './kakao-auth.js';

/**
 * 최초 1회: 브라우저를 열어 카카오/티스토리 로그인 후 세션을 저장한다.
 * .env 에 KAKAO_EMAIL/KAKAO_PASSWORD 가 있으면 아이디·비번을 자동으로 채워준다.
 * (캡차·2단계 인증은 카카오가 막으므로 사람이 처리한 뒤 Enter)
 * 저장된 세션(storage_state.json)으로 이후 자동 발행이 가능해진다.
 */
async function main() {
  const config = loadConfig();
  const storagePath = join(ROOT, config.storageStatePath || 'storage_state.json');

  console.log('\n🔐 티스토리 로그인 세션을 저장합니다.');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://www.tistory.com/auth/login');

  if (KAKAO_EMAIL && KAKAO_PASSWORD) {
    const filled = await autoFillKakao(page);
    if (filled) {
      console.log('\n   ✓ 카카오 아이디/비밀번호를 자동 입력했습니다.');
      console.log('   ⚠️  보안문자(캡차)·2단계 인증·새 기기 확인이 뜨면 직접 처리하세요.');
      console.log('       모두 끝나 글쓰기/메인 화면이 보이면 Enter 를 누르세요.\n');
    } else {
      console.warn('\n   ⚠️ 자동 입력에 실패했습니다 — 브라우저에서 수동으로 로그인하세요.\n');
    }
  } else {
    console.log('   브라우저가 열리면 평소처럼 카카오 로그인을 완료하세요.');
    console.log('   (.env 에 KAKAO_EMAIL/KAKAO_PASSWORD 를 넣으면 다음부턴 자동 입력됩니다.)\n');
  }

  // Enter 입력 또는 로그인 완료(티스토리 세션 쿠키 생성) 중 먼저 오는 쪽을 기다린다.
  // 터미널이 Enter 를 못 받는 환경(스케줄러 등)에서도 로그인만 마치면 자동 저장된다.
  const abort = { done: false };
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const enterPromise = new Promise((resolve) =>
    rl.question('   로그인을 모두 마쳤으면 이 터미널에서 [Enter] 를 누르세요... ', () => resolve('enter'))
  );
  const how = await Promise.race([enterPromise, waitForLogin(context, abort)]);
  abort.done = true;
  rl.close();

  if (how === 'auto') {
    console.log('\n   ✓ 로그인 완료를 자동 감지했습니다.');
    await new Promise((r) => setTimeout(r, 2000)); // 쿠키가 모두 기록될 시간
  }

  await context.storageState({ path: storagePath });
  console.log(`\n✅ 세션 저장 완료: ${storagePath}`);
  console.log('   이제 "npm run dry" 로 테스트하거나 "npm run post" 로 발행할 수 있습니다.\n');

  await browser.close();
}

/** 티스토리 세션 쿠키(TSSESSION)가 생길 때까지 3초 간격으로 확인한다(Enter 입력과 경쟁). */
async function waitForLogin(context, abort) {
  while (!abort.done) {
    const cookies = await context.cookies('https://www.tistory.com').catch(() => []);
    if (cookies.some((c) => /TSSESSION/i.test(c.name))) return 'auto';
    await new Promise((r) => setTimeout(r, 3000));
  }
  return 'enter';
}

main().catch((e) => {
  console.error('로그인 중 오류:', e.message);
  // process.exit() 동기 호출은 브라우저 파이프 등 비동기 핸들 정리 중 libuv abort 를
  // 유발할 수 있습니다(UV_HANDLE_CLOSING). exitCode 만 설정해 깨끗이 종료합니다.
  process.exitCode = 1;
});
