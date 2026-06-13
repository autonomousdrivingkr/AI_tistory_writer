import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** config.json 을 읽어서 반환 */
export function loadConfig() {
  const raw = readFileSync(join(ROOT, 'config.json'), 'utf-8');
  return JSON.parse(raw);
}

/** 실행 환경 구분: GitHub Actions 면 'github', 아니면 'pc' */
export function runSource() {
  return process.env.GITHUB_ACTIONS === 'true' ? 'github' : 'pc';
}

/** 로컬 기준 YYYY-MM-DD 날짜 문자열 */
export function localDate(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
