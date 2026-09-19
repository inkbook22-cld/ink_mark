/**
 * 구조화 출력 스키마.
 *
 * 모델이 자유 문장으로 답하면 검증할 수 없다. 스키마를 강제해서 "무엇이 사실이고
 * 무엇이 빠졌는지"를 모델이 명시적으로 구분해 내놓게 한다.
 *
 * missingInfo 가 이 스키마의 핵심이다. 날짜·가격·장소처럼 자료에 없는 것을 지어내는
 * 대신 여기에 적게 한다. 계획의 "확인할 수 없는 사실은 지어내지 않고 누락 정보로
 * 표시한다" 요구사항이 여기서 강제된다.
 */

export const CONTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts', 'missingInfo', 'blog', 'instagram'],
  properties: {
    facts: {
      type: 'array',
      description: '입력 자료에서 확인된 사실만. 추론이나 일반론은 넣지 않는다.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'basis'],
        properties: {
          text: { type: 'string' },
          basis: { type: 'string', description: '어느 자료의 어느 대목에서 나왔는지' },
        },
      },
    },
    missingInfo: {
      type: 'array',
      description: '원고에 있으면 좋지만 자료에 없어 쓸 수 없는 것 (날짜·가격·주소 등)',
      items: { type: 'string' },
    },
    blog: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'sections', 'imagePrompts'],
      properties: {
        title: { type: 'string' },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['heading', 'paragraphs'],
            properties: {
              heading: { type: 'string' },
              paragraphs: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        imagePrompts: {
          type: 'array',
          description: '블로그 본문 이미지 4장. 글자를 그리라고 요구하지 않는다.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['afterSection', 'prompt', 'alt'],
            properties: {
              afterSection: { type: 'integer', description: '몇 번째 섹션 뒤에 넣을지 (0-based)' },
              prompt: { type: 'string' },
              alt: { type: 'string' },
            },
          },
        },
      },
    },
    instagram: {
      type: 'object',
      additionalProperties: false,
      required: ['cards', 'caption', 'hashtags'],
      properties: {
        cards: {
          type: 'array',
          description: '카드뉴스. 첫 장은 관심을 끌고, 장마다 메시지가 하나씩이다.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['design', 'eyebrow', 'headline', 'body', 'photoPrompt'],
            properties: {
              design: { type: 'string', enum: ['photo', 'info', 'review'] },
              eyebrow: { type: 'string', description: '상단 짧은 태그. 12자 이내' },
              headline: { type: 'string', description: '카드 제목. 40자 이내' },
              body: { type: 'string', description: '하단 보조 문구. 60자 이내' },
              photoPrompt: { type: 'string', description: '배경 이미지 설명. 글자를 요구하지 않는다' },
            },
          },
        },
        caption: { type: 'string', description: '인스타 캡션. 2200자 이내' },
        hashtags: { type: 'array', items: { type: 'string' }, description: '# 없이 단어만. 30개 이내' },
      },
    },
  },
};

/**
 * 시스템 지시문. 브랜드 정보를 받아 말투·금칙어를 주입한다.
 */
export function buildSystemPrompt(brand) {
  const lines = [
    '당신은 한국어 콘텐츠를 쓰는 마케팅 카피라이터다.',
    '',
    '절대 규칙:',
    '- 입력 자료에서 확인되지 않는 날짜·가격·주소·수치·효능을 지어내지 않는다.',
    '  필요하지만 자료에 없으면 missingInfo 에 적고 본문에서는 빼라.',
    '- 카드 문구에 이모지를 넣지 않는다. 이미지 합성 시 글꼴이 깨진다.',
    '- photoPrompt 에 글자·간판·로고를 그리라고 요구하지 않는다. 문구는 프로그램이 따로 얹는다.',
    '',
    `브랜드: ${brand.name}`,
  ];
  if (brand.audience) lines.push(`주요 고객: ${brand.audience}`);
  if (brand.toneExamples?.length) {
    lines.push('말투 예시 (이 결을 따른다):');
    for (const t of brand.toneExamples) lines.push(`  - ${t}`);
  }
  if (brand.bannedWords?.length) lines.push(`금칙어 (쓰지 말 것): ${brand.bannedWords.join(', ')}`);
  if (brand.contact) lines.push(`문의처: ${brand.contact}`);
  return lines.join('\n');
}

/** 사용자 입력(글감·사진 설명)을 하나의 지시문으로 만든다. */
export function buildUserPrompt(brief) {
  const lines = ['아래 자료로 블로그 원고 1편과 인스타 카드뉴스를 만들어라.', ''];
  if (brief.purpose) lines.push(`목적: ${brief.purpose}`);
  if (brief.audience) lines.push(`대상 독자: ${brief.audience}`);
  lines.push(`카드 장수: ${brief.cardCount ?? 7}장`, '', '--- 자료 ---', brief.source || '(글감 없음 — 사진만 제공됨)');
  if (brief.photoNotes?.length) {
    lines.push('', '--- 제공된 사진 ---');
    brief.photoNotes.forEach((n, i) => lines.push(`${i + 1}. ${n}`));
  }
  return lines.join('\n');
}
