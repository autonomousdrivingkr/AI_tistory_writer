// tibedra.com 은 Tistory 가 아니라 자체 제작 사이트(Next.js)라 로그인·발행 방식이 완전히 다르다.
//   - 로그인: 계정 없이 관리자 비밀번호 1개(TIBEDRA_ADMIN_PASSWORD) 로만 접근.
//   - 본문 형식: HTML 이 아니라 마크다운.
//   - 발행: "임시저장 (초안)" 과 "발행하기" 버튼이 분리돼 있고, 관리자 페이지 자체가
//     "매일 자동 생성된 초안을 검토·발행" 하는 흐름으로 설계돼 있다.
//     → 이 자동화는 항상 "임시저장 (초안)" 만 누른다. 실제 공개는 사람이 관리자 페이지에서
//       검토 후 "발행" 버튼을 눌러야 한다(사실 오류·투자 조언성 문구 등을 사람이 최종 확인).
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, localDate } from './config.js';
import { htmlToMarkdown } from './html-to-markdown.js';

const LOGS_DIR = join(ROOT, 'logs');
const BASE_URL = 'https://tibedra.com';

/**
 * tibedra 관리자 페이지에 새 글을 "초안"으로 저장한다. 발행은 절대 하지 않는다.
 * @param {{title:string, tags:string[], html:string, summary?:string}} article
 * @param {object} config
 * @param {{headful?:boolean, blog?:object, imageUrl?:string}} opts
 *        blog: config.tibedra (defaultCategory, author 등)
 *        imageUrl: 대표 이미지로 쓸 외부 이미지 URL(선택, Pexels 등)
 * @returns {Promise<{url:string|null}>}
 */
export async function publishToTibedra(article, config, opts = {}) {
  const password = process.env.TIBEDRA_ADMIN_PASSWORD;
  if (!password) {
    throw new Error(
      '.env 에 TIBEDRA_ADMIN_PASSWORD 가 없습니다. tibedra.com/admin 관리자 비밀번호를 넣으세요.'
    );
  }

  const blog = opts.blog || config.tibedra || {};
  const markdown = await htmlToMarkdown(article.html);

  const headless = !opts.headful;
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();

  try {
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('#password', password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
      page.click('button[type="submit"]')
    ]);

    if (/\/admin\/login/.test(page.url())) {
      throw new Error('tibedra 관리자 로그인 실패 — TIBEDRA_ADMIN_PASSWORD 를 확인하세요.');
    }

    await page.goto(`${BASE_URL}/admin/blog/new`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(500);

    // 이 폼은 React 가 일부 입력란에 type 속성을 실제로 붙이지 않아 input[type="text"] 선택자가
    // 안 먹는다. 대신 DOM 순서로 접근한다(2026-07-17 확인 순서):
    //   0=검색창  1=제목  2=slug  3=날짜  4=분야  5=글쓴이  6=파일첨부  7=이미지URL  8=태그
    const inputs = page.locator('input');
    await inputs.nth(1).fill(article.title);
    // slug(2)는 비워둠 → 사이트가 자동 생성
    await inputs.nth(3).fill(localDate());
    if (blog.defaultCategory) await inputs.nth(4).fill(blog.defaultCategory);
    if (blog.author) await inputs.nth(5).fill(blog.author);
    if (opts.imageUrl) await inputs.nth(7).fill(opts.imageUrl);
    await inputs.nth(8).fill((article.tags || []).join(', '));

    const textareas = page.locator('textarea');
    await textareas.nth(0).fill(article.summary || '');
    await textareas.nth(1).fill(markdown);

    // 항상 초안으로만 저장 — "발행하기" 는 절대 클릭하지 않는다.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
      page.click('button:has-text("임시저장 (초안)")')
    ]);
    await page.waitForTimeout(1000);

    const url = await findDraftUrl(page, article.title);
    await browser.close();
    return { url };
  } catch (err) {
    await dumpFailure(page, err);
    await browser.close();
    throw err;
  }
}

/** 방금 저장한 초안의 편집 링크에서 slug 를 뽑아 공개 URL(발행 전이라 아직 비공개) 형태로 돌려준다. */
async function findDraftUrl(page, title) {
  try {
    await page.goto(`${BASE_URL}/admin/blog`, { waitUntil: 'networkidle', timeout: 20000 });
    const row = page.locator('li, tr, div').filter({ hasText: title }).last();
    const editLink = row.locator('a[href*="/admin/blog/"][href*="/edit"]').first();
    const href = await editLink.getAttribute('href', { timeout: 5000 }).catch(() => null);
    if (!href) return null;
    const slug = href.match(/\/admin\/blog\/([^/]+)\/edit/)?.[1];
    return slug ? `${BASE_URL}/blog/${slug}` : null;
  } catch {
    return null;
  }
}

async function dumpFailure(page, err) {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const shot = join(LOGS_DIR, `tibedra-fail-${ts}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.error(`💥 tibedra 초안 저장 실패. 스크린샷: ${shot}`);
    console.error(`   원인: ${err.message}`);
  } catch {
    // 스크린샷 실패는 무시
  }
}
