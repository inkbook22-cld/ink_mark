/**
 * 타이핑 엔진.
 *
 * 본문을 클립보드로 붙여넣지 않고 한 글자씩 입력한다.
 *
 * 붙여넣기를 쓰지 않는 이유:
 * - 붙여넣기는 원본 서식(HTML)을 끌고 들어와 에디터가 제멋대로 재해석한다.
 *   글꼴·크기·색이 섞이고, 네이버 쪽 정리 로직에 따라 문단이 통째로 깨지기도 한다.
 * - 클립보드는 전역 자원이다. 업로드 도중 사용자가 다른 것을 복사하면 내용이 바뀐다.
 * - 에디터가 paste 이벤트를 자체 처리하는 경우 삽입 위치를 제어할 수 없다.
 *
 * 타이핑은 느리지만(원고 한 편에 20~60초) 결과가 예측 가능하다.
 */

const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const JONG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

const isHangulSyllable = (ch) => {
  const c = ch.codePointAt(0);
  return c >= 0xac00 && c <= 0xd7a3;
};

/**
 * 한글 음절을 조합 단계로 쪼갠다. '한' → ['ㅎ', '하', '한']
 * 실제 IME가 화면에 보여주는 중간 상태와 같다.
 */
export function composeSteps(ch) {
  const code = ch.codePointAt(0) - 0xac00;
  const jong = code % 28;
  const jung = Math.floor(code / 28) % 21;
  const cho = Math.floor(code / 28 / 21);

  const steps = [CHO[cho]];
  steps.push(String.fromCodePoint(0xac00 + (cho * 21 + jung) * 28));
  if (jong) steps.push(ch);
  return steps;
}

/**
 * @typedef {'key'|'ime'} TypeMode
 * 'key' — Playwright 기본 입력. 한 글자씩 delay 를 두고 친다. 빠르고 대부분 잘 된다.
 * 'ime' — CDP 조합 이벤트까지 흉내 낸다. 에디터가 composition 이벤트에 의존해
 *         입력을 처리할 때만 필요하다. 3배쯤 느리므로 'key' 가 실패할 때만 쓴다.
 */

/**
 * 현재 포커스된 곳에 텍스트를 타이핑한다.
 *
 * @param {import('playwright').Page} page
 * @param {string} text
 * @param {{mode?: TypeMode, delayMs?: number, signal?: AbortSignal}} opts
 */
export async function typeText(page, text, { mode = 'key', delayMs = 12, signal } = {}) {
  if (mode === 'key') {
    // Playwright 는 자판에 없는 문자(한글 등)를 insertText 로 넣는다.
    // beforeinput/input 이벤트는 정상적으로 발생하므로 대부분의 에디터가 인식한다.
    for (const ch of text) {
      signal?.throwIfAborted();
      await page.keyboard.type(ch, { delay: delayMs });
    }
    return;
  }

  const cdp = await page.context().newCDPSession(page);
  try {
    for (const ch of text) {
      signal?.throwIfAborted();
      if (isHangulSyllable(ch)) {
        for (const step of composeSteps(ch)) {
          await cdp.send('Input.imeSetComposition', {
            text: step,
            selectionStart: step.length,
            selectionEnd: step.length,
          });
          await page.waitForTimeout(delayMs);
        }
        await cdp.send('Input.insertText', { text: ch });
      } else {
        await page.keyboard.type(ch, { delay: delayMs });
      }
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * 문단 단위 입력. 문단 사이에는 Enter 를 눌러 새 문단을 만든다.
 * 줄바꿈 문자를 그대로 치면 에디터가 무시하거나 한 문단에 밀어 넣는다.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} paragraphs
 */
export async function typeParagraphs(page, paragraphs, opts = {}) {
  const { pauseMs = 120, ...typeOpts } = opts;
  for (let i = 0; i < paragraphs.length; i++) {
    if (i > 0) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(pauseMs);
    }
    await typeText(page, paragraphs[i], typeOpts);
  }
}

/**
 * 입력 전에 대상 요소를 비운다.
 * 임시저장 글을 이어서 열었을 때 기존 내용 위에 덧쓰는 사고를 막는다.
 */
export async function clearFocused(page) {
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
}
