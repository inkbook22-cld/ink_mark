/**
 * 템플릿 공통 런타임 — 데이터 주입, 잘림 검사, 캡처 준비 신호.
 *
 * 세 템플릿이 같은 규약을 쓰도록 여기 한 곳에 모은다. 규약이 갈리면
 * 미리보기와 캡처가 어긋나기 시작한다.
 *
 * ES 모듈이 아니라 일반 스크립트다. 모듈 import 는 file:// 에서 CORS 로 차단되는데,
 * 앱은 템플릿을 로컬 파일로 열기 때문에 모듈로 만들면 캡처가 통째로 실패한다.
 */
window.mountCard = function mountCard(defaults) {
  // 데이터는 두 경로로 들어온다.
  //   1) window.__inkData  — Playwright 가 스크립트 실행 전에 심는 경로(테스트·CI)
  //   2) location.hash     — Electron 이 loadURL 로 넘기는 경로(제품)
  // 둘 다 페이지 스크립트가 도는 시점에 이미 읽을 수 있어야 한다. 로드 후에 심으면
  // 이 함수는 이미 기본값으로 렌더를 끝낸 뒤다.
  const data = window.__inkData ?? readHashData() ?? defaults;

  for (const [k, v] of Object.entries(data.tokens ?? {})) {
    document.documentElement.style.setProperty(`--${k}`, v);
  }

  for (const [id, value] of Object.entries(data)) {
    if (['tokens', 'photo', 'logo'].includes(id)) continue;
    const el = document.getElementById(id);
    if (el) el.textContent = value ?? '';
  }

  const photo = document.getElementById('photo');
  if (photo && data.photo) photo.src = data.photo;
  const logo = document.getElementById('logo');
  if (logo && data.logo) { logo.src = data.logo; logo.hidden = false; }

  /**
   * 렌더 시점에 실제 높이를 재서 잘림을 확정 판정한다.
   *
   * -webkit-line-clamp 로 자른 경우 scrollHeight 가 clientHeight 와 같아져서
   * 단순 비교로는 잡히지 않는다. 그래서 클램프를 잠시 풀고 본래 높이를 잰 뒤
   * 되돌린다. 캡처는 이 함수가 끝난 뒤에 하므로 화면에는 영향이 없다.
   */
  function findOverflow() {
    const clipped = [];
    for (const el of document.querySelectorAll('.clamp, .ko')) {
      const limit = el.clientHeight;
      let natural = el.scrollHeight;

      const style = getComputedStyle(el);
      if (style.webkitLineClamp && style.webkitLineClamp !== 'none') {
        const prevClamp = el.style.webkitLineClamp;
        const prevOverflow = el.style.overflow;
        el.style.webkitLineClamp = 'unset';
        el.style.overflow = 'visible';
        natural = el.scrollHeight; // 여기서 강제 리플로우가 일어난다
        el.style.webkitLineClamp = prevClamp;
        el.style.overflow = prevOverflow;
      }

      const over = natural > limit + 1 || el.scrollWidth > el.clientWidth + 1;
      el.dataset.overflow = String(over);
      if (over) {
        clipped.push({
          id: el.id,
          text: el.textContent.trim().slice(0, 40),
          naturalHeight: natural,
          limitHeight: limit,
        });
      }
    }
    return clipped;
  }

  /**
   * 폰트·이미지가 준비되기 전에 캡처하면 폰트가 안 먹거나 빈 PNG 가 나온다.
   * 캡처 쪽은 반드시 이 값을 await 한다.
   */
  window.__inkReady = (async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].filter((i) => i.src && !i.hidden).map((i) => i.decode().catch(() => {})),
    );
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { ok: true, overflow: findOverflow(), width: 1080, height: 1350 };
  })();
};

function readHashData() {
  if (location.hash.length < 2) return null;
  try {
    return JSON.parse(decodeURIComponent(location.hash.slice(1)));
  } catch {
    return null;
  }
}
