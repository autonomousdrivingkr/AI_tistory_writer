import { execSync } from 'node:child_process';
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
 * 발행 후 state.json / topics.json 변경분을 커밋·푸시한다.
 */
export function pushState(message) {
  try {
    run('git add state.json topics.json');
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
