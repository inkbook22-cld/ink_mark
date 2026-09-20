/**
 * Electron 캡처 백엔드 — 제품 경로.
 *
 * 앱에 이미 Chromium 이 들어 있으므로 Puppeteer 같은 추가 의존성이 필요 없다.
 * 테스트용 Playwright 백엔드와 규약(window.__inkReady)이 같아 결과가 일치한다.
 *
 * BrowserWindow.capturePage() 를 쓰지 않는 이유:
 *   창은 화면 크기를 넘지 못한다. 카드는 1350px 인데 노트북 화면이 그보다 낮으면
 *   캡처가 조용히 잘린다. 사용자는 업로드한 뒤에야 알게 된다.
 *   DevTools 프로토콜의 captureBeyondViewport 는 창·화면 크기와 무관하게 찍는다.
 */

import { BrowserWindow } from 'electron';
import { pathToFileURL } from 'node:url';

export function createElectronCapture() {
  /** @type {BrowserWindow|null} */
  let win = null;

  const ensure = () => {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        nodeIntegration: false,
        // 템플릿은 로컬 파일만 읽는다. 외부 네트워크가 필요 없다.
        webSecurity: true,
      },
    });
    return win;
  };

  const capture = async ({ templateUrl, data, width, height }) => {
    const w = ensure();
    const wc = w.webContents;

    // 데이터는 해시로 넘긴다. 페이지 스크립트가 도는 시점에 이미 읽을 수 있어야 하므로
    // 로드 후에 주입하면 늦는다 — 템플릿 런타임이 location.hash 를 직접 읽는다.
    await w.loadURL(`${templateUrl}#${encodeURIComponent(JSON.stringify(data))}`);

    // 폰트·이미지가 준비될 때까지 기다린 뒤에 찍는다. 이걸 빼면 빈 PNG 가 나온다.
    const ready = await wc.executeJavaScript('window.__inkReady');
    if (!ready) {
      throw new Error('템플릿에서 window.__inkReady 를 받지 못했다. 스크립트 로드 실패일 가능성이 높다.');
    }

    let attached = false;
    try {
      if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); attached = true; }

      // 창 크기와 무관하게 페이지를 정확히 카드 크기로 잡는다
      await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      });

      const { data: b64 } = await wc.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });

      const buffer = Buffer.from(b64, 'base64');
      assertSize(buffer, width, height);
      return { buffer, ready };
    } finally {
      if (attached && wc.debugger.isAttached()) {
        try { await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride'); } catch { /* 무시 */ }
        wc.debugger.detach();
      }
    }
  };

  capture.close = () => { if (win && !win.isDestroyed()) win.destroy(); win = null; };
  return capture;
}

/**
 * PNG 헤더에서 크기를 읽어 확인한다.
 * 크기가 어긋나면 조용히 잘린 카드를 내보내는 대신 실패시킨다 — 잘린 결과물은
 * 사용자가 업로드한 뒤에야 알아차리게 되기 때문이다.
 */
function assertSize(buffer, width, height) {
  const w = buffer.readUInt32BE(16);
  const h = buffer.readUInt32BE(20);
  if (w !== width || h !== height) {
    throw new Error(`캡처 크기가 다르다: ${w}x${h} (기대 ${width}x${height}).`);
  }
}

export const fileUrl = (p) => pathToFileURL(p).href;
