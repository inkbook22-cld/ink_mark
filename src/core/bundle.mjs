/**
 * 생성 결과 → 콘텐츠 묶음(ContentBundle).
 *
 * 모든 편집 가능한 값을 Field 로 감싼다. 여기서 안 감싸면 나중에 잠금을 붙일 수 없고,
 * 붙이려면 저장된 프로젝트를 전부 마이그레이션해야 한다.
 */

import { field } from './field.mjs';

export const BUNDLE_SCHEMA_VERSION = 1;

/**
 * @param {object} content  구조화 출력 결과
 * @returns {object} ContentBundle
 */
export function toBundle(content) {
  const { blog, instagram } = content;

  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    facts: content.facts ?? [],
    missingInfo: content.missingInfo ?? [],
    blog: {
      title: field(blog.title),
      bodyMarkdown: field(sectionsToMarkdown(blog.sections)),
      images: (blog.imagePrompts ?? []).map((p, i) => ({
        id: `b${i + 1}`,
        afterSection: p.afterSection,
        prompt: field(p.prompt),
        alt: field(p.alt),
        path: field(null),        // 생성 후 채워진다
      })),
    },
    instagram: {
      cards: (instagram.cards ?? []).map((c, i) => ({
        id: `c${i + 1}`,
        design: field(c.design ?? 'photo'),
        eyebrow: field(c.eyebrow),
        headline: field(c.headline),
        body: field(c.body),
        photoPrompt: field(c.photoPrompt),
        photo: field(null),       // 생성 후 채워진다
      })),
      caption: field(instagram.caption),
      hashtags: field(instagram.hashtags ?? []),
    },
  };
}

function sectionsToMarkdown(sections = []) {
  return sections
    .map((s) => [`## ${s.heading}`, '', ...(s.paragraphs ?? []), ''].join('\n'))
    .join('\n')
    .trim();
}

/**
 * 블로그 이미지를 본문 마크다운에 끼워 넣는다.
 * 내보내기와 네이버 업로드가 같은 마크다운을 쓰므로 여기서 한 번만 한다.
 */
export function blogMarkdownWithImages(bundle, { relative = true } = {}) {
  const v = (f) => (f && typeof f === 'object' && 'value' in f ? f.value : f);
  const body = v(bundle.blog.bodyMarkdown) ?? '';
  const images = (v(bundle.blog.images) ?? []).filter((i) => v(i.path));

  const sections = body.split(/\n(?=## )/);
  const out = [];
  for (const [i, sec] of sections.entries()) {
    out.push(sec.trim());
    for (const img of images.filter((im) => im.afterSection === i)) {
      const p = v(img.path);
      out.push(`![${v(img.alt) ?? ''}](${relative ? `images/${p.split('/').pop()}` : p})`);
    }
  }
  // 섹션 번호가 범위를 벗어난 이미지는 맨 뒤에 붙인다 — 조용히 잃지 않는다
  for (const img of images.filter((im) => im.afterSection >= sections.length)) {
    const p = v(img.path);
    out.push(`![${v(img.alt) ?? ''}](${relative ? `images/${p.split('/').pop()}` : p})`);
  }
  return out.join('\n\n');
}

/** 인스타 캡션 + 해시태그를 붙여넣기용 한 덩어리로. */
export function instagramCaptionText(bundle) {
  const v = (f) => (f && typeof f === 'object' && 'value' in f ? f.value : f);
  const caption = v(bundle.instagram.caption) ?? '';
  const tags = (v(bundle.instagram.hashtags) ?? []).map((t) => `#${String(t).replace(/^#/, '')}`);
  return tags.length ? `${caption}\n\n${tags.join(' ')}` : caption;
}
