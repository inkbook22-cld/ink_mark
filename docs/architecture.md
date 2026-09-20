# 앱 구조

```
  화면(렌더러)              메인 프로세스              작업 프로세스
  React + TypeScript        창·IPC·카드 렌더          API 호출·파이프라인
  Node 접근 없음     ◀──▶   safeStorage(키)    ◀──▶   키를 여기서만 쓴다
                            ◀── capture RPC ──
```

## 왜 이렇게 나눴나

**화면은 Node 에 닿지 않는다.** `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`. 화면이 부를 수 있는 것은 `electron/preload.cjs` 에 적힌 목록뿐이다.
새 기능을 붙일 때 거기에 한 줄 추가하는 것이 곧 보안 검토가 된다.

**API 키는 화면에 내려가지 않는다.** 메인과 작업 프로세스만 실제 값을 안다.
화면이 알 수 있는 것은 "설정되어 있는가"와 끝 4자리뿐이다.

**생성은 별도 프로세스에서 돈다.** 원고·이미지 생성은 수십 초가 걸린다.
화면 프로세스에서 돌리면 UI 가 멈춘다.

**카드 렌더만 메인으로 되돌아온다.** `BrowserWindow` 는 메인에만 있기 때문이다.
작업 프로세스가 `capture` RPC 를 보내면 메인이 렌더해서 PNG 를 돌려준다.

## 캡처 경로 — BrowserWindow.capturePage 를 쓰지 않는 이유

창은 화면 크기를 넘지 못한다. 카드는 1350px 인데 노트북 화면이 그보다 낮으면
`capturePage()` 가 **조용히 잘린 PNG** 를 준다. 사용자는 업로드한 뒤에야 알게 된다.

그래서 DevTools 프로토콜의 `Page.captureScreenshot` 에 `captureBeyondViewport` 를
써서 창·화면 크기와 무관하게 찍는다. 찍은 뒤 PNG 헤더에서 크기를 읽어 한 번 더
확인하고, 어긋나면 실패시킨다.

## 캡처 규약

템플릿은 두 가지를 지킨다.

1. **데이터는 페이지 스크립트가 돌기 전에 준비되어야 한다.**
   `window.__inkData`(Playwright) 또는 `location.hash`(Electron)로 들어온다.
   로드 후에 주입하면 템플릿은 이미 기본값으로 렌더를 끝낸 뒤다.
2. **`window.__inkReady` 를 await 한 뒤에 찍는다.**
   폰트 로딩과 이미지 디코딩이 끝나기 전에 찍으면 빈 PNG 가 나온다.

백엔드가 둘(Electron·Playwright)이어도 규약이 같으므로 결과가 일치한다.

## 화면 스크립트는 일반 스크립트여야 한다

ES 모듈 `import` 는 `file://` 에서 CORS 로 차단된다. 카드 템플릿은 로컬 파일로
열리므로 `templates/shared/card-runtime.js` 는 모듈이 아니라 일반 스크립트다.
(렌더러 UI 는 Electron 이 `file://` 에서도 모듈을 허용해 Vite 번들 그대로 쓴다.)

## 확인 방법

| | |
|---|---|
| `npm test` | 병합 규칙·저장소·파이프라인 회귀 |
| `npm run smoke -- --generate` | Electron 이 실제로 뜨고 제품 캡처 경로로 카드가 나오는지 |
| `node scripts/ui-preview.mjs result` | 화면만 따로 (Electron·키 없이) |

`ui-preview` 는 `window.ink` 를 가짜로 채운다. 제품 코드에 테스트용 분기를 넣지
않으려는 것이고, 화면이 preload 에 없는 함수를 부르면 거기서 바로 드러난다.
