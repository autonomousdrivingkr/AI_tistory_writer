// 내부 링크(SEO): 같은 블로그에서 이미 발행한 글들을 본문 끝에 "함께 읽으면 좋은 글"로 붙인다.
// 내부 링크는 검색엔진이 글 사이 관계를 이해하고 체류 시간을 늘리는 데 도움이 된다.
// state.json 에 url 이 기록된 글만 링크 대상이 된다(url 이 비면 링크할 곳이 없으므로 조용히 건너뜀).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

const STATE_PATH = join(ROOT, 'state.json');

/**
 * 같은 블로그의 최근 발행 글 링크 목록 HTML 을 만든다(없으면 빈 문자열).
 * @param {string} blogId        현재 발행 중인 블로그 id
 * @param {string} excludeTitle  현재 글 제목(자기 자신 제외용)
 * @param {number} limit         링크 개수(기본 3)
 * @returns {string} 본문 끝에 이어붙일 HTML (없으면 '')
 */
export function relatedLinksHtml(blogId, excludeTitle = '', limit = 3) {
  let published;
  try {
    published = JSON.parse(readFileSync(STATE_PATH, 'utf-8')).published || [];
  } catch {
    return '';
  }

  const seen = new Set();
  const picks = [];
  // 최신 글이 위로 오도록 뒤에서부터 훑는다.
  for (let i = published.length - 1; i >= 0 && picks.length < limit; i--) {
    const p = published[i];
    if (!p?.url || !p?.title) continue;            // url 없는 기록은 링크 불가
    if (p.blog !== blogId) continue;               // 같은 블로그만
    if (p.title === excludeTitle) continue;        // 자기 자신 제외
    if (seen.has(p.url)) continue;                 // 중복 url 제외
    seen.add(p.url);
    picks.push(p);
  }

  if (!picks.length) return '';

  const items = picks
    .map((p) => `<li><a href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a></li>`)
    .join('');
  return `\n<h2>함께 읽으면 좋은 글</h2>\n<ul>${items}</ul>\n`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
