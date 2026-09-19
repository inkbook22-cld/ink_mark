/**
 * 카드 일괄 렌더.
 *
 * 캡처 방식을 주입받는다. 앱은 Electron 내장 Chromium(BrowserWindow.capturePage)을,
 * 테스트·CI 는 Playwright 를 넘긴다. 규약(window.__inkReady)이 같으므로 결과가 일치한다.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CARD_W = 1080;
export const CARD_H = 1350;

const TEMPLATE_DIR = new URL('../../templates/', import.meta.url);
const templatePath = (design) => path.join(TEMPLATE_DIR.pathname, `card-${design}`, 'card.html');

/**
 * @param {object[]} cards  Field 로 감싼 카드 목록
 * @param {{outDir:string, brand:object, capture:Function, onProgress?:Function}} opts
 * @returns {Promise<{rendered:object[], report:object[]}>}
 */
export async function renderCards(cards, { outDir, brand, capture, onProgress }) {
  await mkdir(outDir, { recursive: true });
  const v = (f) => (f && typeof f === 'object' && 'value' in f ? f.value : f);

  const rendered = [];
  const report = [];

  for (const [i, card] of cards.entries()) {
    const design = v(card.design) ?? 'photo';
    const data = {
      eyebrow: v(card.eyebrow),
      headline: v(card.headline),
      body: v(card.body),
      pager: `${i + 1} / ${cards.length}`,
      contact: brand.contact ?? '',
      photo: v(card.photo) ? pathToFileURL(v(card.photo)).href : '',
      logo: brand.logoPath ? pathToFileURL(brand.logoPath).href : '',
      tokens: brandTokens(brand),
    };

    onProgress?.(`카드 ${i + 1}/${cards.length} 렌더`);

    const { buffer, ready } = await capture({
      templateUrl: pathToFileURL(templatePath(design)).href,
      data,
      width: CARD_W,
      height: CARD_H,
    });

    const relPath = `cards/${String(i + 1).padStart(2, '0')}-${design}.png`;
    const abs = path.join(outDir, path.basename(relPath));
    await writeFile(abs, buffer);

    rendered.push({ cardId: card.id, design, path: abs, relPath, bytes: buffer.length });
    report.push({ cardId: card.id, overflow: ready?.overflow ?? [] });
  }

  return { rendered, report };
}

/** BrandProfile → CSS 변수. 템플릿은 색을 직접 쓰지 않고 항상 변수를 경유한다. */
export function brandTokens(brand) {
  const t = {};
  if (brand.colors?.primary) t['brand-primary'] = brand.colors.primary;
  if (brand.colors?.accent) t['brand-accent'] = brand.colors.accent;
  if (brand.colors?.ink) t['brand-ink'] = brand.colors.ink;
  if (brand.colors?.paper) t['brand-paper'] = brand.colors.paper;
  return t;
}

/**
 * Playwright 캡처 백엔드 (테스트·CI 용).
 * 브라우저를 한 번 띄워 카드 전부를 찍는다 — 장당 띄우면 7장에 수십 초가 더 든다.
 */
export async function createPlaywrightCapture({ executablePath } = {}) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

  const browser = await chromium.launch(executablePath ? { executablePath } : {});

  const capture = async ({ templateUrl, data, width, height }) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    try {
      // 페이지 스크립트보다 먼저 데이터를 심는다
      await page.addInitScript((d) => { window.__inkData = d; }, data);
      await page.goto(templateUrl);

      const ready = await page.evaluate(() => window.__inkReady);
      if (!ready) {
        throw new Error(
          '템플릿에서 window.__inkReady 를 받지 못했다. 스크립트 로드 실패일 가능성이 높다 ' +
          '(ES 모듈은 file:// 에서 차단된다).',
        );
      }

      const buffer = await page.locator('#stage').screenshot();
      return { buffer, ready };
    } finally {
      await page.close();
    }
  };

  capture.close = () => browser.close();
  return capture;
}
