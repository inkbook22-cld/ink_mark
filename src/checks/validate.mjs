/**
 * 검사 — 계획의 "분량·금칙어·이미지 누락·글자 잘림을 검사한다" 단계.
 *
 * 채널 제약(캡션 2200자, 해시태그 30개)을 여기서 같이 잡는다. 업로드 직전에
 * 알게 되면 되돌리기 어렵다.
 *
 * 검사는 생성을 막지 않는다. 목록을 돌려주고 화면에 띄울 뿐이다.
 */

export const LIMITS = {
  captionChars: 2200,      // 인스타 캡션
  hashtagCount: 30,        // 인스타 해시태그
  carouselCards: 20,       // 인스타 캐러셀 장수
  eyebrowChars: 12,
  headlineChars: 40,
  bodyChars: 60,
  blogMinChars: 600,
};

/** @typedef {{level:'error'|'warn'|'info', where:string, message:string}} Issue */

/**
 * @param {object} bundle  Field 로 감싼 콘텐츠 묶음
 * @param {{brand?:object, renderReport?:object[], missingInfo?:string[]}} ctx
 * @returns {{issues: Issue[], counts: object}}
 */
export function validateBundle(bundle, ctx = {}) {
  /** @type {Issue[]} */
  const issues = [];
  const v = (f) => (f && typeof f === 'object' && 'value' in f ? f.value : f);

  const blog = bundle.blog ?? {};
  const ig = bundle.instagram ?? {};
  const cards = ig.cards ?? [];

  // ── 분량 ────────────────────────────────────────────────────
  const blogBody = v(blog.bodyMarkdown) ?? '';
  if (blogBody.length < LIMITS.blogMinChars) {
    issues.push({ level: 'warn', where: 'blog.body', message: `본문이 ${blogBody.length}자로 짧습니다 (권장 ${LIMITS.blogMinChars}자 이상).` });
  }
  if (!v(blog.title)) issues.push({ level: 'error', where: 'blog.title', message: '제목이 비어 있습니다.' });

  // ── 인스타 채널 제약 ────────────────────────────────────────
  const caption = v(ig.caption) ?? '';
  if (caption.length > LIMITS.captionChars) {
    issues.push({ level: 'error', where: 'instagram.caption', message: `캡션이 ${caption.length}자입니다. 인스타 상한은 ${LIMITS.captionChars}자입니다.` });
  }
  const tags = v(ig.hashtags) ?? [];
  if (tags.length > LIMITS.hashtagCount) {
    issues.push({ level: 'error', where: 'instagram.hashtags', message: `해시태그 ${tags.length}개입니다. 상한은 ${LIMITS.hashtagCount}개입니다.` });
  }
  if (cards.length > LIMITS.carouselCards) {
    issues.push({ level: 'error', where: 'instagram.cards', message: `카드 ${cards.length}장입니다. 캐러셀 상한은 ${LIMITS.carouselCards}장입니다.` });
  }

  // ── 카드별 ──────────────────────────────────────────────────
  for (const card of cards) {
    const at = `카드 ${card.id ?? '?'}`;
    for (const [key, limit] of [['eyebrow', LIMITS.eyebrowChars], ['headline', LIMITS.headlineChars], ['body', LIMITS.bodyChars]]) {
      const text = v(card[key]) ?? '';
      if (text.length > limit) {
        issues.push({ level: 'warn', where: `${at}.${key}`, message: `${text.length}자입니다. ${limit}자를 넘으면 카드에서 잘릴 수 있습니다.` });
      }
    }
    if (!v(card.photo)) issues.push({ level: 'error', where: `${at}.photo`, message: '배경 이미지가 없습니다.' });
  }

  // ── 금칙어 ──────────────────────────────────────────────────
  const banned = ctx.brand?.bannedWords ?? [];
  if (banned.length) {
    const haystacks = [
      ['blog.title', v(blog.title)],
      ['blog.body', blogBody],
      ['instagram.caption', caption],
      ...cards.flatMap((c) => [
        [`카드 ${c.id}.headline`, v(c.headline)],
        [`카드 ${c.id}.body`, v(c.body)],
      ]),
    ];
    for (const [where, text] of haystacks) {
      for (const word of banned) {
        if (text && word && text.includes(word)) {
          issues.push({ level: 'error', where, message: `금칙어 "${word}"가 들어 있습니다.` });
        }
      }
    }
  }

  // ── 이미지 누락 ─────────────────────────────────────────────
  const blogImages = v(blog.images) ?? [];
  const missingImages = blogImages.filter((i) => !v(i.path));
  if (missingImages.length) {
    issues.push({ level: 'error', where: 'blog.images', message: `블로그 이미지 ${missingImages.length}장이 생성되지 않았습니다. 나머지는 그대로 보존됩니다.` });
  }

  // ── 글자 잘림 (렌더러가 돌려준 결과) ────────────────────────
  for (const r of ctx.renderReport ?? []) {
    for (const o of r.overflow ?? []) {
      issues.push({ level: 'error', where: `카드 ${r.cardId}.${o.id}`, message: `글자가 잘립니다: "${o.text}…"` });
    }
  }

  // ── 누락 정보 ───────────────────────────────────────────────
  for (const m of ctx.missingInfo ?? []) {
    issues.push({ level: 'info', where: '누락 정보', message: `${m} — 자료에 없어 원고에 넣지 않았습니다. 직접 채워 주세요.` });
  }

  return {
    issues,
    counts: {
      error: issues.filter((i) => i.level === 'error').length,
      warn: issues.filter((i) => i.level === 'warn').length,
      info: issues.filter((i) => i.level === 'info').length,
      cards: cards.length,
      blogChars: blogBody.length,
      captionChars: caption.length,
      hashtags: tags.length,
    },
  };
}

export function formatIssues(issues) {
  const mark = { error: '오류', warn: '주의', info: '안내' };
  return issues.map((i) => `  [${mark[i.level]}] ${i.where} — ${i.message}`).join('\n');
}
