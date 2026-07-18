import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, getBlogs, resolveBlog } from './config.js';
import { KAKAO_EMAIL, KAKAO_PASSWORD, autoFillKakao, waitForSessionCookie } from './kakao-auth.js';
import { syncSessionSecret } from './git-sync.js';

const LOGS_DIR = join(ROOT, 'logs');

/**
 * 티스토리 새 글 작성 페이지에서 글을 발행한다.
 * 셀렉터는 config.selectors 로 조정 가능하며, 버튼은 텍스트 기반으로도 시도한다.
 *
 * @param {{title:string, tags:string[], html:string}} article
 * @param {object} config
 * @param {{headful?:boolean, blog?:object, thumbnailPath?:string}} opts
 *        blog: resolveBlog() 로 합쳐진 블로그 설정
 *        thumbnailPath: 티스토리에 올려 대표이미지(썸네일)로 쓸 로컬 이미지 경로(선택)
 * @returns {Promise<{url:string|null}>}
 */
export async function publishToTistory(article, config, opts = {}) {
  // 호출부가 블로그를 지정하지 않으면 첫 번째(기본) 블로그로 발행한다.
  const blog = opts.blog || resolveBlog(config, getBlogs(config)[0]);

  const storagePath = join(ROOT, blog.storageStatePath || 'storage_state.json');
  if (!existsSync(storagePath)) {
    throw new Error(
      `로그인 세션 파일이 없습니다: ${storagePath}\n먼저 "npm run login" 으로 로그인하세요.`
    );
  }

  const blogName = blog.blogName;
  if (!blogName || blogName.includes('여기에')) {
    throw new Error('config.json 의 blogs[].blogName 을 실제 블로그 주소로 바꾸세요.');
  }

  const sel = config.selectors;
  const headless = !opts.headful;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ storageState: storagePath });
  const page = await context.newPage();
  // 조용히 버퍼링만 해두고, 발행이 안 끝나고 멈췄을 때(dumpPublishStuck)만 출력한다
  // (매 실행마다 콘솔에 쏟아내면 정상 케이스에서 노이즈만 커진다).
  const consoleErrors = [];
  const postRequests = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('response', (res) => {
    if (res.request().method() !== 'GET') postRequests.push(`${res.request().method()} ${res.status()} ${res.url()}`);
  });

  try {
    const url = `https://${blogName}.tistory.com/manage/newpost/`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // 세션이 만료되면 글쓰기 페이지 대신 로그인 화면(카카오 로그인)으로 튕긴다.
    // 이 경우 제목 셀렉터를 20초 기다리다 의미 불명한 타임아웃으로 끝나므로,
    // 여기서 먼저 감지해 자동 재로그인을 시도하고, 그래도 안 되면 분명한 에러로 빠르게 실패시킨다.
    await ensureLoggedIn(page, { context, storagePath, url });

    // "작성 중인 글이 있습니다" 같은 임시저장 팝업이 뜨면 닫는다(새 글로 시작).
    await dismissDraftDialog(page, sel);

    // 1) 제목 입력
    const title = page.locator(sel.titleInput).first();
    await title.waitFor({ state: 'visible', timeout: 20000 });
    await title.click();
    await title.fill(article.title);

    // 1.5) 대표 이미지 업로드 (썸네일용)
    //   HTML 모드로 바꾸기 *전*(기본 에디터)에서 올려야 업로드가 동작한다.
    //   업로드된 이미지는 HTML 모드 전환 시 [##_Image|…##] 매크로로 소스에 남고,
    //   typeHtmlBody 가 이를 본문 맨 앞에 보존한다. → 티스토리가 대표이미지로 잡음.
    if (opts.thumbnailPath) {
      await uploadRepresentativeImage(page, sel, opts.thumbnailPath);
    }

    // 2) HTML 모드로 전환 후 본문 입력
    await switchToHtmlMode(page, sel);
    const preservedSource = await typeHtmlBody(page, sel, article.html);

    // 2.5) 대표 이미지가 실제로 티스토리 소스(매크로)로 반영됐는지 확인.
    //   업로드가 에디터에 안 붙으면 조용히 썸네일만 사라지므로, 매 발행마다 명확히 로그로 남긴다.
    if (opts.thumbnailPath) verifyThumbnailMacro(preservedSource);

    // 2.6) HTML 모드 입력을 실제 발행 문서(기본모드/WYSIWYG)에 반영.
    //   티스토리는 HTML 모드의 CodeMirror 를 소스 "보기/편집" 뷰로만 쓰고, 실제 발행은
    //   기본모드 문서 기준이다. 이 전환 없이 바로 발행하면 HTML 모드에서 입력한 본문이
    //   통째로 사라지고 직전 기본모드 상태(대표이미지만)로 발행된다 — 실사고로 확인됨.
    await applyHtmlToVisualMode(page, sel);
    await verifyBodyApplied(page, article.html);

    // 3) 태그 입력
    await fillTags(page, sel, article.tags || []);

    // 4) 발행
    const postUrl = await publish(page, sel, blog, { consoleErrors, postRequests });

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

/** 글쓰기 페이지가 아니라 티스토리/카카오 로그인 화면에 있는지 판별한다. */
async function isOnLoginScreen(page) {
  const cur = page.url();
  if (/\/auth\/login|accounts\.kakao\.com|kauth\.kakao\.com/.test(cur)) return true;
  const kakaoBtn = page.getByText('카카오계정으로 로그인', { exact: false });
  return kakaoBtn.first().isVisible({ timeout: 2000 }).catch(() => false);
}

/**
 * 세션이 만료돼 로그인 화면으로 튕겼으면, .env 의 카카오 자격증명으로 자동 재로그인을
 * 한 번 시도한다(사람 개입 없이). 성공하면 세션을 새로 저장하고(+ 가능하면 GitHub Secret도
 * 동기화) 글쓰기 페이지로 다시 이동해 발행을 이어간다. 실패하면(자격증명 없음·캡차 등)
 * 무엇을 해야 하는지 분명한 에러로 빠르게 실패시킨다.
 */
async function ensureLoggedIn(page, { context, storagePath, url }) {
  if (!(await isOnLoginScreen(page))) return;

  if (!KAKAO_EMAIL || !KAKAO_PASSWORD) {
    throw new Error(
      '티스토리 로그인 세션이 만료되었습니다 (로그인 화면으로 리다이렉트됨).\n' +
      '  → .env 에 KAKAO_EMAIL/KAKAO_PASSWORD 가 없어 자동 재로그인을 시도할 수 없습니다.\n' +
      '  → 해결: "npm run login" 을 실행해 카카오 로그인을 다시 마치고 세션을 새로 저장하세요.'
    );
  }

  console.warn('⚠️  세션이 만료된 것 같습니다 — .env 자격증명으로 자동 재로그인을 시도합니다...');

  // 깨끗한 로그인 흐름으로 다시 시작한다(튕겨나온 페이지에서 이어 하는 것보다 안정적).
  await retryGoto(page, 'https://www.tistory.com/auth/login');
  await autoFillKakao(page);
  const ok = await waitForSessionCookie(context, 30000);

  if (!ok) {
    throw new Error(
      '티스토리 로그인 세션이 만료되었고, 자동 재로그인도 실패했습니다\n' +
      '  (보안문자·2단계 인증·새 기기 확인 등으로 막혔을 수 있습니다).\n' +
      '  → 해결: "npm run login" 으로 직접 로그인해 세션을 새로 저장하세요.\n' +
      '  → GitHub Actions 도 쓴다면 "npm run export-session" 결과로 TISTORY_STORAGE_STATE 시크릿도 갱신하세요.'
    );
  }

  // TSSESSION 쿠키가 생겨도, 카카오가 "로그인 상태 유지/계속하기" 인터스티셜을 띄워 로그인 흐름이
  // 끝까지 안 끝난 상태일 수 있다(특히 클라우드의 새 IP). 그러면 글쓰기 페이지가 다시 로그인으로 튕긴다.
  // → 인터스티셜을 닫고, 글쓰기 페이지 접근을 여러 번 재시도해 세션 전파(느릴 수 있음)를 기다린다.
  //   실제로 에디터에 도달한 뒤에만 "성공"으로 보고 세션을 저장한다.
  await dismissKakaoInterstitial(page);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  let reached = false;
  for (let attempt = 1; attempt <= 4 && !reached; attempt++) {
    await retryGoto(page, url);
    if (!(await isOnLoginScreen(page))) {
      reached = true;
      break;
    }
    // 아직 로그인 화면이면: 인터스티셜을 다시 닫아보고 잠시 기다린 뒤 재시도.
    await dismissKakaoInterstitial(page);
    await new Promise((r) => setTimeout(r, 2500));
  }

  if (!reached) {
    throw new Error(
      '자동 재로그인은 됐지만 글쓰기 페이지 접근에 실패했습니다\n' +
      '  (카카오 로그인 후 추가 확인 단계가 남아있을 수 있습니다).\n' +
      '  → 해결: "npm run login" 으로 직접 로그인해 세션을 새로 저장하세요.'
    );
  }

  console.log('   ✓ 자동 재로그인 성공 — 세션을 새로 저장하고 발행을 계속합니다.');
  await context.storageState({ path: storagePath });
  if (!process.env.CI) syncSessionSecret(storagePath);
}

/** ERR_ABORTED 등 일시적 네비게이션 충돌을 한 번 재시도한다. */
async function retryGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch {
    await new Promise((r) => setTimeout(r, 1500));
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
}

/**
 * 카카오 로그인 완료 후 남는 확인 인터스티셜("계속하기"/"로그인 상태 유지"/"확인" 등)이 있으면
 * 눌러 로그인 흐름을 끝까지 완료시킨다(best-effort). 이 함수는 로그인/카카오 화면에서만 호출된다.
 */
async function dismissKakaoInterstitial(page) {
  const labels = /계속하기|계속|로그인 상태 유지|유지하기|유지|확인|다음|예/;
  try {
    const btn = page
      .getByRole('button', { name: labels })
      .or(page.getByRole('link', { name: labels }));
    if (await btn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
  } catch {
    // 인터스티셜이 없으면 무시
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

/**
 * 대표 이미지를 티스토리 서버에 업로드한다 (기본 에디터 모드에서 호출).
 * 외부 링크(Pexels) 사진만 있으면 티스토리가 썸네일을 못 만들기 때문에, 1장을 실제로 올린다.
 * 부가 기능이므로 실패해도 발행은 막지 않는다(썸네일만 없을 뿐).
 */
async function uploadRepresentativeImage(page, sel, imagePath) {
  try {
    // 새 에디터(TinyMCE)에는 상시 존재하는 파일 input 이 없다.
    // "첨부" 메뉴 → "사진" 을 클릭해야 파일 선택창이 열리므로,
    // 클릭 *전에* filechooser 대기를 걸어두고 열리는 선택창에 바로 파일을 넣는다.
    // 툴바(TinyMCE)는 제목 입력창보다 늦게 렌더링될 수 있어 보일 때까지 기다린다.
    // 같은 aria-label 의 숨은 복제 요소가 있으므로 반드시 :visible 로 골라야 한다.
    const attach = page.locator(sel.attachButton || '[aria-label="첨부"]:visible').first();
    const hasAttach = await attach
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true, () => false);
    if (hasAttach) {
      const chooser = page.waitForEvent('filechooser', { timeout: 8000 });
      await attach.click({ timeout: 3000 });
      await page.locator(sel.attachImageItem || '#attach-image:visible').first().click({ timeout: 3000 });
      await (await chooser).setFiles(imagePath);
    } else {
      // 구 에디터 폴백: 페이지에 이미 있는 파일 input 에 직접 넣는다.
      // .first() 로 아무거나 잡으면 이미지가 아닌 input(동영상/파일)에 들어가 업로드가 무시되므로
      // accept 에 image 가 들어간 input 을 우선 고른다.
      const preferImage = 'input[type="file"][accept*="image" i]';
      let input = page.locator(preferImage).first();

      if (!(await input.count())) {
        const inputSel = sel.imageFileInput || 'input[type="file"]';
        if (!(await page.locator(inputSel).count()) && sel.imageButton) {
          await page.locator(sel.imageButton).first().click({ timeout: 3000 }).catch(() => {});
        }
        input = (await page.locator(preferImage).count())
          ? page.locator(preferImage).first()
          : page.locator(inputSel).first();
      }

      // 숨은 input 이라도 setInputFiles 는 동작한다(보임 상태가 아니라 attached 만 기다린다).
      await input.waitFor({ state: 'attached', timeout: 5000 });
      await input.setInputFiles(imagePath);
    }

    // 업로드 완료 = 에디터 본문에 카카오 CDN 이미지가 나타나는 것. 고정 대기 대신 이를 기다린다.
    await waitForUploadedImage(page);
    console.log('   🖼️  대표 이미지 업로드 시도 완료 — HTML 소스에서 매크로 반영 여부를 재확인합니다.');
    return true;
  } catch (e) {
    console.warn(`⚠️  대표 이미지 업로드 실패 — 썸네일 없이 진행합니다. (${e.message})`);
    return false;
  }
}

/**
 * 업로드한 이미지가 에디터 본문(iframe 포함)에 카카오 CDN 주소로 나타날 때까지 대기.
 * 시간 안에 안 나타나도 발행은 계속한다 — 최종 판정은 verifyThumbnailMacro 가 한다.
 */
async function waitForUploadedImage(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const n = await frame.locator('img[src*="kakaocdn"], img[src*="daumcdn"]').count().catch(() => 0);
      if (n) {
        await page.waitForTimeout(1000); // 에디터가 매크로를 소스에 반영할 시간
        return;
      }
    }
    await page.waitForTimeout(500);
  }
  console.warn('   ⚠️  업로드된 이미지가 에디터에 나타나지 않았습니다 (15초 초과).');
}

/**
 * 대표 이미지가 티스토리 본문 소스에 실제로 반영됐는지 확인해 로그로 남긴다.
 * 기본 에디터에서 업로드가 성공하면 HTML 소스에 [##_Image|…##] 매크로(또는 kakaocdn 이미지)가 남는다.
 * 이게 있어야만 티스토리가 목록 썸네일/og:image 를 잡는다 — 썸네일 성공의 유일한 근거다.
 */
function verifyThumbnailMacro(preservedSource) {
  const hasMacro = /\[##_Image\||kakaocdn|daumcdn/i.test(preservedSource || '');
  if (hasMacro) {
    console.log('   ✅ 대표 이미지가 본문 소스에 반영됨 — 티스토리가 목록 썸네일/og:image 로 잡습니다.');
  } else {
    console.warn(
      '   ⚠️  대표 이미지가 본문 소스(HTML)에 없습니다 — 업로드가 에디터에 반영되지 않았습니다.\n' +
      '      → 이대로면 썸네일이 안 잡힙니다. selectors.imageFileInput / imageButton 을 점검하세요.'
    );
  }
}

/**
 * 본문 HTML 을 에디터에 입력한다.
 * @returns {Promise<string>} 입력 전 소스에 이미 있던 내용(=업로드된 대표 이미지 매크로). 썸네일 검증용.
 */
async function typeHtmlBody(page, sel, html) {
  // CodeMirror(HTML 모드) 우선
  const cm = page.locator(sel.codeMirror).first();
  if (await cm.count() && await cm.isVisible().catch(() => false)) {
    // 기본 에디터에서 올린 대표 이미지는 HTML 소스에 [##_Image|…##] 매크로로 들어와 있다.
    // Ctrl+A/Delete 로 지우면 이미지가 사라져 썸네일도 없어지므로, 먼저 읽어 본문 맨 앞에 보존한다.
    const existing = await cm.evaluate((el) => (el.CodeMirror ? el.CodeMirror.getValue() : '')).catch(() => '');
    const merged = existing.trim() ? existing.trim() + '\n' + html : html;
    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.insertText(merged);
    return existing.trim();
  }
  // 폴백: 본문 영역에 직접 입력
  const body = page.locator('.tox-edit-area iframe, [contenteditable="true"]').first();
  await body.click();
  await page.keyboard.insertText(html);
  return '';
}

/**
 * HTML 소스 모드(CodeMirror)에서 편집한 내용을 기본모드(WYSIWYG)로 되돌려 실제 발행
 * 문서에 반영한다. "HTML" 드롭다운(HTML 모드일 때 툴바에 나타남) → "기본모드" 순서로 클릭.
 * 모드 전환 confirm(native dialog)이 뜨므로 accept 핸들러를 걸어둔다.
 */
async function applyHtmlToVisualMode(page, sel) {
  const acceptDialog = (d) => d.accept().catch(() => {});
  page.on('dialog', acceptDialog);
  try {
    await page.getByRole('button', { name: /^HTML/ }).first().click({ timeout: 5000 });
    await page.locator(sel.modeVisualItem || '#editor-mode-kakao-tistory:visible').first().click({ timeout: 5000 });
    // 기본모드 에디터(iframe/contenteditable)가 실제로 다시 보일 때까지 대기 → 전환 완료 확인.
    await page.locator('.tox-edit-area iframe, iframe, [contenteditable="true"]').first().waitFor({ state: 'visible', timeout: 8000 });
  } catch (e) {
    console.warn(`⚠️  기본모드 복귀 실패 — HTML 로 입력한 본문이 발행에 반영되지 않을 수 있습니다. (${e.message})`);
  } finally {
    page.off('dialog', acceptDialog);
  }
}

/**
 * 기본모드로 돌아온 뒤 에디터에 실제로 본문 텍스트가 반영됐는지 확인해 로그로 남긴다.
 * (2026-07-11 사고: 이 확인이 없어 본문이 통째로 빠진 채 발행된 걸 뒤늦게 알아챔.)
 * 원본 글자 수의 절반에도 못 미치면 반영 실패로 보고 명확히 경고한다.
 */
async function verifyBodyApplied(page, expectedHtml) {
  const visibleLength = await page.evaluate(() => {
    const iframe = document.querySelector('.tox-edit-area iframe, iframe');
    if (iframe && iframe.contentDocument) return iframe.contentDocument.body?.innerText?.length || 0;
    const ce = document.querySelector('[contenteditable="true"]');
    return ce ? ce.innerText.length : 0;
  }).catch(() => 0);

  const expectedTextLength = String(expectedHtml || '').replace(/<[^>]+>/g, '').length;
  if (expectedTextLength && visibleLength < expectedTextLength * 0.5) {
    console.warn(
      `   ⚠️  본문 반영 확인 실패 — 에디터에 보이는 글자 수(${visibleLength})가 원본(약 ${expectedTextLength}자)보다 훨씬 적습니다.\n` +
      '      → 이대로 발행하면 본문이 비어있을 수 있습니다. --headful --no-publish 로 직접 확인하세요.'
    );
  } else {
    console.log(`   ✅ 본문이 에디터에 정상 반영됨 (${visibleLength}자 확인).`);
  }
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

async function publish(page, sel, blog, diag = {}) {
  if (!blog.publish) {
    console.log('ℹ️  publish=false → 발행하지 않고 임시 상태로 둡니다.');
    return null;
  }

  // 발행 패널 열기 ("완료" 또는 "발행")
  try {
    await page.getByRole('button', { name: new RegExp(sel.publishOpenText + '|발행') }).first().click({ timeout: 8000 });
  } catch {
    await page.locator('#publish-layer-btn').first().click({ timeout: 8000 }).catch(() => {});
  }
  await page.waitForTimeout(800);

  // 공개/비공개 옵션 (blog: public/private)
  if (blog.publishVisibility === 'public') {
    await page.getByText('공개', { exact: true }).first().click({ timeout: 3000 }).catch(() => {});
  }

  // 최종 발행 버튼
  await page.getByRole('button', { name: new RegExp(sel.publishConfirmText + '|발행') }).last().click({ timeout: 8000 });

  // 발행이 끝나면 글 본문 페이지(.../<글번호> 또는 .../entry/...)로 이동한다.
  // 그 이동을 명시적으로 기다려야 실제 글 URL 을 잡을 수 있다(내부 링크·state 기록용).
  // 기다리지 못하면(셀렉터/리다이렉트 변화 등) 기존처럼 폴백한다.
  const postUrlRe = new RegExp(`${blog.blogName}\\.tistory\\.com/(?:entry/|\\d)`, 'i');
  try {
    await page.waitForURL(postUrlRe, { timeout: 20000 });
  } catch {
    await page.waitForTimeout(8000);
  }
  const finalUrl = page.url();
  // 관리 화면(/manage/)에 머물러 있으면 실제 글 URL 을 못 잡은 것 → null.
  if (!postUrlRe.test(finalUrl)) {
    await dumpPublishStuck(page, finalUrl, diag);
    return null;
  }
  return finalUrl;
}

/**
 * 발행 클릭 후에도 글 URL로 못 넘어갔을 때(예외 없이 조용히 null 이 되는 케이스) 원인을
 * 눈으로 확인할 수 있도록 스크린샷을 남긴다. dumpFailure 와 달리 예외가 없어도 호출된다.
 */
async function dumpPublishStuck(page, finalUrl, { consoleErrors, postRequests } = {}) {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const shot = join(LOGS_DIR, `publish-stuck-${ts}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.warn(`   ⚠️  발행 후 글 URL 이동을 확인 못함 (머문 URL: ${finalUrl}). 스크린샷: ${shot}`);

    // 2026-07-18: 발행 버튼 클릭 후 dkaptcha(다음/카카오 캡차) 위젯 호출만 있고 실제 저장
    // 요청은 안 나가는 패턴이 반복 확인됨 — 아마도 잦은 자동 발행 때문에 캡차 게이트가 걸린 것으로 보임.
    // 사람이 브라우저에서 직접 한 번 발행해 캡차를 통과시켜야 풀릴 가능성이 높다.
    if (postRequests?.some((r) => /dkaptcha/i.test(r))) {
      console.warn(
        '   🚨 캡차(dkaptcha) 위젯 호출이 감지됐고, 그 이후 실제 발행 요청이 나가지 않았습니다.\n' +
        '      → 티스토리가 이 계정의 발행에 캡차 인증을 요구하는 것으로 보입니다(자동화가 못 품).\n' +
        '      → "npm run login" 이나 브라우저에서 직접 로그인해 수동으로 한 번 발행해보세요.'
      );
    }
    if (postRequests?.length) {
      console.warn(`   🌐 발행 흐름 중 POST 요청 ${postRequests.length}건:`);
      for (const r of postRequests.slice(-15)) console.warn(`      - ${r}`);
    }
    if (consoleErrors?.length) {
      console.warn(`   ⚠️  브라우저 콘솔 에러 ${consoleErrors.length}건:`);
      for (const e of consoleErrors.slice(0, 10)) console.warn(`      - ${e}`);
    }
    const dialogInfo = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('iframe').forEach((f) => out.push(`iframe: ${f.src || '(no src)'} class=${f.className}`));
      document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="layer" i][class*="pop" i]').forEach((el) => {
        const text = (el.textContent || '').trim();
        if (text) {
          out.push(`dialog-like <${el.tagName} class="${el.className}"> text="${text.slice(0, 100)}"`);
        } else {
          out.push(`EMPTY dialog-like <${el.tagName} class="${el.className}"> innerHTML="${el.innerHTML.slice(0, 500)}"`);
        }
      });
      return out;
    }).catch((e) => [`evaluate 실패: ${e.message}`]);
    if (dialogInfo.length) {
      console.warn('   🔍 페이지 내 iframe/모달 후보:');
      for (const d of dialogInfo.slice(0, 15)) console.warn(`      - ${d}`);
    }
  } catch {
    // 스크린샷 실패는 무시
  }
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
