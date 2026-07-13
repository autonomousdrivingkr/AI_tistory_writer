import { execSync, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ROOT } from './config.js';

function run(cmd) {
  return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

/**
 * 실행 전 최신 상태 받아오기 (PC ↔ GitHub 간 state.json 동기화).
 * 실패해도 본 작업은 계속 진행한다(best-effort).
 */
export function pullLatest() {
  try {
    run('git pull --rebase --autostash');
    console.log('🔄 git pull 완료 (최신 상태 동기화)');
  } catch (e) {
    console.warn('⚠️  git pull 실패(무시하고 진행):', firstLine(e));
  }
}

/**
 * 발행 후 state.json / topics.*.json(블로그별 주제 파일) 변경분을 커밋·푸시한다.
 */
export function pushState(message) {
  try {
    run('git add state.json topics.*.json');
    // 변경사항이 없으면 커밋 생략
    try {
      run('git diff --staged --quiet');
      console.log('ℹ️  변경된 상태 없음 — 푸시 생략');
      return;
    } catch {
      // diff 있음 → 커밋 진행
    }
    run(`git commit -m "${message} [skip ci]"`);
    run('git push');
    console.log('⬆️  상태 커밋·푸시 완료');
  } catch (e) {
    console.warn('⚠️  git push 실패(무시):', firstLine(e));
  }
}

function firstLine(e) {
  return String(e.stderr || e.message || e).split('\n')[0];
}

/**
 * (best-effort) 새로 로그인해 저장한 세션을 GitHub Actions 시크릿(TISTORY_STORAGE_STATE)에도
 * 동기화한다. 로컬 PC가 자동 재로그인으로 세션을 새로 저장할 때마다 실행되며,
 * 이 PC의 세션이 클라우드 백업 워크플로우까지 늘 최신 상태를 쓰게 해준다.
 * gh CLI 가 없거나 로그인 안 돼 있으면 조용히 건너뛴다(발행 자체를 막지 않는다).
 */
export function syncSessionSecret(storagePath) {
  try {
    const origin = run('git config --get remote.origin.url');
    const m = origin.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (!m) return;
    const repo = `${m[1]}/${m[2]}`;

    const b64 = readFileSync(storagePath).toString('base64');
    execFileSync('gh', ['secret', 'set', 'TISTORY_STORAGE_STATE', '--repo', repo], {
      cwd: ROOT,
      input: b64,
      stdio: ['pipe', 'ignore', 'ignore']
    });
    console.log('🔁 새 세션을 GitHub Secret(TISTORY_STORAGE_STATE)에도 동기화했습니다.');
  } catch {
    // gh 미설치·미인증 등은 부가 기능 실패일 뿐이므로 조용히 넘어간다.
  }
}
