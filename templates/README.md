# 템플릿

카드뉴스·블로그 이미지의 **문구·로고·레이아웃 합성은 전부 HTML/CSS 단일 경로**로 한다.
Sharp는 텍스트에 손대지 않는다.

## 역할 분담

| 역할 | 도구 |
|---|---|
| 조판 (문구·로고·레이아웃) | HTML/CSS → Chromium 캡처 |
| 사진 전처리 (리사이즈·크롭·EXIF 회전 보정·메타데이터 제거) | Sharp |
| 배경·일러스트 생성 | gpt-image-2 (medium, 세로) |

세 가지는 대안 관계가 아니라 순차 단계다.
생성 모델은 **배경만** 그리고, 한글 문구는 앱이 그 위에 얹는다.
모델에게 글자를 그리게 하면 자모가 깨지고, 무엇보다 문구 수정이 불가능해진다
(재생성할 때마다 그림이 달라지므로).

## HTML/CSS를 택한 이유

1. **미리보기와 결과물이 자동으로 일치한다.** React 미리보기와 내보내기 PNG가 같은
   파일·같은 CSS다. 두 경로로 나뉘면 반드시 어긋나고, "화면에선 멀쩡했는데 PNG에서
   글자가 튀어나왔다"는 버그를 계속 잡게 된다.
2. **한글 조판이 기본 기능이다.** `word-break: keep-all` 한 줄이 어절 단위 줄바꿈이다.
   SVG 경로를 택했다면 글자 폭 측정·금칙 처리·말줄임을 직접 구현해야 했다.
3. **글자 잘림 검사가 확정적이다.** `scrollHeight > clientHeight`로 렌더 시점에 판정한다.
   사후 이미지 분석으로는 이 정확도가 안 나온다.
4. **폰트를 시스템에 설치할 필요가 없다.** `@font-face`로 앱 동봉 파일을 바로 읽는다.

## 캡처 규약 (유일한 함정)

폰트 로딩·이미지 디코딩이 끝나기 전에 캡처하면 폰트가 안 먹거나 빈 PNG가 나온다.
모든 템플릿은 `window.__inkReady` (Promise)를 노출하고, 캡처 쪽은 **반드시 이것을
await한 뒤** 찍는다.

```js
const ready = await page.evaluate(() => window.__inkReady);
// ready = { ok, overflow: [{id, text}], width, height }
```

`overflow` 가 비어 있지 않으면 글자가 잘린 것이다. 계획의 검증 시나리오 중
"긴 한글 문구" 항목이 여기서 걸린다.

## 데이터 주입

작업 프로세스가 `window.__inkData` 를 심어 두고 페이지를 연다.
`tokens` 의 키는 CSS 변수명으로 그대로 들어간다(BrandProfile → `--brand-primary` 등).

```js
window.__inkData = {
  eyebrow, pager, headline, body,
  photo,   // file:// 또는 data: URL
  logo,    // 원본 로고 파일. 생성 모델에 맡기지 않는다
  tokens: { 'brand-primary': '#2f4f3e', 'brand-accent': '#c8794a' },
};
```

## 제품 경로 vs 테스트 하네스

- **제품:** Electron 내장 Chromium (`BrowserWindow` 1080×1350 → `capturePage()`).
  Puppeteer 등 추가 의존성이 필요 없다.
- **테스트:** `scripts/render-card.mjs` (Playwright). Electron 없이 CI에서 템플릿
  회귀를 돌리기 위한 것. 캡처 규약이 같으므로 두 경로의 결과가 일치한다.
