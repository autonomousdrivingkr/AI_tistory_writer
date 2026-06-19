import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

const LOGS_DIR = join(ROOT, 'logs');

/**
 * 티스토리 새 글 작성 페이지에서 글을 발행한다.
 * 셀렉터는 config.selectors 로 조정 가능하며, 버튼은 텍스트 기반으로도 시도한다.
 *
 * @param {{title:string, tags:string[], html:string}} article
 * @param {object} config
 * @param {{headful?:boolean}} opts
 * @returns {Promise<{url:string|null}>}
 */
export async function publishToTistory(article, config, opts = {}) {
  const storagePath = join(ROOT, config.storageStatePath || 'storage_state.json');
  if (!existsSync(storagePath)) {
    throw new Error(
      `로그인 세션 파일이 없습니다: ${storagePath}\n먼저 "npm run login" 으로 로그인하세요.`
    );
  }

  const blogName = config.tistory.blogName;
  if (!blogName || blogName.includes('여기에')) {
    throw new Error('config.json 의 tistory.blogName 을 실제 블로그 주소로 바꾸세요.');
  }

  const sel = config.selectors;
  const headless = !opts.headful;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ storageState: storagePath });
  const page = await context.newPage();

  try {
    const url = `https://${blogName}.tistory.com/manage/newpost/`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // 세션이 만료되면 글쓰기 페이지 대신 로그인 화면(카카오 로그인)으로 튕긴다.
    // 이 경우 제목 셀렉터를 20초 기다리다 의미 불명한 타임아웃으로 끝나므로,
    // 여기서 먼저 감지해 무엇을 해야 하는지 분명한 에러로 빠르게 실패시킨다.
    await ensureLoggedIn(page);

    // "작성 중인 글이 있습니다" 같은 임시저장 팝업이 뜨면 닫는다(새 글로 시작).
    await dismissDraftDialog(page, sel);

    // 1) 제목 입력
    const title = page.locator(sel.titleInput).first();
    await title.waitFor({ state: 'visible', timeout: 20000 });
    await title.click();
    await title.fill(article.title);

    // 2) HTML 모드로 전환 후 본문 입력
    await switchToHtmlMode(page, sel);
    await typeHtmlBody(page, sel, article.html);

    // 3) 태그 입력
    await fillTags(page, sel, article.tags || []);

    // 4) 발행
    const postUrl = await publish(page, sel, config);

    await context.close();
    await browser.close();
    return { url: postUrl };
  } catch (err) {
    await dumpFailure(page, err);
    await context.close();
    await browser.close();
    throw err;
  }
}

async function ensureLoggedIn(page) {
  // 1) URL 기준: 글쓰기 페이지가 아니라 티스토리/카카오 로그인 페이지로 리다이렉트됐는가?
  const cur = page.url();
  const onLoginUrl = /\/auth\/login|accounts\.kakao\.com|kauth\.kakao\.com/.test(cur);

  // 2) 화면 기준: "카카오계정으로 로그인" 버튼/문구가 보이는가? (URL 이 모호한 경우 대비)
  const kakaoBtn = page.getByText('카카오계정으로 로그인', { exact: false });
  const onLoginScreen = await kakaoBtn.first().isVisible({ timeout: 2000 }).catch(() => false);

  if (onLoginUrl || onLoginScreen) {
    throw new Error(
      '티스토리 로그인 세션이 만료되었습니다 (로그인 화면으로 리다이렉트됨).\n' +
      '  → 해결: "npm run login" 을 실행해 카카오 로그인을 다시 마치고 세션을 새로 저장하세요.\n' +
      '  → GitHub Actions 도 쓴다면 "npm run export-session" 결과로 TISTORY_STORAGE_STATE 시크릿도 갱신하세요.'
    );
  }
}

async function dismissDraftDialog(page, sel) {
  // 임시저장 복구 confirm 은 취소(=새 글로 시작). 핸들러는 이 함수 안에서만 살아있도록
  // on/off 로 스코프를 잡는다. once 로 남겨두면 이후 HTML 모드 confirm 을 잡아먹어 취소시킨다.
  const dismissDialog = (d) => d.dismiss().catch(() => {});
  page.on('dialog', dismissDialog);
  try {
    const cancel = page.getByRole('button', { name: sel.draftCancelText });
    await cancel.click({ timeout: 3000 });
  } catch {
    // 팝업이 없으면 무시
  } finally {
    page.off('dialog', dismissDialog);
  }
}

