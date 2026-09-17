#!/usr/bin/env node
/**
 * 1단계 연동 검증 — MVP의 전제가 실제로 성립하는지 확인한다.
 *
 * 확인 목적: "OpenAI 키 하나로 전체 제작이 가능하다"는 전제는 사용자 환경에 따라
 * 깨질 수 있다. 앱을 다 만든 뒤에 알게 되면 설정 화면·온보딩·오류 처리를 전부
 * 다시 설계해야 하므로 착수 전에 확인한다.
 *
 * 사용:
 *   OPENAI_API_KEY=sk-... [GEMINI_API_KEY=...] node scripts/verify-providers.mjs
 *
 * 유료 호출이 발생한다. 전부 실행 시 이미지 3장 + 텍스트 1회로 대략 $0.15 내외.
 * 생성물은 scripts/out/ 에 저장되며 .gitignore 되어 있다.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const OUT = new URL('./out/', import.meta.url);
const cfg = JSON.parse(await readFile(new URL('../config/providers.json', import.meta.url), 'utf8'));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const results = [];
function record(id, name, status, detail) {
  results.push({ id, name, status, detail });
  const mark = { pass: '  PASS', fail: '  FAIL', warn: '  WARN', skip: '  SKIP' }[status];
  console.log(`${mark}  ${id}  ${name}`);
  if (detail) console.log(`        ${String(detail).split('\n').join('\n        ')}`);
}

/** 이미지 생성 프롬프트에는 글자를 절대 요구하지 않는다. 문구는 앱이 합성한다. */
const BG_PROMPT =
  'A warm, softly lit photograph of a small neighborhood bakery counter, ' +
  'shallow depth of field, natural window light, muted earth tones, ' +
  'empty negative space in the upper third. No text, no letters, no signage, no watermark.';

async function openaiImage({ size, quality = cfg.image.openai.quality, label }) {
  const model = cfg.image.openai.model;
  const t0 = performance.now();
  const res = await fetch(cfg.image.openai.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, prompt: BG_PROMPT, size, quality, n: 1 }),
  });
  const ms = Math.round(performance.now() - t0);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body, ms, label, size, quality, model };
}

async function saveB64(name, b64) {
  await mkdir(OUT, { recursive: true });
  await writeFile(new URL(name, OUT), Buffer.from(b64, 'base64'));
}

