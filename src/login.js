import { chromium } from 'playwright';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ROOT, loadConfig } from './config.js';

/**
 * 최초 1회: 브라우저를 열어 직접 카카오/티스토리 로그인 후 세션을 저장한다.
 * 저장된 세션(storage_state.json)으로 이후 자동 발행이 가능해진다.
 */
async function main() {
  const config = loadConfig();
  const storagePath = join(ROOT, config.storageStatePath || 'storage_state.json');

  console.log('\n🔐 티스토리 로그인 세션을 저장합니다.');
  console.log('   브라우저가 열리면 평소처럼 로그인(카카오 로그인 포함)을 완료하세요.\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://www.tistory.com/auth/login');

  await waitForEnter('   로그인을 모두 마쳤으면 이 터미널에서 [Enter] 를 누르세요... ');

  await context.storageState({ path: storagePath });
  console.log(`\n✅ 세션 저장 완료: ${storagePath}`);
  console.log('   이제 "npm run dry" 로 테스트하거나 "npm run post" 로 발행할 수 있습니다.\n');

  await browser.close();
}

function waitForEnter(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

main().catch((e) => {
  console.error('로그인 중 오류:', e.message);
  // process.exit() 동기 호출은 브라우저 파이프 등 비동기 핸들 정리 중 libuv abort 를
  // 유발할 수 있습니다(UV_HANDLE_CLOSING). exitCode 만 설정해 깨끗이 종료합니다.
  process.exitCode = 1;
});
