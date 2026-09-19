/**
 * 계정별 브라우저 세션.
 *
 * 계정마다 전용 프로필 디렉터리를 쓴다. 한 사람이 여러 브랜드를 운영하는 것이
 * 이 앱의 전제이므로, 로그인 상태가 섞이면 엉뚱한 블로그에 글이 올라간다.
 *
 * 로그인은 자동화하지 않는다. 사용자가 창에서 직접 로그인하고, 세션은 프로필에
 * 남아 다음 실행에 재사용된다. 아이디·비밀번호를 앱이 보관하지 않는다는 뜻이기도 하다.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {{profileDir: string, headless?: boolean, channel?: string, executablePath?: string}} opts
 */
export async function openSession({ profileDir, headless = false, channel, executablePath }) {
  await mkdir(path.dirname(profileDir), { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    // 시스템에 설치된 Chrome 을 쓴다. 브라우저를 앱에 번들하면 설치 파일이 수백 MB 늘어난다.
    // 설치돼 있지 않으면 호출자가 사용자에게 설치를 안내한다.
    ...(executablePath ? { executablePath } : channel ? { channel } : { channel: 'chrome' }),
    viewport: { width: 1440, height: 960 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

/**
 * 로그인 여부 확인. 안 돼 있으면 로그인 화면을 띄우고 사용자가 마칠 때까지 기다린다.
 *
 * @param {import('playwright').Page} page
 * @param {object} profile  profile.json
 * @param {{timeoutMs?: number, onWaiting?: (url:string)=>void}} [opts]
 */
export async function ensureLoggedIn(page, profile, { timeoutMs = 300000, onWaiting } = {}) {
  await page.goto('https://blog.naver.com', { waitUntil: 'domcontentloaded' });

  const loggedIn = await page
    .locator(profile.selectors.loginCheck)
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  if (loggedIn) return { alreadyLoggedIn: true };

  onWaiting?.(profile.urls.login);
  await page.goto(profile.urls.login, { waitUntil: 'domcontentloaded' });

  // 사용자가 직접 로그인할 때까지 대기. 자동 입력하지 않는다.
  await page.waitForURL((url) => !url.href.includes('nidlogin'), { timeout: timeoutMs });

  return { alreadyLoggedIn: false };
}
