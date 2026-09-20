#!/usr/bin/env node
/**
 * 화면 회귀 하네스 — 빌드된 UI 를 브라우저에 띄우고 화면을 남긴다.
 *
 * Electron 을 띄우지 않고 window.ink 를 가짜로 채운다. 덕분에 API 키도, 작업
 * 프로세스도 없이 화면만 따로 볼 수 있다. 제품 코드에 테스트용 분기를 넣지 않아도 된다.
 *
 *   node scripts/ui-preview.mjs [탭]   탭: create | result | brand | settings
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = path.join(ROOT, 'dist/ui');
const tab = process.argv[2] ?? 'result';
const out = path.join(ROOT, 'scripts/out', `ui-${tab}.png`);

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/ui 가 없다. npm run build:ui 먼저.');
  process.exit(2);
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const rel = (req.url.split('?')[0] || '/').replace(/^\//, '') || 'index.html';
  // /out/* 은 렌더된 카드 PNG. 미리보기에 실제 카드를 띄우기 위해 같이 서빙한다.
  const root = rel.startsWith('out/') ? path.join(ROOT, 'scripts') : DIST;
  try {
    const buf = await readFile(path.join(root, rel));
    res.writeHead(200, { 'Content-Type': types[path.extname(rel)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch(
  process.env.INK_CHROMIUM ? { executablePath: process.env.INK_CHROMIUM } : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });

// 화면이 실제로 부르는 함수만 채운다. 여기 없는 함수를 화면이 부르면 바로 드러난다.
await page.addInitScript(() => {
  const f = (value, locked = false) => ({ value, source: locked ? 'user' : 'ai', locked, editedAt: null, version: 1 });
  const card = (id, headline) => ({
    id, design: f('photo'), eyebrow: f('이번 주 신메뉴'), headline: f(headline),
    body: f('재료와 굽는 시간까지 그대로 적어두었습니다.'), photoPrompt: f('...'), photo: f('/tmp/x.png'),
  });
  const bundle = {
    schemaVersion: 1, missingInfo: ['가격'],
    blog: {
      title: f('겨울 한정 메뉴를 시작합니다'),
      // 사용자가 직접 고친 항목 — 잠금 표시가 화면에 뜨는지 본다
      bodyMarkdown: f('## 겨울 한정 메뉴\n\n매일 아침 여섯 시에 반죽을 시작합니다. 발효는 열두 시간, 굽는 시간은 스물다섯 분입니다.', true),
      images: [],
    },
    instagram: {
      cards: [card('c1', '겨울 한정 메뉴를 시작합니다'), card('c2', '발효는 열두 시간입니다'), card('c3', '당일 구운 것만 팝니다')],
      caption: f('겨울 한정 메뉴를 시작합니다.\n\n이음 베이커리에서 전해드립니다.'),
      hashtags: f(['동네빵집', '신메뉴', '발효빵']),
    },
  };
  const result = {
    projectId: 'p1', projectDir: '/tmp/p1', bundle,
    cards: bundle.instagram.cards.map((c, i) => {
      const design = ['photo', 'info', 'review'][i];
      return { cardId: c.id, design, path: `${location.origin}/out/card-${design}.png`, relPath: '' };
    }),
    issues: [
      { level: 'error', where: '카드 c2.headline', message: '글자가 잘립니다: "발효는 열두 시간입니다…"' },
      { level: 'warn', where: 'blog.body', message: '본문이 292자로 짧습니다 (권장 600자 이상).' },
      { level: 'info', where: '누락 정보', message: '가격 — 자료에 없어 원고에 넣지 않았습니다. 직접 채워 주세요.' },
    ],
    failures: [], costUsd: 0.412, estimate: { totalUsd: 0.481, imageCount: 11 },
    exported: { outDir: '/tmp/p1/export', written: new Array(15) },
  };

  window.ink = {
    listBrands: async () => [{ id: 'b1', name: '이음 베이커리', audience: '동네 30~40대', contact: '문의 · 프로필 링크', colors: { primary: '#2f4f3e', accent: '#c8794a' }, toneExamples: ['매일 아침 여섯 시에 반죽을 시작합니다.'], bannedWords: ['최고', '1등'], channels: {} }],
    saveBrand: async () => ({ id: 'b1' }),
    keyStatus: async () => ({ available: true, openai: { set: false, hint: null }, gemini: { set: false, hint: null } }),
    setKey: async () => ({ available: true, openai: { set: true, hint: '····abcd' }, gemini: { set: false, hint: null } }),
    estimate: async () => ({ totalUsd: 0.481, imageCount: 11, note: '추정치입니다. 공급자 청구액과 다를 수 있습니다.' }),
    generate: async () => result,
    regenerate: async () => result,
    describeLocks: async (_p, mode) => ({
      message: mode === 'photo'
        ? '문구는 모두 유지됩니다.'
        : '직접 수정하신 1개 항목은 유지됩니다. 사진은 그대로입니다.',
    }),
    editField: async () => ({ bundle }),
    getBundle: async () => ({ bundle, versions: [
      { version: 3, label: '재생성(photo)' }, { version: 2, label: '수정: blog.bodyMarkdown' }, { version: 1, label: '최초 생성' },
    ] }),
    revert: async () => ({ bundle }),
    validate: async () => ({ issues: result.issues, counts: {} }),
    naverDraft: async () => ({ status: '저장 확인됨', issues: [] }),
    openFolder: async () => '',
    onProgress: () => () => {},
    __seed: result,
  };
});

await page.goto(base);
await page.waitForSelector('.side');

if (tab !== 'create') {
  if (tab === 'result') {
    // 결과 탭은 생성 결과가 있어야 열린다 — 실제 흐름대로 만들기를 한 번 누른다
    await page.getByRole('button', { name: '전체 만들기' }).click();
  }
  const label = { result: '결과', brand: '브랜드', settings: '설정' }[tab];
  await page.locator('.side button', { hasText: label }).click();
}

await page.waitForTimeout(600);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
server.close();
console.log(`${tab} → ${out}`);
