#!/usr/bin/env node
/**
 * 업로더 회귀 테스트 — 실제 네이버가 아니라 로컬 목업(scripts/mock/)을 상대로 돌린다.
 *
 * 목업은 진짜 스마트에디터가 아니다. 이 테스트가 검증하는 것은 "네이버에서 동작한다"가
 * 아니라 아래 네 가지다. 셀렉터가 실제와 맞는지는 사람이 한 번 확인해야 한다
 * (profile.json 의 verifiedAt 참고).
 *
 *   1. 한글이 타이핑으로(붙여넣기 없이) 실제로 입력되는가
 *   2. 문단 구분이 Enter 로 제대로 나뉘는가
 *   3. 이미지가 파일 선택 대화상자를 통해 들어가는가
 *   4. 저장 후 다시 열어 검증하는 흐름이 동작하는가
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { saveDraft, loadProfile } from '../src/publish/naver/uploader.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOCK = path.join(ROOT, 'scripts/mock');

// 목업을 http 로 띄운다. file:// 는 localStorage 가 막혀 저장·복원 재현이 안 된다.
const server = createServer(async (req, res) => {
  const name = (req.url.split('?')[0] || '/').replace(/^\//, '') || 'editor.html';
  try {
    const buf = await readFile(path.join(MOCK, name));
    res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = await loadProfile();
// 목업용 주소 치환. 셀렉터·타이밍은 실제 프로필 그대로 쓴다.
profile.urls.write = `${base}/editor.html`;
profile.urls.drafts = `${base}/editor.html?restore=1`;

const MARKDOWN = `
## 겨울 한정 메뉴를 시작합니다

매일 아침 여섯 시에 반죽을 시작합니다. 발효는 열두 시간, 굽는 시간은 스물다섯 분입니다.

재료와 굽는 시간까지 **그대로** 적어두었습니다. 문의는 [프로필 링크](https://example.com)로 남겨주세요.

![매장 외관](card-preview.png)

- 영업시간 오전 8시 ~ 오후 7시
- 매주 월요일 휴무
`.trim();

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'ko-KR' });

const steps = [];
const result = await saveDraft(
  page,
  {
    blogId: 'mockblog',
    title: '겨울 한정 메뉴 안내',
    markdown: MARKDOWN,
    imageBase: path.join(ROOT, 'scripts/out'),
    typeMode: process.env.TYPE_MODE === 'ime' ? 'ime' : 'key',
    onProgress: (s) => steps.push(s),
  },
  profile,
);

// 실제로 들어간 내용을 읽어 확인한다
const frame = page.frameLocator(profile.editorFrame);
const gotTitle = (await frame.locator(profile.selectors.titleInput).first().innerText()).trim();
const gotBody = (await frame.locator(profile.selectors.bodyArea).first().innerText()).trim();
const gotImages = await frame.locator(`${profile.selectors.bodyArea} img`).count();

await browser.close();
server.close();

// ── 판정 ────────────────────────────────────────────────────────
const checks = [
  ['제목이 타이핑됨', gotTitle === '겨울 한정 메뉴 안내', gotTitle],
  ['한글 본문이 들어감', gotBody.includes('매일 아침 여섯 시에 반죽을 시작합니다'), gotBody.slice(0, 40)],
  ['문단이 분리됨', gotBody.split('\n').filter((l) => l.trim()).length >= 4, `${gotBody.split('\n').filter((l) => l.trim()).length}개 문단`],
  ['마크다운 기호가 남지 않음', !/\*\*|^##\s/m.test(gotBody), gotBody.match(/\*\*|^##\s/m)?.[0] ?? '없음'],
  ['목록이 가운뎃점으로 변환됨', gotBody.includes('· 영업시간'), gotBody.includes('· 영업시간') ? 'ok' : '변환 안 됨'],
  ['이미지가 업로드됨', gotImages >= 1, `${gotImages}장`],
  ['저장 후 검증 통과', result.status === '저장 확인됨', result.status],
];

console.log(`\n타이핑 모드: ${process.env.TYPE_MODE === 'ime' ? 'ime (조합 이벤트)' : 'key (기본)'}\n`);
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`);
  if (!ok) failed++;
}
console.log(`\n상태: ${result.status}`);
console.log(`집계: ${JSON.stringify(result.counts)}`);
if (result.issues.length) console.log(`지적:\n  - ${result.issues.join('\n  - ')}`);
console.log(`\n단계: ${steps.length}개`);

if (failed) {
  console.log(`\n${failed}개 실패`);
  process.exitCode = 1;
}
