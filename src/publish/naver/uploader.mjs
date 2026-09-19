/**
 * 네이버 블로그 임시저장 업로더.
 *
 * 흐름:  기존 임시글 확인 → 제목 타이핑 → 본문 타이핑(이미지는 파일 업로드) →
 *        임시저장 → 저장된 글을 다시 열어 검증
 *
 * 중요한 전제 두 가지
 * 1. 셀렉터는 profile.json 에 모아 두고 여기서는 이름으로만 참조한다.
 *    네이버가 화면을 바꾸면 이 파일이 아니라 프로필을 고친다.
 * 2. 실패하면 던지지 않고 결과 객체로 돌려준다. 호출자(앱)는 실패 시
 *    내보내기 경로(폴더 열기·문구 복사)로 떨어뜨려야 하기 때문이다(D1).
 */

import { readFile } from 'node:fs/promises';
import { typeText, typeParagraphs, clearFocused } from './typing.mjs';
import { markdownToBlocks, inspectBlocks } from './blocks.mjs';

/** @typedef {'입력 중'|'사용자 확인 대기'|'저장 확인됨'|'저장 여부 미확인'|'실패'} DraftStatus */

export async function loadProfile(url = new URL('./profile.json', import.meta.url)) {
  return JSON.parse(await readFile(url, 'utf8'));
}

/**
 * 에디터가 띄우는 안내·템플릿 팝업을 닫는다.
 * '내 템플릿'이 없어도 기본 서식으로 쓸 수 있어야 하므로 템플릿 선택을 강제하지 않는다.
 */
