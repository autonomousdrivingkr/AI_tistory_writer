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

async function dismissDraftDialog(page, sel) {
  // 네이티브 confirm 대화상자 자동 취소
  page.once('dialog', (d) => d.dismiss().catch(() => {}));
  try {
    const cancel = page.getByRole('button', { name: sel.draftCancelText });
    await cancel.click({ timeout: 3000 });
  } catch {
    // 팝업이 없으면 무시
  }
}

async function switchToHtmlMode(page, sel) {
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
  // 모드 전환 확인 팝업이 뜨면 수락
  page.once('dialog', (d) => d.accept().catch(() => {}));
  await page.waitForTimeout(800);
}

async function typeHtmlBody(page, sel, html) {
  // CodeMirror(HTML 모드) 우선
  const cm = page.locator(sel.codeMirror).first();
  if (await cm.count()) {
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
