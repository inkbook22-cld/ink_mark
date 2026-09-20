#!/usr/bin/env node
/**
 * 전체 생성 파이프라인 CLI.
 *
 *   node scripts/generate.mjs --brand samples/brand.json --input samples/글감.txt [--mock] [--cards 7]
 *
 * --mock 을 주면 API 키 없이 돈다. 파이프라인 문제와 모델 품질 문제를 분리해서
 * 볼 수 있고, 회귀 테스트도 돈을 쓰지 않는다.
 */

import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/jobs/store.mjs';
import { runPipeline } from '../src/jobs/runner.mjs';
import { OpenAIProvider } from '../src/providers/openai.mjs';
import { GeminiImageProvider } from '../src/providers/gemini.mjs';
import { MockProvider } from '../src/providers/mock.mjs';
import { createPlaywrightCapture } from '../src/render/cards.mjs';
import { formatIssues } from '../src/checks/validate.mjs';

const args = parseArgs(process.argv.slice(2));
const config = JSON.parse(await readFile(new URL('../config/providers.json', import.meta.url), 'utf8'));
const brand = JSON.parse(await readFile(args.brand ?? 'samples/brand.json', 'utf8'));
const source = args.input ? await readFile(args.input, 'utf8') : '';

const root = args.root ?? path.join(os.homedir(), '.ink');
const store = new Store(path.join(root, 'ink.db'));

// 비정상 종료로 남은 pending 호출을 정리한다. 자동 재발행은 하지 않는다.
const orphaned = store.markOrphanedCalls();
if (orphaned) {
  console.log(`\n주의: 성공 여부를 알 수 없는 유료 요청 ${orphaned}건이 있습니다.`);
  console.log('      자동으로 다시 보내지 않습니다. 공급자 사용량 페이지에서 확인해 주세요.\n');
}

const useMock = Boolean(args.mock) || !process.env.OPENAI_API_KEY;
if (useMock && !args.mock) {
  console.log('OPENAI_API_KEY 가 없어 모의 공급자로 돌립니다. 실제 호출을 하려면 키를 설정하세요.\n');
}

const brandId = store.saveBrand(brand);
const title = (source.split('\n').find((l) => l.trim()) ?? '새 프로젝트').slice(0, 40);
const projectDir = path.join(root, 'projects', `${Date.now()}`);
await mkdir(projectDir, { recursive: true });
const projectId = store.createProject({ brandId, title, dir: projectDir, budgetUsd: args.budget ? Number(args.budget) : null });

const mock = new MockProvider({ config });
const text = useMock ? mock : new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, config });
const image = useMock
  ? mock
  : args.gemini && process.env.GEMINI_API_KEY
    ? new GeminiImageProvider({ apiKey: process.env.GEMINI_API_KEY, config })
    : new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, config });

const capture = await createPlaywrightCapture();

let result;
try {
  result = await runPipeline({
    store, projectId, brand, config, projectDir,
    brief: { source, cardCount: Number(args.cards ?? 7), purpose: args.purpose, audience: brand.audience },
    text, image, capture,
    budgetUsd: args.budget ? Number(args.budget) : undefined,
    onProgress: (s) => process.stdout.write(`\r  ${s}${' '.repeat(30)}`),
  });
} finally {
  await capture.close();
}

console.log('\n');
console.log('─'.repeat(64));

if (result.error) {
  console.log(`\n실패: ${result.error}`);
  console.log('여기까지 만든 결과는 보존되어 있습니다:', projectDir);
  store.close();
  process.exit(1);
}

console.log(`\n프로젝트: ${projectDir}`);
console.log(`카드 ${result.cards.length}장 · 블로그 ${result.counts.blogChars}자 · 캡션 ${result.counts.captionChars}자 · 해시태그 ${result.counts.hashtags}개`);
console.log(`비용: 실제 $${result.costUsd} (예상 $${result.estimate.totalUsd}) — 추정치입니다`);

if (result.failures.length) {
  console.log('\n실패한 항목 (나머지는 그대로 보존됩니다):');
  for (const f of result.failures) console.log(`  - ${f.where}: ${f.message}`);
}

if (result.issues.length) {
  console.log('\n검사 결과:');
  console.log(formatIssues(result.issues));
}

console.log(`\n내보내기: ${result.exported.outDir}`);
console.log(`  파일 ${result.exported.written.length}개 — 발행체크리스트.md 부터 보세요.`);

store.close();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}
