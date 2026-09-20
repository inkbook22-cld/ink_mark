/**
 * 메인 프로세스 — 창, IPC 중계, 카드 렌더.
 *
 * 설계:
 *   화면(렌더러)  ─ preload 의 화이트리스트만 통해 ─▶ 메인 ─▶ 작업 프로세스
 *                                                      ◀─ 렌더 요청(capture)
 *
 * API 키는 메인과 작업 프로세스에만 있다. 화면에는 "설정됨" 여부만 내려간다.
 */

import { app, BrowserWindow, ipcMain, shell, utilityProcess } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setKey, getKey, keyStatus } from './keys.mjs';
import { createElectronCapture } from './capture.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

/** @type {BrowserWindow|null} */
let win = null;
/** @type {import('electron').UtilityProcess|null} */
let worker = null;
let capture = null;

const pending = new Map();
let seq = 0;

function startWorker() {
  worker = utilityProcess.fork(path.join(dir, 'worker.mjs'), [], { stdio: 'inherit' });

  worker.on('message', async (msg) => {
    // 작업 프로세스가 요청한 일 — 지금은 카드 렌더뿐이다.
    // BrowserWindow 는 메인에만 있으므로 렌더는 여기서 한다.
    if (msg.type === 'rpc') {
      try {
        if (msg.method !== 'capture') throw new Error(`알 수 없는 요청: ${msg.method}`);
        capture ??= createElectronCapture();
        const { buffer, ready } = await capture(msg.payload);
        worker.postMessage({ type: 'rpc-result', id: msg.id, result: { buffer, ready } });
      } catch (err) {
        worker.postMessage({ type: 'rpc-result', id: msg.id, error: String(err?.message ?? err) });
      }
      return;
    }

    if (msg.type === 'progress') {
      win?.webContents.send('ink:progress', msg);
      return;
    }

    if (msg.type === 'result') {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error));
      else p?.resolve(msg.result);
    }
  });

  worker.on('exit', () => { worker = null; });
}

/** 작업 프로세스에 일을 시킨다. */
function toWorker(method, payload) {
  if (!worker) throw new Error('작업 프로세스가 꺼져 있습니다. 앱을 다시 시작해 주세요.');
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'call', id, method, payload });
  });
}

/** 키를 작업 프로세스에 넘긴다. 화면은 이 경로를 볼 수 없다. */
async function pushKeys() {
  return toWorker('keys:update', {
    keys: { openai: await getKey('openai'), gemini: await getKey('gemini') },
  });
}

ipcMain.handle('ink:call', async (_e, { method, payload }) => {
  // 키 관련만 메인이 직접 처리한다. 나머지는 작업 프로세스로 넘긴다.
  if (method === 'keys:status') return keyStatus();
  if (method === 'keys:set') {
    await setKey(payload.provider, payload.value);
    await pushKeys();
    return keyStatus();
  }
  if (method === 'shell:open') return shell.openPath(payload.path);
  return toWorker(method, payload);
});

async function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 1024, minHeight: 700,
    title: 'INK 마케팅 스튜디오',
    backgroundColor: '#faf7f2',
    webPreferences: {
      preload: path.join(dir, 'preload.cjs'),
      // 화면은 Node 에 닿지 않는다. 통로는 preload 의 화이트리스트뿐이다.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await win.loadFile(path.join(dir, '../dist/ui/index.html'));
  }
}

app.whenReady().then(async () => {
  startWorker();
  await toWorker('init', {
    paths: { userData: app.getPath('userData') },
    keys: { openai: await getKey('openai'), gemini: await getKey('gemini') },
  });
  await createWindow();

  // 스모크 모드 — CI 에서 앱이 실제로 뜨는지 확인하고 화면을 남긴다.
  if (process.env.INK_SMOKE) {
    await new Promise((r) => setTimeout(r, 2500)); // 첫 렌더와 데이터 로딩을 기다린다
    const fs = await import('node:fs/promises');
    const img = await win.webContents.capturePage();
    await fs.writeFile(process.env.INK_SMOKE, img.toPNG());

    // 생성까지 한 번 돌려본다. 여기서만 검증되는 것이 Electron 캡처 경로다 —
    // 단위 테스트는 Playwright 백엔드로 돌기 때문에 제품 경로를 타지 않는다.
    if (process.env.INK_SMOKE_GENERATE) {
      const brands = await toWorker('brands:list');
      const r = await toWorker('generate', {
        brandId: brands[0].id,
        source: '겨울 한정 메뉴를 시작합니다. 반죽은 매일 아침 여섯 시에 시작합니다.',
        cardCount: 3,
      });
      await fs.writeFile(
        process.env.INK_SMOKE_GENERATE,
        JSON.stringify({
          error: r.error ?? null,
          cards: (r.cards ?? []).map((c) => ({ id: c.cardId, design: c.design, path: c.path })),
          failures: r.failures,
          issues: r.issues,
          exported: r.exported?.written?.length ?? 0,
          mocked: r.mocked,
        }, null, 2),
      );
    }

    app.quit();
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  capture?.close();
  worker?.kill();
  if (process.platform !== 'darwin') app.quit();
});