async function switchToHtmlMode(page, sel) {
  // 티스토리는 HTML 모드로 바꿀 때 native confirm("HTML모드로 변경 …")을 띄운다.
  // 이 confirm 을 반드시 accept 해야 실제로 전환된다. 핸들러가 없거나 늦게 등록되면
  // Playwright 가 자동 dismiss(취소) → 전환 실패 → CodeMirror 가 숨겨진 채로 남는다.
  // 그래서 클릭 *전에* accept 핸들러를 등록한다.
  const acceptDialog = (d) => d.accept().catch(() => {});
  page.on('dialog', acceptDialog);
  try {
    await page.locator(sel.modeButton).first().click({ timeout: 8000 });
    await page.locator(sel.modeHtml).first().click({ timeout: 5000 });
  } catch {
    // 텍스트 기반 폴백
    try {
      await page.getByRole('button', { name: /기본모드|모드/ }).first().click({ timeout: 5000 });
      await page.getByText('HTML', { exact: true }).first().click({ timeout: 5000 });
    } catch {
      console.warn('⚠️  HTML 모드 전환 실패 — 기본 에디터에 입력합니다. 셀렉터 조정이 필요할 수 있습니다.');
    }
  }
  // CodeMirror(HTML 에디터)가 실제로 보일 때까지 대기 → 전환 완료를 직접 확인한다.
  try {
    await page.locator(sel.codeMirror).first().waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    console.warn('⚠️  HTML 에디터가 보이지 않습니다 — 모드 전환이 안 됐을 수 있습니다.');
  } finally {
    page.off('dialog', acceptDialog);
  }
}

async function typeHtmlBody(page, sel, html) {
  // CodeMirror(HTML 모드) 우선
  const cm = page.locator(sel.codeMirror).first();
  if (await cm.count() && await cm.isVisible().catch(() => false)) {
    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.insertText(html);
    return;
  }
  // 폴백: 본문 영역에 직접 입력
  const body = page.locator('.tox-edit-area iframe, [contenteditable="true"]').first();
  await body.click();
  await page.keyboard.insertText(html);
}

async function fillTags(page, sel, tags) {
  if (!tags.length) return;
  try {
    const input = page.locator(sel.tagInput).first();
    await input.waitFor({ state: 'visible', timeout: 5000 });
    for (const tag of tags) {
      await input.click();
      await input.type(tag);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
    }
  } catch {
    console.warn('⚠️  태그 입력 실패 — 태그 없이 진행합니다.');
  }
}

async function publish(page, sel, config) {
  if (!config.tistory.publish) {
    console.log('ℹ️  config.tistory.publish=false → 발행하지 않고 임시 상태로 둡니다.');
    return null;
  }

  // 발행 패널 열기 ("완료" 또는 "발행")
  try {
    await page.getByRole('button', { name: new RegExp(sel.publishOpenText + '|발행') }).first().click({ timeout: 8000 });
  } catch {
    await page.locator('#publish-layer-btn').first().click({ timeout: 8000 }).catch(() => {});
  }
  await page.waitForTimeout(800);

  // 공개/비공개 옵션 (config: public/private)
  if (config.tistory.publishVisibility === 'public') {
    await page.getByText('공개', { exact: true }).first().click({ timeout: 3000 }).catch(() => {});
  }

  // 최종 발행 버튼
  await page.getByRole('button', { name: new RegExp(sel.publishConfirmText + '|발행') }).last().click({ timeout: 8000 });

  // 발행 후 글 페이지로 이동하길 잠시 대기
  await page.waitForTimeout(4000);
  const finalUrl = page.url();
  return finalUrl.includes('/manage/') ? null : finalUrl;
}

async function dumpFailure(page, err) {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const shot = join(LOGS_DIR, `fail-${ts}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.error(`💥 발행 실패. 스크린샷: ${shot}`);
    console.error(`   원인: ${err.message}`);
  } catch {
    // 스크린샷 실패는 무시
  }
}
