import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadConfig } from '../src/config.js';

/**
 * storage_state.json 을 base64 로 인코딩해 출력한다.
 * 이 값을 GitHub 저장소 Settings > Secrets > Actions 에
 * TISTORY_STORAGE_STATE 이름으로 등록하면 클라우드(GitHub Actions)에서도 로그인된다.
 */
const config = loadConfig();
const path = join(ROOT, config.storageStatePath || 'storage_state.json');

try {
  const raw = readFileSync(path);
  const b64 = raw.toString('base64');
  console.log('\n=== 아래 한 줄 전체를 복사해서 GitHub Secret(TISTORY_STORAGE_STATE)에 붙여넣으세요 ===\n');
  console.log(b64);
  console.log('\n=== 끝 ===\n');
} catch {
  console.error(`세션 파일을 찾을 수 없습니다: ${path}`);
  console.error('먼저 "npm run login" 으로 로그인하세요.');
  process.exit(1);
}
