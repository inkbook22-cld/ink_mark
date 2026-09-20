/**
 * 작업 프로세스 — API 호출과 파이프라인이 여기서 돈다.
 *
 * 화면(렌더러)과 분리한 이유는 두 가지다.
 * 1. 원고·이미지 생성은 수십 초가 걸린다. 화면 프로세스에서 돌리면 UI 가 멈춘다.
 * 2. API 키가 화면 프로세스에 절대 올라가지 않는다.
 *
 * 카드 렌더는 BrowserWindow 가 필요한데 그건 메인 프로세스에만 있다.
 * 그래서 렌더 요청만 메인으로 되돌려 보낸다(capture RPC).
 */

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { Store } from '../src/jobs/store.mjs';
import { runPipeline } from '../src/jobs/runner.mjs';
import { OpenAIProvider } from '../src/providers/openai.mjs';
import { GeminiImageProvider } from '../src/providers/gemini.mjs';
import { MockProvider } from '../src/providers/mock.mjs';
import { mergeBundle, editByUser, describeLocks } from '../src/core/field.mjs';
import { validateBundle } from '../src/checks/validate.mjs';
import { estimateBeforeRun } from '../src/providers/cost.mjs';
import { saveDraft, loadProfile } from '../src/publish/naver/uploader.mjs';
import { openSession, ensureLoggedIn } from '../src/publish/naver/session.mjs';

let store = null;
let config = null;
let keys = {};
let paths = {};

// ── 메인과의 RPC ────────────────────────────────────────────────
const pending = new Map();
let seq = 0;

/** 메인에 무언가를 시키고 답을 기다린다 (지금은 카드 렌더뿐). */
function callMain(method, payload) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.parentPort.postMessage({ type: 'rpc', id, method, payload });
  });
}

const send = (msg) => process.parentPort.postMessage(msg);
const progress = (jobId, text) => send({ type: 'progress', jobId, text });

/** 파이프라인이 쓰는 캡처 함수 — 실제 렌더는 메인이 한다. */
const capture = async (req) => {
  const { buffer, ready } = await callMain('capture', req);
  return { buffer: Buffer.from(buffer), ready };
};

process.parentPort.on('message', async (e) => {
  const msg = e.data;

  if (msg.type === 'rpc-result') {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.reject(new Error(msg.error));
    else p?.resolve(msg.result);
    return;
  }

  if (msg.type !== 'call') return;
  try {
    const result = await handle(msg.method, msg.payload ?? {});
    send({ type: 'result', id: msg.id, result });
  } catch (err) {
    send({ type: 'result', id: msg.id, error: String(err?.userMessage ?? err?.message ?? err) });
  }
});

