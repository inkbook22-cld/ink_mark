/**
 * 내보내기 — 1차 버전의 정식 발행 경로다(D1).
 *
 * 브라우저 자동화가 아니라 이것이 기본 경로이므로, 여기서 나오는 결과물만으로
 * 사용자가 붙여넣기만 해서 발행을 끝낼 수 있어야 한다.
 *
 * API 키와 브라우저 로그인 정보는 어떤 파일에도 넣지 않는다.
 */

import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { blogMarkdownWithImages, instagramCaptionText } from '../core/bundle.mjs';

const v = (f) => (f && typeof f === 'object' && 'value' in f ? f.value : f);

/**
 * @param {object} bundle
 * @param {{outDir:string, brand:object, issues?:object[], cards?:object[]}} opts
 */
export async function exportBundle(bundle, { outDir, brand, issues = [], cards = [] }) {
  await mkdir(path.join(outDir, 'images'), { recursive: true });
  await mkdir(path.join(outDir, 'cards'), { recursive: true });

  const written = [];
  const put = async (rel, content) => {
    const abs = path.join(outDir, rel);
    await writeFile(abs, content);
    written.push(rel);
  };

  // ── 블로그 ────────────────────────────────────────────────
  const markdown = blogMarkdownWithImages(bundle);
  const title = v(bundle.blog.title) ?? '제목 없음';
  await put('블로그원고.md', `# ${title}\n\n${markdown}\n`);
  await put('블로그원고.html', toHtml(title, markdown, brand));

  for (const img of v(bundle.blog.images) ?? []) {
    const p = v(img.path);
    if (!p) continue;
    const rel = path.join('images', path.basename(p));
    await copyFile(p, path.join(outDir, rel));
    written.push(rel);
  }

  // ── 인스타 ────────────────────────────────────────────────
  await put('인스타문구.txt', instagramCaptionText(bundle));

  for (const c of cards) {
    const rel = path.join('cards', path.basename(c.path));
    await copyFile(c.path, path.join(outDir, rel));
    written.push(rel);
  }

  // ── 발행 체크리스트 ───────────────────────────────────────
  // 자동화 대신 사람이 붙여넣는 것이 기본 경로이므로, 순서를 빠뜨리지 않게 적어준다.
  await put('발행체크리스트.md', checklist(bundle, { brand, cards, issues }));

  return { outDir, written };
}

function checklist(bundle, { brand, cards, issues }) {
  const errors = issues.filter((i) => i.level === 'error');
  const infos = issues.filter((i) => i.level === 'info');
  const tags = v(bundle.instagram.hashtags) ?? [];

  const lines = [
    `# 발행 체크리스트 — ${v(bundle.blog.title)}`,
    '',
    `브랜드: ${brand.name}`,
    `생성 시각: ${new Date().toLocaleString('ko-KR')}`,
    '',
  ];

  if (errors.length) {
    lines.push('## 먼저 고칠 것', '');
    for (const e of errors) lines.push(`- [ ] **${e.where}** — ${e.message}`);
    lines.push('');
  }

  if (infos.length) {
    lines.push('## 자료에 없어 비워둔 것', '');
    lines.push('아래는 지어내지 않고 남겨두었습니다. 직접 채워 주세요.', '');
    for (const i of infos) lines.push(`- [ ] ${i.message}`);
    lines.push('');
  }

  lines.push(
    '## 네이버 블로그',
    '',
    '- [ ] `블로그원고.md` 내용을 에디터에 옮긴다 (또는 `npm run naver:draft` 사용)',
    `- [ ] 제목: ${v(bundle.blog.title)}`,
    `- [ ] 이미지 ${(v(bundle.blog.images) ?? []).filter((i) => v(i.path)).length}장이 본문 위치에 들어갔는지 확인`,
    '- [ ] 임시저장 후 다시 열어 제목·본문·이미지 수 확인',
    '',
    '## 인스타그램',
    '',
    '- [ ] Business Suite 에서 게시할 계정이 맞는지 확인',
    `- [ ] \`cards/\` 폴더의 이미지 ${cards.length}장을 순서대로 올린다`,
    '- [ ] `인스타문구.txt` 를 캡션에 붙여넣는다',
    `- [ ] 해시태그 ${tags.length}개 확인 (상한 30개)`,
    '- [ ] 예약 시각 입력',
    '- [ ] **마지막 예약 버튼은 직접 누른다**',
    '- [ ] 예약 목록에서 계정·콘텐츠·시각이 맞는지 다시 확인',
    '',
  );

  return lines.join('\n');
}

function toHtml(title, markdown, brand) {
  // 붙여넣기용 최소 HTML. 스타일을 최소화해야 에디터가 덜 망가뜨린다.
  const body = markdown
    .split(/\n{2,}/)
    .map((block) => {
      const img = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(block.trim());
      if (img) return `<p><img src="${esc(img[2])}" alt="${esc(img[1])}"></p>`;
      const h = /^##\s+(.*)$/.exec(block.trim());
      if (h) return `<h2>${esc(h[1])}</h2>`;
      return `<p>${esc(block.trim()).replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body>
<h1>${esc(title)}</h1>
${body}
<hr>
<p>${esc(brand.contact ?? '')}</p>
</body></html>
`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
