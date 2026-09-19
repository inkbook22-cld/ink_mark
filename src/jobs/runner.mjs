/**
 * 전체 생성 파이프라인.
 *
 * 설계 원칙 네 가지:
 * 1. 단계마다 완료를 기록한다 → 앱이 죽어도 완료 단계부터 이어간다.
 * 2. 유료 호출은 보내기 '전에' 장부에 남긴다 → 중복 결제를 막는다.
 * 3. 이미지 하나가 실패해도 원고와 나머지 이미지는 보존한다.
 * 4. 공급자를 자동으로 바꾸지 않는다. 실패는 실패로 보고한다.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { toBundle } from '../core/bundle.mjs';
import { renderCards } from '../render/cards.mjs';
import { validateBundle } from '../checks/validate.mjs';
import { exportBundle } from '../export/exporter.mjs';
import { costOfImage, costOfText, estimateBeforeRun, checkBudget } from '../providers/cost.mjs';
import { ProviderError } from '../providers/errors.mjs';

const v = (f) => (f && typeof f === 'object' && 'value' in f ? f.value : f);

/**
 * @param {{store, projectId, jobId, brand, brief, text, image, capture, config,
 *          projectDir, budgetUsd?, onProgress?, signal?}} ctx
 */
export async function runPipeline(ctx) {
  const { store, projectId, brand, brief, config, projectDir, onProgress } = ctx;
  const log = (s) => onProgress?.(s);

  await mkdir(path.join(projectDir, 'generated'), { recursive: true });

  const jobId = ctx.jobId ?? store.createJob(projectId, 'generate');
  const result = { jobId, bundle: null, issues: [], failures: [], costUsd: 0, exported: null };

  // 시작 전에 예상 비용을 알려준다
  const estimate = estimateBeforeRun({
    config,
    cardCount: brief.cardCount ?? 7,
    providedPhotos: brief.photos?.length ?? 0,
  });
  result.estimate = estimate;
  log(`예상 비용 약 $${estimate.totalUsd} (이미지 ${estimate.imageCount}장) — 추정치입니다`);

  try {
    // ── 1. 원고 ──────────────────────────────────────────────
    let bundle = store.getBundle(projectId);
    if (!store.isStepDone(jobId, 'text') || !bundle) {
      const step = store.startStep(jobId, 'text');
      try {
        log('원고 생성 중');
        const res = await paidCall(ctx, {
          jobId, kind: 'text', provider: ctx.text.name, model: config.text.openai.model,
          key: `text:${projectId}:${hashOf(brief)}`,
          run: () => ctx.text.generateContent({ brand, brief, signal: ctx.signal }),
          cost: (r) => costOfText({ usage: r.usage }),
        });
        if (res.reused) {
          // 이미 결제된 원고 요청인데 결과가 저장되어 있지 않다. 자동 재발행하지 않는다.
          throw new ProviderError(
            '이전 실행에서 원고 요청이 이미 결제되었지만 결과가 저장되지 않았습니다. ' +
            '중복 결제를 피하기 위해 자동으로 다시 보내지 않습니다. 새 프로젝트로 다시 시작해 주세요.',
            { kind: 'invalid', retryable: false },
          );
        }
        const { content, usage, model } = res;
        bundle = toBundle(content);
        bundle.usage = { text: usage, model };
        store.saveBundle(projectId, bundle, '최초 생성');
        store.finishStep(step, 'done');
      } catch (err) {
        store.finishStep(step, 'failed', String(err?.message ?? err));
        throw err;
      }
    } else {
      log('원고는 이미 생성되어 있어 건너뜁니다');
    }

    // ── 2. 이미지 ────────────────────────────────────────────
    // 하나가 실패해도 나머지는 계속 만든다. 실패한 것만 나중에 재시도하면 된다.
    const step2 = store.startStep(jobId, 'images');
    const imageDir = path.join(projectDir, 'generated');
    let generated = 0;

    const targets = [
      ...bundle.blog.images.map((im) => ({ slot: im, kind: 'blog', prompt: v(im.prompt) })),
      ...bundle.instagram.cards.map((c) => ({ slot: c, kind: 'card', prompt: v(c.photoPrompt) })),
    ];

    for (const [i, target] of targets.entries()) {
      if (v(target.slot.path ?? target.slot.photo)) continue; // 이미 있는 것은 건너뛴다
      log(`이미지 ${i + 1}/${targets.length} 생성 중`);

      // 예산은 다음 요청 전에만 본다. 강제 한도가 아니라 안내다.
      const budget = checkBudget({
        budgetUsd: ctx.budgetUsd,
        spentUsd: store.spentUsd([jobId]),
        nextUsd: config.pricing.image[config.image.openai.model]?.[config.image.openai.quality] ?? 0,
      });
      if (!budget.ok) {
        result.failures.push({ where: `이미지 ${i + 1}`, message: budget.message, kind: 'budget' });
        break;
      }

      try {
        const res = await paidCall(ctx, {
          jobId, kind: 'image', provider: ctx.image.name, model: config.image[ctx.image.name]?.model,
          key: `image:${projectId}:${target.slot.id}:${hashOf(target.prompt)}`,
          run: () => ctx.image.generateImage({ prompt: target.prompt, signal: ctx.signal }),
          cost: (r) => costOfImage({ config, provider: ctx.image.name, model: r.model, usage: r.usage }),
        });

        if (res.reused) {
          // 이미 결제된 이미지인데 파일이 없다. 다시 돈을 쓰지 않고 사용자에게 알린다.
          result.failures.push({
            where: `${target.kind} ${target.slot.id}`,
            message: '이전 실행에서 이미 결제된 요청입니다. 중복 결제를 피하려고 다시 보내지 않았습니다. 이 항목만 따로 재생성해 주세요.',
            kind: 'already-paid',
          });
          continue;
        }

        const { buffer } = res;
        const file = path.join(imageDir, `${target.slot.id}.png`);
        await writeFile(file, buffer);
        store.recordArtifact({ projectId, kind: target.kind, relPath: `generated/${target.slot.id}.png`, buffer });

        // 생성 결과는 사용자가 손댄 적 없으므로 그대로 넣는다
        if (target.kind === 'blog') target.slot.path.value = file;
        else target.slot.photo.value = file;
        generated++;
      } catch (err) {
        // 이미지 실패는 파이프라인을 멈추지 않는다. 완료된 원고와 다른 이미지는 살린다.
        const message = err instanceof ProviderError ? err.userMessage : String(err?.message ?? err);
        result.failures.push({ where: `${target.kind} ${target.slot.id}`, message, kind: err?.kind ?? 'unknown' });
        log(`이미지 ${i + 1} 실패 — 계속 진행합니다`);

        // 키·잔액·권한 문제면 남은 이미지도 전부 같은 이유로 실패한다. 돈 낭비를 막는다.
        if (err instanceof ProviderError && ['auth', 'verification', 'quota'].includes(err.kind)) {
          result.failures.push({ where: '이미지 생성', message: '같은 원인으로 나머지 이미지 생성을 중단했습니다.', kind: err.kind });
          break;
        }
      }
    }

    store.finishStep(step2, result.failures.length ? 'partial' : 'done');
    store.saveBundle(projectId, bundle, `이미지 ${generated}장 생성`);

    // ── 3. 카드 렌더 ─────────────────────────────────────────
    const step3 = store.startStep(jobId, 'render');
    log('카드 렌더 중');
    const cardsWithPhoto = bundle.instagram.cards.filter((c) => v(c.photo));
    const { rendered, report } = await renderCards(cardsWithPhoto, {
      outDir: path.join(projectDir, 'cards'),
      brand,
      capture: ctx.capture,
      onProgress: log,
    });
    for (const r of rendered) {
      store.recordArtifact({ projectId, kind: 'card', relPath: r.relPath, buffer: Buffer.alloc(r.bytes) });
    }
    store.finishStep(step3, 'done');

    // ── 4. 검사 ──────────────────────────────────────────────
    const check = validateBundle(bundle, { brand, renderReport: report, missingInfo: bundle.missingInfo });
    result.issues = check.issues;
    result.counts = check.counts;

    // ── 5. 내보내기 ──────────────────────────────────────────
    const step5 = store.startStep(jobId, 'export');
    log('내보내는 중');
    result.exported = await exportBundle(bundle, {
      outDir: path.join(projectDir, 'export'),
      brand,
      issues: check.issues,
      cards: rendered,
    });
    store.finishStep(step5, 'done');

    result.bundle = bundle;
    result.cards = rendered;
    result.costUsd = store.spentUsd([jobId]);
    store.setJobStatus(jobId, result.failures.length ? 'partial' : 'done');
    return result;
  } catch (err) {
    store.setJobStatus(jobId, 'failed');
    result.error = err instanceof ProviderError ? err.userMessage : String(err?.message ?? err);
    result.bundle = store.getBundle(projectId); // 여기까지 만든 것은 보존한다
    return result;
  }
}

/**
 * 유료 호출 한 건. 장부에 pending 을 남기고 → 호출 → done/failed 로 닫는다.
 * 같은 키로 이미 성공한 호출이 있으면 보내지 않는다.
 */
async function paidCall(ctx, { jobId, kind, provider, model, key, run, cost }) {
  const { store } = ctx;
  const call = store.beginCall({ jobId, provider, model, kind, idempotencyKey: key });

  // 재시작 전에 이미 성공한(=이미 결제된) 호출이다. 다시 보내지 않는다.
  // 결과 파일이 디스크에 없다면 사용자가 판단할 일이므로 호출자에게 그대로 알린다.
  if (call.reused) return { reused: true };

  try {
    const r = await run();
    store.endCall(call.id, { status: 'done', usage: r.usage, costUsd: cost?.(r) ?? null });
    return r;
  } catch (err) {
    store.endCall(call.id, { status: 'failed', error: String(err?.message ?? err) });
    throw err;
  }
}

function hashOf(x) {
  const s = typeof x === 'string' ? x : JSON.stringify(x);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