// ── 기능 ────────────────────────────────────────────────────────
async function handle(method, p) {
  switch (method) {
    case 'init': {
      paths = p.paths;
      keys = p.keys ?? {};
      config = JSON.parse(await readFile(new URL('../config/providers.json', import.meta.url), 'utf8'));
      store = new Store(path.join(paths.userData, 'ink.db'));
      // 비정상 종료로 남은 유료 요청을 정리한다. 자동 재발행은 하지 않는다.
      const orphaned = store.markOrphanedCalls();
      return { ok: true, orphaned, unknownCalls: store.listUnknownCalls() };
    }

    case 'keys:update':
      keys = p.keys ?? {};
      return { ok: true };

    case 'brands:list':
      return store.listBrands();

    case 'brands:save':
      return { id: store.saveBrand(p.brand) };

    case 'estimate':
      return estimateBeforeRun({
        config,
        cardCount: p.cardCount ?? 7,
        providedPhotos: p.providedPhotos ?? 0,
      });

    case 'generate': {
      const brand = store.getBrand(p.brandId);
      if (!brand) throw new Error('브랜드를 찾을 수 없습니다.');

      const projectDir = path.join(paths.userData, 'projects', String(Date.now()));
      await mkdir(projectDir, { recursive: true });
      const projectId = store.createProject({
        brandId: p.brandId,
        title: (p.source?.split('\n').find((l) => l.trim()) ?? '새 프로젝트').slice(0, 40),
        dir: projectDir,
        budgetUsd: p.budgetUsd ?? null,
      });

      const { text, image, mocked } = providers(p.imageProvider);
      const jobId = store.createJob(projectId, 'generate');

      const result = await runPipeline({
        store, projectId, jobId, brand, config, projectDir,
        brief: { source: p.source ?? '', cardCount: p.cardCount ?? 7, photos: p.photos ?? [], audience: brand.audience },
        text, image, capture,
        budgetUsd: p.budgetUsd,
        onProgress: (s) => progress(jobId, s),
      });

      return { ...result, projectId, projectDir, mocked, bundle: result.bundle };
    }

    /**
     * 재생성 — D4. mode 는 'photo' | 'text' | 'all'.
     * 병합 규칙은 field.mjs 가 갖고 있고 여기서는 호출만 한다.
     */
    case 'regenerate': {
      const project = store.getProject(p.projectId);
      const brand = store.getBrand(project.brand_id);
      const current = store.getBundle(p.projectId);
      if (!current) throw new Error('프로젝트 내용을 찾을 수 없습니다.');

      const { text, image } = providers(p.imageProvider);
      const jobId = store.createJob(p.projectId, `regenerate:${p.mode}`);

      // 문구 재생성이면 새 원고를 받고, 사진만이면 기존 문구를 그대로 두고 이미지만 다시 만든다
      let incoming = current;
      if (p.mode !== 'photo') {
        const { content } = await text.generateContent({
          brand,
          brief: { source: p.source ?? '', cardCount: current.instagram.cards.length, audience: brand.audience },
        });
        const { toBundle } = await import('../src/core/bundle.mjs');
        incoming = toBundle(content);
      }

      const { merged, report } = mergeBundle(current, incoming, p.mode);

      // 사진을 다시 만들어야 하면 해당 경로를 비워 파이프라인이 채우게 한다
      if (p.mode === 'photo' || p.mode === 'all') {
        for (const c of merged.instagram.cards) c.photo.value = null;
        for (const im of merged.blog.images) im.path.value = null;
      }
      store.saveBundle(p.projectId, merged, `재생성(${p.mode})`);

      const result = await runPipeline({
        store, projectId: p.projectId, jobId, brand, config, projectDir: project.dir,
        brief: { source: p.source ?? '', cardCount: merged.instagram.cards.length },
        text, image, capture,
        onProgress: (s) => progress(jobId, s),
      });

      return { ...result, mergeReport: report };
    }

    /** 사용자가 직접 고친 값. 이 순간부터 그 필드는 잠긴다 — D4 규칙 1. */
    case 'field:edit': {
      const bundle = store.getBundle(p.projectId);
      const target = resolvePath(bundle, p.path);
      if (!target) throw new Error(`필드를 찾을 수 없습니다: ${p.path}`);
      target.parent[target.key] = editByUser(target.parent[target.key], p.value);
      store.saveBundle(p.projectId, bundle, `수정: ${p.path}`);
      return { bundle };
    }

    case 'locks:describe':
      return { message: describeLocks(store.getBundle(p.projectId), p.mode) };

    case 'bundle:get':
      return { bundle: store.getBundle(p.projectId, p.version ?? null), versions: store.listBundleVersions(p.projectId) };

    /** 되돌리기 — 직전 버전을 새 버전으로 다시 쌓는다(이력을 지우지 않는다). */
    case 'bundle:revert': {
      const target = store.getBundle(p.projectId, p.version);
      if (!target) throw new Error('해당 버전을 찾을 수 없습니다.');
      store.saveBundle(p.projectId, target, `되돌리기 → v${p.version}`);
      return { bundle: target };
    }

    case 'validate': {
      const bundle = store.getBundle(p.projectId);
      const project = store.getProject(p.projectId);
      const brand = store.getBrand(project.brand_id);
      return validateBundle(bundle, { brand, missingInfo: bundle.missingInfo });
    }

    /** 네이버 임시저장. 실패해도 던지지 않고 상태로 돌려준다 — 화면은 내보내기로 안내한다(D1). */
    case 'naver:draft': {
      const project = store.getProject(p.projectId);
      const bundle = store.getBundle(p.projectId);
      const profile = await loadProfile();
      const { blogMarkdownWithImages } = await import('../src/core/bundle.mjs');

      const { context, page } = await openSession({
        profileDir: path.join(paths.userData, 'browser', p.blogId),
      });
      try {
        await ensureLoggedIn(page, profile, { onWaiting: () => progress(null, '로그인 대기 중') });
        return await saveDraft(page, {
          blogId: p.blogId,
          title: bundle.blog.title.value,
          markdown: blogMarkdownWithImages(bundle, { relative: false }),
          imageBase: path.join(project.dir, 'generated'),
          typeMode: p.typeMode ?? 'key',
          onProgress: (s) => progress(null, s),
        }, profile);
      } finally {
        await context.close();
      }
    }

    default:
      throw new Error(`알 수 없는 요청: ${method}`);
  }
}

/** 공급자 선택. 자동 전환은 하지 않는다 — 사용자가 고른 것만 쓴다. */
function providers(imageProvider) {
  if (!keys.openai) {
    const mock = new MockProvider({ config });
    return { text: mock, image: mock, mocked: true };
  }
  const openai = new OpenAIProvider({ apiKey: keys.openai, config });
  const image =
    imageProvider === 'gemini' && keys.gemini
      ? new GeminiImageProvider({ apiKey: keys.gemini, config })
      : openai;
  return { text: openai, image, mocked: false };
}

/** 'instagram.cards.c2.headline' 같은 경로를 실제 객체로 푼다. */
function resolvePath(root, dotted) {
  const parts = dotted.split('.');
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (Array.isArray(node)) node = node.find((x) => x.id === key) ?? node[Number(key)];
    else node = node?.[key];
    if (!node) return null;
  }
  return { parent: node, key: parts.at(-1) };
}