async function dismissDialogs(page, frame, profile) {
  for (const key of ['templateDialogClose', 'helpDialogClose']) {
    const sel = profile.selectors[key];
    if (!sel) continue;
    const btn = frame.locator(sel).first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

/**
 * 이미 같은 제목의 임시글이 있는지 본다.
 * 계획의 "중복 업로드를 막는다" 요구사항. 저장 결과가 불명확했던 이전 실행이
 * 실제로는 저장에 성공했을 수 있으므로, 쓰기 전에 확인한다.
 */
export async function findExistingDraft(frame, profile, title) {
  const listBtn = frame.locator(profile.selectors.draftListButton).first();
  if (!(await listBtn.isVisible({ timeout: 2000 }).catch(() => false))) {
    return { checked: false, found: false };
  }
  await listBtn.click().catch(() => {});

  const items = frame.locator(profile.selectors.draftListItems);
  const count = await items.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const text = (await items.nth(i).innerText().catch(() => '')).trim();
    if (text && title && text.includes(title.slice(0, 20))) {
      return { checked: true, found: true, index: i, text };
    }
  }
  return { checked: true, found: false };
}

/**
 * @param {import('playwright').Page} page
 * @param {{blogId:string, title:string, markdown:string, imageBase?:string,
 *          typeMode?:'key'|'ime', onProgress?:(s:string)=>void, signal?:AbortSignal}} input
 * @param {object} profile
 */
export async function saveDraft(page, input, profile) {
  const { blogId, title, markdown, imageBase, typeMode = 'key', onProgress, signal } = input;
  const t = profile.timing;
  const log = (s) => onProgress?.(s);

  /** @type {{status: DraftStatus, issues: string[], counts?: object, verified?: object}} */
  const result = { status: '입력 중', issues: [] };

  const blocks = markdownToBlocks(markdown, { imageBase });
  const inspection = inspectBlocks(blocks);
  result.counts = inspection.counts;
  result.issues.push(...inspection.issues);

  try {
    log('에디터 여는 중');
    await page.goto(profile.urls.write.replace('{blogId}', blogId), { waitUntil: 'domcontentloaded' });

    const frame = page.frameLocator(profile.editorFrame);
    await page
      .frameLocator(profile.editorFrame)
      .locator(profile.selectors.bodyArea)
      .first()
      .waitFor({ state: 'visible', timeout: t.editorReadyTimeoutMs });

    await dismissDialogs(page, frame, profile);

    // ── 중복 확인 ───────────────────────────────────────────────
    const existing = await findExistingDraft(frame, profile, title);
    if (existing.found) {
      result.status = '사용자 확인 대기';
      result.issues.push(
        `같은 제목의 임시글이 이미 있다: "${existing.text}". ` +
        '덮어쓸지 새로 만들지 사용자가 정해야 한다.',
      );
      return result;
    }
    if (!existing.checked) {
      result.issues.push('임시글 목록을 확인하지 못했다. 중복 저장 가능성이 있다.');
    }

    // ── 제목 ────────────────────────────────────────────────────
    log('제목 입력 중');
    const titleEl = frame.locator(profile.selectors.titleInput).first();
    await titleEl.click();
    await clearFocused(page);
    await typeText(page, title, { mode: typeMode, delayMs: t.typeDelayMs, signal });

    // ── 본문 ────────────────────────────────────────────────────
    log('본문 입력 중');
    const bodyEl = frame.locator(profile.selectors.bodyFirstParagraph).first();
    await bodyEl.click();

    let typedSinceBreak = false;
    let imagesInserted = 0;

    for (const [i, block] of blocks.entries()) {
      signal?.throwIfAborted();
      log(`본문 ${i + 1}/${blocks.length}`);

      if (block.kind === 'image') {
        // 이미지는 타이핑할 수 없다. 파일 선택 대화상자를 통해 올린다.
        if (typedSinceBreak) {
          await page.keyboard.press('Enter');
          await page.waitForTimeout(t.paragraphPauseMs);
        }
        const ok = await insertImage(page, frame, profile, block.path);
        if (ok) imagesInserted++;
        else result.issues.push(`이미지 삽입 실패: ${block.path}`);
        typedSinceBreak = false;
        continue;
      }

      if (typedSinceBreak) {
        await page.keyboard.press('Enter');
        await page.waitForTimeout(t.paragraphPauseMs);
      }
      // 제목 블록도 지금은 본문 문단으로 넣는다. 서식(크기·굵기) 적용은 다음 단계.
      await typeParagraphs(page, [block.text], {
        mode: typeMode,
        delayMs: t.typeDelayMs,
        pauseMs: t.paragraphPauseMs,
        signal,
      });
      typedSinceBreak = true;
    }

    result.counts.imagesInserted = imagesInserted;

    // ── 임시저장 ────────────────────────────────────────────────
    log('임시저장 중');
    const saveBtn = frame.locator(profile.selectors.saveButton).first();
    await saveBtn.click({ timeout: t.saveTimeoutMs });
    await page.waitForTimeout(2000);

    // ── 검증 ────────────────────────────────────────────────────
    log('저장 결과 확인 중');
    const verified = await verifyDraft(page, profile, { blogId, title, expectImages: imagesInserted });
    result.verified = verified;
    result.status = verified.matched ? '저장 확인됨' : '저장 여부 미확인';
    if (!verified.matched) {
      result.issues.push(
        '저장은 됐지만 다시 열어 확인하지 못했다. 네이버에서 직접 임시글 목록을 확인할 것.',
      );
    }
    return result;
  } catch (err) {
    result.status = '실패';
    result.issues.push(String(err?.message ?? err));
    return result;
  }
}

/**
 * 사진 버튼 → 파일 선택 대화상자로 이미지를 올린다.
 */
async function insertImage(page, frame, profile, filePath) {
  try {
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
    await frame.locator(profile.selectors.photoButton).first().click();
    const chooser = await chooserPromise;
    await chooser.setFiles(filePath);
    // 업로드가 끝나 본문에 이미지 컴포넌트가 들어갈 때까지 잠시 기다린다.
    await page.waitForTimeout(2500);
    return true;
  } catch {
    return false;
  }
}

/**
 * 저장된 글을 다시 열어 제목·본문 길이·이미지 수를 확인한다.
 *
 * 계획의 "저장 결과가 불명확하면 기존 임시글부터 확인" 요구사항에 해당한다.
 * 여기서 확인에 실패하면 상태를 '저장 여부 미확인'으로 남기고, 앱은 자동으로
 * 다시 올리지 않는다 — 중복 글이 생기는 쪽이 더 나쁘기 때문이다.
 */
export async function verifyDraft(page, profile, { blogId, title, expectImages = 0 }) {
  try {
    await page.goto(profile.urls.drafts.replace('{blogId}', blogId), { waitUntil: 'domcontentloaded' });
    const frame = page.frameLocator(profile.editorFrame);

    const titleEl = frame.locator(profile.selectors.titleInput).first();
    await titleEl.waitFor({ state: 'visible', timeout: profile.timing.editorReadyTimeoutMs });

    const gotTitle = (await titleEl.innerText().catch(() => '')).trim();
    const bodyText = (await frame.locator(profile.selectors.bodyArea).first().innerText().catch(() => '')).trim();
    const imageCount = await frame.locator(`${profile.selectors.bodyArea} img`).count().catch(() => 0);

    return {
      matched: Boolean(gotTitle) && gotTitle.includes(title.slice(0, 15)),
      title: gotTitle,
      bodyChars: bodyText.length,
      imageCount,
      expectImages,
      imagesMatched: imageCount >= expectImages,
    };
  } catch (err) {
    return { matched: false, error: String(err?.message ?? err) };
  }
}
