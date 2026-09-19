/**
 * 원고(Markdown) → 입력 블록 목록.
 *
 * 에디터에 "붙여넣기"하지 않고 "타이핑"하므로, 원고를 한 덩어리 문자열이 아니라
 * 입력 단위로 쪼개 둬야 한다. 이미지는 타이핑할 수 없으므로 별도 블록으로 분리해서
 * 파일 업로드 흐름을 타게 한다.
 */

import path from 'node:path';

/** @typedef {{kind:'heading', text:string}} HeadingBlock */
/** @typedef {{kind:'text', text:string}} TextBlock */
/** @typedef {{kind:'image', path:string, alt:string}} ImageBlock */
/** @typedef {HeadingBlock|TextBlock|ImageBlock} Block */

/**
 * 붙여넣기 대신 타이핑하기 때문에 생기는 제약을 여기서 흡수한다.
 * - 마크다운 문법 기호(**, ##, - )는 그대로 치면 화면에 그 기호가 남는다. 제거한다.
 * - 빈 줄은 문단 구분이지 입력할 내용이 아니다.
 *
 * @param {string} markdown
 * @param {{imageBase?: string}} [opts]
 * @returns {Block[]}
 */
export function markdownToBlocks(markdown, opts = {}) {
  const blocks = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    const text = stripInlineMarks(buffer.join(' ').trim());
    if (text) blocks.push({ kind: 'text', text });
    buffer = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // 이미지: ![alt](path)
    const img = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line.trim());
    if (img) {
      flush();
      const [, alt, src] = img;
      blocks.push({ kind: 'image', path: resolveImage(src, opts.imageBase), alt });
      continue;
    }

    // 제목: # ~ ######
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      flush();
      const text = stripInlineMarks(heading[2].trim());
      if (text) blocks.push({ kind: 'heading', text });
      continue;
    }

    // 빈 줄 = 문단 경계
    if (!line.trim()) {
      flush();
      continue;
    }

    buffer.push(line.trim());
  }
  flush();

  return blocks;
}

/**
 * 인라인 마크다운 기호 제거.
 * 타이핑 방식에서는 에디터가 마크다운을 해석해주지 않으므로 기호가 그대로 남는다.
 * 굵게·기울임 같은 서식은 별도 단계에서 에디터 툴바로 적용한다(현재 범위 밖).
 */
function stripInlineMarks(s) {
  return s
    .replace(/^[-*+]\s+/, '· ')       // 목록 기호는 가운뎃점으로 대체
    .replace(/^\d+\.\s+/, (m) => m)   // 번호 목록은 숫자를 살린다
    .replace(/^>\s?/, '')             // 인용 기호 제거
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 $2'); // 링크는 "표시문구 URL" 로 펼친다
}

/**
 * 이미지 경로를 절대 경로로 바꾼다.
 * 파일 선택 대화상자에 넘겨야 하므로 URL 이 아니라 파일시스템 경로여야 한다.
 */
function resolveImage(src, base) {
  if (!base) return src;
  if (path.isAbsolute(src) || /^[a-z]+:/i.test(src)) return src;
  return path.resolve(base, src);
}

/**
 * 원고 검사 — 업로드 전에 걸러야 할 것들.
 * 실패해도 업로드를 막지는 않고, 호출자가 사용자에게 보여줄 수 있도록 목록만 돌려준다.
 */
export function inspectBlocks(blocks, { maxImages = 50 } = {}) {
  const issues = [];
  const images = blocks.filter((b) => b.kind === 'image');
  const missing = images.filter((b) => !b.path);

  if (!blocks.some((b) => b.kind === 'text')) issues.push('본문 텍스트가 비어 있다');
  if (missing.length) issues.push(`경로가 비어 있는 이미지 ${missing.length}개`);
  if (images.length > maxImages) issues.push(`이미지 ${images.length}개 — 상한 ${maxImages} 초과`);

  return {
    issues,
    counts: {
      text: blocks.filter((b) => b.kind === 'text').length,
      heading: blocks.filter((b) => b.kind === 'heading').length,
      image: images.length,
      chars: blocks.filter((b) => b.kind !== 'image').reduce((a, b) => a + b.text.length, 0),
    },
  };
}
