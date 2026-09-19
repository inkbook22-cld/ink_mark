/**
 * 저장소 — 특히 유료 호출 장부가 중복 결제를 막는지 확인한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/jobs/store.mjs';

const newStore = () => new Store(path.join(mkdtempSync(path.join(tmpdir(), 'ink-')), 'ink.db'));

test('같은 요청을 다시 보내지 않는다 (재시작 후 중복 결제 방지)', () => {
  const s = newStore();
  const projectId = s.createProject({ brandId: 'b1', title: 'p', dir: '/tmp/p' });
  const jobId = s.createJob(projectId, 'generate');

  const key = 'img:card3:v1';
  const first = s.beginCall({ jobId, provider: 'openai', model: 'gpt-image-2', kind: 'image', idempotencyKey: key });
  assert.equal(first.reused, false);
  s.endCall(first.id, { status: 'done', usage: { tokens: 100 }, costUsd: 0.041 });

  // 앱이 재시작돼 같은 단계를 다시 돌더라도 돈을 또 쓰지 않는다
  const second = s.beginCall({ jobId, provider: 'openai', model: 'gpt-image-2', kind: 'image', idempotencyKey: key });
  assert.equal(second.reused, true, '이미 성공한 호출을 재사용하지 않았다');
  assert.equal(s.spentUsd([jobId]), 0.041, '비용이 두 번 계산됐다');
  s.close();
});

test('응답을 못 받은 호출은 unknown 으로 남고 자동 재발행되지 않는다', () => {
  const s = newStore();
  const projectId = s.createProject({ brandId: 'b1', title: 'p', dir: '/tmp/p' });
  const jobId = s.createJob(projectId, 'generate');

  // 호출 직전 pending 기록 → 여기서 앱이 죽었다고 가정
  s.beginCall({ jobId, provider: 'openai', model: 'gpt-image-2', kind: 'image', idempotencyKey: 'img:card4' });

  const orphaned = s.markOrphanedCalls();
  assert.equal(orphaned, 1);

  const unknown = s.listUnknownCalls();
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].kind, 'image');

  // 비용에는 잡히지 않는다 (성공 여부를 모르므로)
  assert.equal(s.spentUsd([jobId]), 0);
  s.close();
});

test('완료한 단계는 재시작 후 건너뛴다', () => {
  const s = newStore();
  const projectId = s.createProject({ brandId: 'b1', title: 'p', dir: '/tmp/p' });
  const jobId = s.createJob(projectId, 'generate');

  const step = s.startStep(jobId, 'text');
  s.finishStep(step, 'done');

  assert.equal(s.isStepDone(jobId, 'text'), true);
  assert.equal(s.isStepDone(jobId, 'images'), false);
  s.close();
});

test('묶음 버전이 쌓여 되돌리기가 가능하다', () => {
  const s = newStore();
  const projectId = s.createProject({ brandId: 'b1', title: 'p', dir: '/tmp/p' });

  assert.equal(s.saveBundle(projectId, { v: 1 }, '최초 생성'), 1);
  assert.equal(s.saveBundle(projectId, { v: 2 }, '사진만 다시'), 2);

  assert.deepEqual(s.getBundle(projectId), { v: 2 });
  assert.deepEqual(s.getBundle(projectId, 1), { v: 1 }, '직전 버전을 못 불러왔다');
  assert.equal(s.listBundleVersions(projectId).length, 2);
  s.close();
});

test('산출물은 해시와 크기로 기록된다', () => {
  const s = newStore();
  const projectId = s.createProject({ brandId: 'b1', title: 'p', dir: '/tmp/p' });
  s.recordArtifact({ projectId, kind: 'card', relPath: 'cards/01.png', buffer: Buffer.from('fake png') });

  const [a] = s.listArtifacts(projectId);
  assert.equal(a.rel_path, 'cards/01.png');
  assert.equal(a.bytes, 8);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  s.close();
});
