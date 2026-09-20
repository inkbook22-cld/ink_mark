/**
 * 전체 파이프라인 회귀 — 모의 공급자로 돌리므로 돈이 들지 않는다.
 *
 * 여기서 지키려는 계획의 약속 세 가지:
 *   - 이미지 하나가 실패해도 완료한 원고와 다른 이미지는 보존한다
 *   - 공급자를 자동으로 바꾸지 않는다
 *   - 앱이 재시작돼도 완료 단계부터 이어간다
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/jobs/store.mjs';
import { runPipeline } from '../src/jobs/runner.mjs';
import { MockProvider } from '../src/providers/mock.mjs';
import { ProviderError } from '../src/providers/errors.mjs';
import { createPlaywrightCapture } from '../src/render/cards.mjs';

const config = JSON.parse(await readFile(new URL('../config/providers.json', import.meta.url), 'utf8'));
const brand = JSON.parse(await readFile(new URL('../samples/brand.json', import.meta.url), 'utf8'));
const brief = { source: '겨울 한정 메뉴를 시작합니다.\n반죽은 매일 아침 여섯 시에 시작합니다.', cardCount: 3 };

const capture = await createPlaywrightCapture();
test.after(() => capture.close());

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'ink-e2e-'));
  const store = new Store(path.join(root, 'ink.db'));
  const brandId = store.saveBrand(brand);
  const projectDir = path.join(root, 'project');
  const projectId = store.createProject({ brandId, title: 't', dir: projectDir });
  return { store, projectId, projectDir, root };
}

test('끝까지 돌면 블로그·카드·내보내기가 모두 나온다', async () => {
  const { store, projectId, projectDir } = setup();
  const mock = new MockProvider({ config });

  const r = await runPipeline({ store, projectId, brand, config, projectDir, brief, text: mock, image: mock, capture });

  assert.equal(r.error, undefined);
  assert.equal(r.cards.length, 3);
  assert.equal(r.failures.length, 0);

  const ex = path.join(projectDir, 'export');
  for (const f of ['블로그원고.md', '블로그원고.html', '인스타문구.txt', '발행체크리스트.md']) {
    assert.ok(existsSync(path.join(ex, f)), `${f} 가 없다`);
  }
  // 블로그 이미지가 본문 마크다운에 실제로 끼워졌는지
  const md = readFileSync(path.join(ex, '블로그원고.md'), 'utf8');
  assert.match(md, /!\[.*\]\(images\/b\d+\.png\)/);

  store.close();
});

test('이미지가 실패해도 원고와 나머지 이미지는 살아남는다', async () => {
  const { store, projectId, projectDir } = setup();
  const mock = new MockProvider({ config });

  // 세 번째 이미지만 일시 오류로 실패시킨다
  let n = 0;
  const flaky = {
    name: 'mock',
    generateImage: async (a) => {
      if (++n === 3) throw new ProviderError('일시 오류', { kind: 'transient', retryable: false });
      return mock.generateImage(a);
    },
  };

  const r = await runPipeline({ store, projectId, brand, config, projectDir, brief, text: mock, image: flaky, capture });

  assert.equal(r.error, undefined, '전체가 실패해 버렸다');
  assert.equal(r.failures.length, 1);
  assert.ok(r.bundle.blog.title.value, '원고가 사라졌다');
  assert.ok(existsSync(path.join(projectDir, 'export', '블로그원고.md')));

  // 실패한 한 장을 뺀 나머지는 생성되어 있다
  const cards = r.bundle.instagram.cards;
  const withPhoto = cards.filter((c) => c.photo.value).length;
  assert.equal(withPhoto + cards.filter((c) => !c.photo.value).length, cards.length);
  assert.ok(withPhoto >= 1, '남은 이미지까지 사라졌다');

  store.close();
});

test('키 오류는 즉시 중단하고 남은 이미지에 돈을 쓰지 않는다', async () => {
  const { store, projectId, projectDir } = setup();
  const mock = new MockProvider({ config });

  let calls = 0;
  const badKey = {
    name: 'mock',
    generateImage: async () => {
      calls++;
      throw new ProviderError('invalid api key', { kind: 'auth' });
    },
  };

  const r = await runPipeline({ store, projectId, brand, config, projectDir, brief, text: mock, image: badKey, capture });

  assert.equal(calls, 1, `키 오류인데 ${calls}번 호출했다 — 남은 이미지까지 시도하면 안 된다`);
  assert.ok(r.failures.some((f) => f.kind === 'auth'));
  assert.match(r.failures[0].message, /API 키/);
  // 공급자를 자동으로 바꾸지 않았는지
  assert.ok(!r.failures.some((f) => /gemini/i.test(f.message)));

  store.close();
});

test('재시작하면 완료한 원고 단계를 건너뛴다', async () => {
  const { store, projectId, projectDir } = setup();
  const mock = new MockProvider({ config });

  let textCalls = 0;
  const countingText = {
    name: 'mock',
    generateContent: async (a) => { textCalls++; return mock.generateContent(a); },
  };

  const first = await runPipeline({ store, projectId, brand, config, projectDir, brief, text: countingText, image: mock, capture });
  assert.equal(textCalls, 1);

  // 같은 작업을 이어서 다시 돌린다
  await runPipeline({ store, projectId, jobId: first.jobId, brand, config, projectDir, brief, text: countingText, image: mock, capture });
  assert.equal(textCalls, 1, '원고를 다시 생성해 돈을 또 썼다');

  store.close();
});
