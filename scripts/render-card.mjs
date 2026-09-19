#!/usr/bin/env node
/**
 * 템플릿 렌더 테스트 하네스.
 *
 * 주의: 이것은 제품 경로가 아니다. 앱은 Electron 내장 Chromium(BrowserWindow)으로
 * 캡처한다. 이 스크립트는 Electron 없이 CI에서 템플릿 회귀를 돌리기 위한 것이며,
 * 캡처 준비 신호(window.__inkReady)와 잘림 검사 규약이 같으므로 둘의 결과가 일치한다.
 *
 * 사용:
 *   node scripts/render-card.mjs [템플릿경로] [출력경로]
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

const CARD_W = 1080;
const CARD_H = 1350;

const template = process.argv[2] ?? fileURLToPath(new URL('../templates/card-photo/card.html', import.meta.url));
const outPath = process.argv[3] ?? fileURLToPath(new URL('./out/card-preview.png', import.meta.url));

await mkdir(path.dirname(outPath), { recursive: true });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({
  viewport: { width: CARD_W, height: CARD_H },
  deviceScaleFactor: 1,
});

await page.goto(pathToFileURL(template).href);

// 폰트·이미지가 준비될 때까지 기다린 뒤에 찍는다. 이 한 줄이 빈 PNG 사고를 막는다.
const ready = await page.evaluate(() => window.__inkReady);
if (!ready) {
  await browser.close();
  throw new Error(
    'window.__inkReady 가 없다. 템플릿 스크립트가 로드되지 않았다는 뜻이다.\n' +
    'ES 모듈(type="module")은 file:// 에서 CORS 로 차단된다 — 일반 스크립트를 쓸 것.',
  );
}

await page.locator('#stage').screenshot({ path: outPath });
await browser.close();

console.log(`rendered ${CARD_W}x${CARD_H} → ${outPath}`);
if (ready.overflow.length) {
  console.log('\n글자 잘림 감지:');
  for (const o of ready.overflow) console.log(`  #${o.id}  "${o.text}…"`);
  process.exitCode = 1;
} else {
  console.log('글자 잘림 없음');
}