// ---------------------------------------------------------------------------
// T1. gpt-image-2 호출이 403(조직 미인증) 없이 되는가
//     → MVP 대전제 "OpenAI 키 하나면 된다"의 성립 여부
// ---------------------------------------------------------------------------
let t1ok = false;
if (!OPENAI_KEY) {
  record('T1', 'OpenAI 이미지 생성 접근', 'skip', 'OPENAI_API_KEY 없음');
} else {
  const r = await openaiImage({ size: cfg.image.openai.size, label: 'native-portrait' });
  if (r.ok) {
    t1ok = true;
    const b64 = r.body?.data?.[0]?.b64_json;
    if (b64) await saveB64('T1-native-portrait.png', b64);
    record('T1', 'OpenAI 이미지 생성 접근', 'pass',
      `${r.model} / ${r.size} / ${r.quality} / ${r.ms}ms` + (b64 ? '\n→ scripts/out/T1-native-portrait.png' : ''));
  } else if (r.status === 403) {
    record('T1', 'OpenAI 이미지 생성 접근', 'fail',
      `403 — 조직 인증(Organization Verification) 문제로 보인다.\n` +
      `메시지: ${r.body?.error?.message ?? '(없음)'}\n` +
      `→ 이 경우 "OpenAI 키 하나로 전체 제작"이 성립하지 않는다.\n` +
      `   온보딩에 인증 안내 화면을 넣거나 Gemini를 이미지 기본값으로 돌려야 한다.`);
  } else {
    record('T1', 'OpenAI 이미지 생성 접근', 'fail',
      `HTTP ${r.status}: ${r.body?.error?.message ?? JSON.stringify(r.body).slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// T2. 카드 비율(4:5)이 네이티브로 나오는가, 크롭이 필요한가
//     → 크롭이 필요하면 구도 프롬프트를 다르게 써야 하므로 먼저 안다
// ---------------------------------------------------------------------------
if (!t1ok) {
  record('T2', '카드 비율 4:5 네이티브 지원', 'skip', 'T1 미통과');
} else {
  // 1088x1360 = 정확히 4:5 이면서 양변이 16의 배수.
  // 통하면 Sharp 다운스케일만으로 1080x1350 이 나온다.
  const r = await openaiImage({ size: '1088x1360', label: 'custom-4x5' });
  if (r.ok) {
    const b64 = r.body?.data?.[0]?.b64_json;
    if (b64) await saveB64('T2-custom-4x5.png', b64);
    record('T2', '카드 비율 4:5 네이티브 지원', 'pass',
      `1088x1360 커스텀 해상도 수락됨 (${r.ms}ms)\n` +
      `→ config/providers.json 의 image.openai.size 를 1088x1360 으로 변경하고,\n` +
      `   Sharp 로 1080x1350 다운스케일만 한다. 크롭 로직 불필요.`);
  } else {
    record('T2', '카드 비율 4:5 네이티브 지원', 'warn',
      `1088x1360 거부됨 (HTTP ${r.status}: ${r.body?.error?.message ?? ''})\n` +
      `→ 네이티브 세로(${cfg.image.openai.size}, 2:3)로 생성 후 4:5 로 크롭해야 한다.\n` +
      `   위아래가 잘리므로 프롬프트에 "피사체를 중앙에" 조건을 넣어야 한다.`);
  }
}

// ---------------------------------------------------------------------------
// T3. 응답에서 사용량을 읽어 비용을 역산할 수 있는가
//     → 비용 표시 기능 전체의 전제
// ---------------------------------------------------------------------------
{
  const last = results.find((r) => r.id === 'T1' && r.status === 'pass');
  if (!last) {
    record('T3', '사용량(usage) 회수', 'skip', 'T1 미통과');
  } else {
    // T1 응답을 다시 쓰지 않고 별도 확인이 필요하면 여기에서 usage 키를 덤프한다.
    record('T3', '사용량(usage) 회수', 'warn',
      'T1 응답의 usage 필드를 직접 확인할 것.\n' +
      'usage 가 없으면 비용은 "장수 × 단가표"로만 추정해야 하며,\n' +
      '화면 문구를 그에 맞게(더 느슨하게) 써야 한다.');
  }
}

// ---------------------------------------------------------------------------
// T4. 참조 이미지 입력(사용자 사진 기반 변형)이 되는가
//     → "사진만 넣어도 생성" 시나리오의 전제
// ---------------------------------------------------------------------------
record('T4', '참조 이미지 입력(편집 엔드포인트)', 'skip',
  '사용자 사진 샘플이 필요하다. scripts/out/T1-native-portrait.png 를 입력으로\n' +
  '/v1/images/edits 를 호출해 수동 확인할 것.');

// ---------------------------------------------------------------------------
// T5. 한국에서의 지연시간이 실사용 가능한가
//     → 1프로젝트 최대 11장. 장당 대기시간 × 11 이 사용자 체감이 된다.
// ---------------------------------------------------------------------------
{
  const timed = results.filter((r) => r.status === 'pass' && /\d+ms/.test(r.detail ?? ''));
  if (!timed.length) {
    record('T5', '지연시간', 'skip', '측정된 호출 없음');
  } else {
    const ms = timed.map((r) => Number(/(\d+)ms/.exec(r.detail)[1]));
    const avg = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length);
    record('T5', '지연시간', avg > 30000 ? 'warn' : 'pass',
      `평균 ${avg}ms / 장 → 11장 기준 약 ${Math.round((avg * 11) / 1000)}초.\n` +
      (avg > 30000 ? '진행률 표시와 백그라운드 실행이 필수다.' : '순차 실행으로도 견딜 만하다.'));
  }
}

// ---------------------------------------------------------------------------
// T6. 대체 공급자(Gemini)가 실제로 살아있는가
//     → 모델 은퇴·403·가격 인상에 대한 공통 보험
// ---------------------------------------------------------------------------
if (!GEMINI_KEY) {
  record('T6', 'Gemini 대체 경로', 'skip', 'GEMINI_API_KEY 없음 (선택 사항)');
} else {
  const model = cfg.image.gemini.model;
  const url = `${cfg.image.gemini.endpoint}/${model}:generateContent`;
  const t0 = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: BG_PROMPT }] }] }),
  });
  const ms = Math.round(performance.now() - t0);
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    const part = body?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (part) await saveB64('T6-gemini.png', part.inlineData.data);
    record('T6', 'Gemini 대체 경로', 'pass', `${model} / ${ms}ms` + (part ? '\n→ scripts/out/T6-gemini.png' : ''));
  } else {
    record('T6', 'Gemini 대체 경로', 'fail',
      `HTTP ${res.status}: ${body?.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n' + '─'.repeat(64));
const tally = results.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
console.log(`pass ${tally.pass ?? 0} / fail ${tally.fail ?? 0} / warn ${tally.warn ?? 0} / skip ${tally.skip ?? 0}`);
if (tally.fail) {
  console.log('\nFAIL 이 있으면 2단계(제작 MVP)로 넘어가기 전에 전제를 고쳐야 한다.');
  process.exitCode = 1;
}
