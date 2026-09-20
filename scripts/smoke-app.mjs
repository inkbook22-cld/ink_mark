#!/usr/bin/env node
/**
 * 앱 스모크 — Electron 이 실제로 뜨고, 화면이 그려지고, 작업 프로세스가 붙는지 확인한다.
 *
 * 단위 테스트로는 "창이 안 뜬다" 같은 문제를 못 잡는다. CI 에서 이걸 돌리고
 * 나온 PNG 를 눈으로 보면 회귀를 바로 안다.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/jobs/store.mjs';
import { readFile } from 'node:fs/promises';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = process.argv[2];
const out = arg && !arg.startsWith('--') ? arg : path.join(ROOT, 'scripts/out/app.png');
mkdirSync(path.dirname(out), { recursive: true });

// Electron 의 userData 경로에 예시 브랜드를 심어 화면에 보여줄 것이 있게 한다
const userData = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library/Application Support/ink-mark')
  : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'ink-mark');
mkdirSync(userData, { recursive: true });
const store = new Store(path.join(userData, 'ink.db'));
if (!store.listBrands().length) {
  store.saveBrand(JSON.parse(await readFile(path.join(ROOT, 'samples/brand.json'), 'utf8')));
}
store.close();

const electron = path.join(ROOT, 'node_modules/electron/dist/electron');
if (!existsSync(electron)) {
  console.error('electron 이 설치되어 있지 않다. npm install 먼저.');
  process.exit(2);
}

// 컨테이너에서는 샌드박스를 못 쓴다. 실제 배포에서는 이 플래그를 쓰지 않는다.
const args = ['.', '--no-sandbox', '--disable-gpu'];
const child = spawn('xvfb-run', ['-a', electron, ...args], {
  cwd: ROOT,
  env: {
    ...process.env,
    INK_SMOKE: out,
    // --generate 를 주면 생성까지 돌려 Electron 캡처 경로를 검증한다
    ...(process.argv.includes('--generate')
      ? { INK_SMOKE_GENERATE: path.join(path.dirname(out), 'smoke-generate.json') }
      : {}),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
  stdio: 'inherit',
});

const timer = setTimeout(() => { child.kill('SIGKILL'); }, 180000);
child.on('exit', async (code) => {
  clearTimeout(timer);
  const genOut = path.join(path.dirname(out), 'smoke-generate.json');
  if (existsSync(out)) {
    console.log(`앱이 떴고 화면을 저장했다 → ${out}`);
    if (process.argv.includes('--generate')) {
      if (!existsSync(genOut)) {
        console.error('생성 결과가 없다 — 작업 프로세스나 Electron 캡처 경로에서 막혔다.');
        process.exit(1);
      }
      const r = JSON.parse(await readFile(genOut, 'utf8'));
      if (r.error) { console.error(`생성 실패: ${r.error}`); process.exit(1); }
      console.log(`카드 ${r.cards.length}장 · 내보낸 파일 ${r.exported}개 · 실패 ${r.failures.length}건`);
      const clipped = (r.issues ?? []).filter((i) => /잘립니다/.test(i.message));
      console.log(`검사 ${(r.issues ?? []).length}건 (글자 잘림 ${clipped.length}건)`);
      for (const i of clipped) console.log(`  - ${i.where}: ${i.message}`);
      if (!r.cards.length) { console.error('카드가 한 장도 안 나왔다.'); process.exit(1); }
    }
    process.exit(0);
  }
  console.error(`화면을 얻지 못했다 (electron exit ${code})`);
  process.exit(1);
});
