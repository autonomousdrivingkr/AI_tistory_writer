// 카카오 로그인 자동화 공통 로직. login.js(수동 최초 로그인)와
// publisher.js(세션 만료 시 자동 재로그인 폴백)가 함께 쓴다.

// 카카오 자격증명은 .env 에서만 읽는다(코드/config.json 에는 절대 두지 않는다).
export const KAKAO_EMAIL = process.env.KAKAO_EMAIL || process.env.KAKAO_ID;
export const KAKAO_PASSWORD = process.env.KAKAO_PASSWORD || process.env.KAKAO_PW;

/**
 * 티스토리 로그인 화면 → 카카오 로그인 폼으로 이동해 아이디/비번을 자동 입력하고 제출한다.
 * 카카오는 셀렉터/캡차를 자주 바꾸므로 모두 best-effort 로 시도하고,
 * 실패하면 조용히 넘어가 호출부가 판단하게 둔다(캡차 등은 어차피 자동으로 못 뚫는다).
 */
export async function autoFillKakao(page) {
  try {
    // 1) 티스토리 로그인 화면의 "카카오계정으로 로그인" 버튼/링크 → 카카오 로그인 폼으로 이동
    const kakaoEntry = page
      .getByRole('link', { name: /카카오/ })
      .or(page.getByRole('button', { name: /카카오/ }));
    await kakaoEntry.first().click({ timeout: 8000 }).catch(() => {});

    // 2) 카카오 로그인 폼(아이디/비번)이 뜰 때까지 대기
    const idInput = page
      .locator('input[name="loginId"], input[name="email"], #loginId--1, #id_email_2')
      .first();
    await idInput.waitFor({ state: 'visible', timeout: 15000 });
    await idInput.fill(KAKAO_EMAIL);

    const pwInput = page
      .locator('input[name="password"], input[type="password"], #password--2')
      .first();
    await pwInput.fill(KAKAO_PASSWORD);

    // 3) "로그인 상태 유지" 체크 → 세션이 더 오래 유지돼 재로그인 빈도가 준다.
    await page
      .getByText('로그인 상태 유지', { exact: false })
      .first()
      .click({ timeout: 2000 })
      .catch(() => {});

    // 4) 로그인 버튼(없으면 Enter 로 제출)
    await page
      .getByRole('button', { name: /^로그인$/ })
      .first()
      .click({ timeout: 5000 })
      .catch(() => pwInput.press('Enter').catch(() => {}));

    return true;
  } catch {
    return false;
  }
}

/** 티스토리 세션 쿠키(TSSESSION)가 생길 때까지 주기적으로 확인한다(최대 timeoutMs). */
export async function waitForSessionCookie(context, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cookies = await context.cookies('https://www.tistory.com').catch(() => []);
    if (cookies.some((c) => /TSSESSION/i.test(c.name))) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
