/**
 * 필드 단위 잠금과 병합 — D4 구현.
 *
 * 이 파일이 이 프로젝트에서 가장 나중에 바꾸기 비싼 코드다. 저장된 프로젝트가
 * 이 모양을 그대로 갖고 있으므로, 구조를 바꾸면 마이그레이션이 따라온다.
 *
 * 핵심 규칙(D4):
 *   - 잠금은 필드 단위. 사용자가 손댄 필드만 locked 가 된다.
 *   - '사진만 다시'  → 문구는 잠금 여부와 무관하게 전부 보존, 사진만 교체
 *   - '문구만 다시'  → 잠긴 문구는 보존, 안 잠긴 것만 교체. 사진은 건드리지 않음
 *   - 병합할 때마다 무엇이 바뀌고 무엇이 지켜졌는지 보고서를 돌려준다.
 *     사용자에게 "제목은 직접 수정하셔서 유지됩니다"를 보여주려면 이 정보가 필요하다.
 */

/** @typedef {'ai'|'user'} FieldSource */
/** @typedef {{value:any, source:FieldSource, locked:boolean, editedAt:string|null, version:number}} Field */

/** @returns {Field} */
export function field(value, source = 'ai') {
  return { value, source, locked: source === 'user', editedAt: source === 'user' ? now() : null, version: 1 };
}

export const isField = (x) => Boolean(x) && typeof x === 'object' && 'value' in x && 'locked' in x;

/**
 * 사용자가 직접 고친 경우. 이 순간부터 이 필드는 잠긴다.
 * @returns {Field}
 */
export function editByUser(f, value) {
  return { value, source: 'user', locked: true, editedAt: now(), version: (f?.version ?? 0) + 1 };
}

/** 사용자가 잠금을 푼 경우. 다음 재생성부터 AI가 다시 덮어쓸 수 있다. */
export function unlock(f) {
  return { ...f, locked: false };
}

/**
 * AI 결과로 덮어쓴다. 잠겨 있으면 무시하고 원본을 유지한다.
 * @param {Field} f
 * @param {any} value
 * @param {{force?: boolean}} [opts] force=true 면 잠금을 무시한다('사진만 다시'의 사진, 전체 재생성)
 */
export function applyAi(f, value, { force = false } = {}) {
  if (!f) return field(value, 'ai');
  if (f.locked && !force) return f;
  return { value, source: 'ai', locked: false, editedAt: f.editedAt, version: f.version + 1 };
}

/** @typedef {'photo'|'text'|'all'} RegenerateMode */

/**
 * 두 묶음을 병합한다.
 *
 * @param {object} current  현재 저장된 것(사용자 수정이 들어 있을 수 있다)
 * @param {object} incoming 새로 생성된 것
 * @param {RegenerateMode} mode
 * @param {{path?: string[], report?: {kept: string[], replaced: string[], overwritten: string[]}}} [ctx]
 * @returns {{merged: object, report: {kept: string[], replaced: string[], overwritten: string[]}}}
 */
export function mergeBundle(current, incoming, mode, ctx = {}) {
  const report = ctx.report ?? { kept: [], replaced: [], overwritten: [] };
  const merged = mergeNode(current, incoming, mode, ctx.path ?? [], report);
  return { merged, report };
}

function mergeNode(cur, inc, mode, path, report) {
  // 새로 생긴 항목은 그대로 받는다
  if (cur === undefined || cur === null) return inc;
  // 사라진 항목은 유지한다 (부분 생성 결과가 기존 내용을 지우지 않게)
  if (inc === undefined) return cur;

  if (isField(cur)) return mergeField(cur, inc, mode, path, report);

  if (Array.isArray(cur)) {
    // 배열은 id 로 짝을 맞춘다. 순서가 바뀌어도 사용자 수정이 엉뚱한 항목에 붙지 않게.
    if (!Array.isArray(inc)) return cur;
    const byId = new Map(cur.filter((x) => x?.id).map((x) => [x.id, x]));
    return inc.map((item, i) => {
      const prev = item?.id ? byId.get(item.id) : cur[i];
      return mergeNode(prev, item, mode, [...path, String(item?.id ?? i)], report);
    });
  }

  if (typeof cur === 'object') {
    const out = { ...cur };
    for (const key of new Set([...Object.keys(cur), ...Object.keys(inc ?? {})])) {
      out[key] = mergeNode(cur[key], inc?.[key], mode, [...path, key], report);
    }
    return out;
  }

  return inc;
}

/** 사진 필드인지 — 경로 이름으로 판별한다. */
const isPhotoPath = (path) => /photo|image|사진/i.test(path.at(-1) ?? '');

function mergeField(cur, inc, mode, path, report) {
  const label = path.join('.');
  const incValue = isField(inc) ? inc.value : inc;

  if (mode === 'photo') {
    if (!isPhotoPath(path)) {
      // 문구는 잠금 여부와 무관하게 전부 보존 — D4 규칙 2
      report.kept.push(label);
      return cur;
    }
    // 사진은 사용자가 직접 교체했더라도 바꾼다. 명시적으로 누른 버튼이기 때문이다.
    // 다만 덮어쓴 사실을 보고해서 되돌리기와 경고를 띄울 수 있게 한다 — D4 규칙 5
    if (cur.locked) report.overwritten.push(label);
    else report.replaced.push(label);
    return applyAi(cur, incValue, { force: true });
  }

  if (mode === 'text') {
    if (isPhotoPath(path)) {
      report.kept.push(label);
      return cur; // 사진은 건드리지 않는다 — D4 규칙 3
    }
    if (cur.locked) {
      report.kept.push(label);
      return cur;
    }
    report.replaced.push(label);
    return applyAi(cur, incValue);
  }

  // 'all' — 전체 재생성. 호출자가 확인 대화상자를 거친 뒤에만 부른다 — D4 규칙 6
  if (cur.locked) report.overwritten.push(label);
  else report.replaced.push(label);
  return applyAi(cur, incValue, { force: true });
}

/**
 * 재생성 버튼 옆에 띄울 문구를 만든다.
 * "무엇이 유지되는지 사용자에게 보여준다" — D4 규칙 4
 */
export function describeLocks(bundle, mode) {
  const locked = collectLocked(bundle, []);
  const relevant = locked.filter((p) => (mode === 'photo' ? isPhotoPath(p.split('.')) : !isPhotoPath(p.split('.'))));
  if (mode === 'photo') {
    return relevant.length
      ? `문구는 모두 유지됩니다. 직접 교체하신 사진 ${relevant.length}개는 새로 만들어집니다.`
      : '문구는 모두 유지됩니다.';
  }
  if (mode === 'text') {
    return relevant.length
      ? `직접 수정하신 ${relevant.length}개 항목은 유지됩니다. 사진은 그대로입니다.`
      : '사진은 그대로입니다.';
  }
  return locked.length
    ? `직접 수정하신 ${locked.length}개 항목이 모두 사라집니다.`
    : '직접 수정하신 항목이 없습니다.';
}

function collectLocked(node, path, out = []) {
  if (isField(node)) {
    if (node.locked) out.push(path.join('.'));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((x, i) => collectLocked(x, [...path, String(x?.id ?? i)], out));
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) collectLocked(v, [...path, k], out);
  }
  return out;
}

const now = () => new Date().toISOString();
