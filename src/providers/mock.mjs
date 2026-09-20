/**
 * 모의 공급자 — API 키 없이 전체 파이프라인을 돌려보기 위한 것.
 *
 * 있어야 하는 이유: 파이프라인 버그와 모델 품질 문제를 분리하기 위해서다.
 * 모의 공급자로 끝까지 돌아가면 남은 문제는 프롬프트와 모델 쪽이고, 여기서
 * 막히면 우리 코드 문제다. 회귀 테스트도 돈 들이지 않고 돌릴 수 있다.
 */

import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export class MockProvider {
  constructor({ config, cardCount = 7 } = {}) {
    this.config = config;
    this.cardCount = cardCount;
    this.name = 'mock';
  }

  async generateContent({ brand, brief }) {
    const n = brief.cardCount ?? this.cardCount;
    const topic = (brief.source || '').split('\n').find((l) => l.trim()) || '새 소식';
    // 어절 중간에서 자르면 예시 데이터가 망가진 것처럼 보인다. 실제 모델은
    // 길이 제한을 지켜 쓰므로, 모의 데이터도 같은 모양이어야 화면 검토가 된다.
    const clip = (s, max) => {
      if (s.length <= max) return s;
      const cut = s.slice(0, max);
      const at = cut.lastIndexOf(' ');
      return (at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[,·]$/, '');
    };

    return {
      model: 'mock-text',
      usage: { input_tokens: 1200, output_tokens: 900 },
      content: {
        facts: [{ text: topic.slice(0, 60), basis: '입력 글감 첫 줄' }],
        // 모의 공급자도 누락 정보를 비워두지 않는다. 검사 로직이 이 경로를 타야 한다.
        missingInfo: brief.source ? [] : ['가격', '영업시간', '주소'],
        blog: {
          title: `${brand.name} · ${clip(topic, 24)}`,
          sections: Array.from({ length: 3 }, (_, i) => ({
            heading: `${i + 1}. ${clip(topic, 18)} 이야기`,
            paragraphs: [
              `${brand.name}의 이야기를 정리했습니다. 확인된 내용만 적었습니다.`,
              '자세한 내용은 아래 사진과 함께 보시면 이해가 쉽습니다.',
            ],
          })),
          imagePrompts: Array.from({ length: 4 }, (_, i) => ({
            afterSection: Math.min(i, 2),
            prompt: `A warm editorial photograph related to ${topic}. No text, no letters, no signage.`,
            alt: `${topic} 관련 사진 ${i + 1}`,
          })),
        },
        instagram: {
          cards: Array.from({ length: n }, (_, i) => ({
            design: i === 0 ? 'photo' : i % 3 === 2 ? 'review' : 'info',
            eyebrow: i === 0 ? '새 소식' : `${i + 1}단계`,
            headline: i === 0 ? clip(topic, 34) : `${clip(topic, 16)}에 대해 알아둘 것 ${i}`,
            body: '확인된 내용만 담았습니다. 문의는 프로필 링크로 남겨주세요.',
            photoPrompt: `A soft, warm photograph for ${topic}, shallow depth of field. No text, no letters.`,
          })),
          caption: `${topic}\n\n${brand.name}에서 전해드립니다. 자세한 내용은 프로필 링크를 확인해 주세요.`,
          hashtags: ['동네빵집', '신메뉴', brand.name.replace(/\s+/g, '')],
        },
      },
    };
  }

  async generateImage({ prompt, size }) {
    const [w, h] = (size ?? '1024x1536').split('x').map(Number);
    // 프롬프트마다 다른 색이 나오게 해서 이미지가 제자리에 갔는지 눈으로 확인할 수 있게 한다
    const hash = createHash('sha256').update(prompt).digest();
    const rgb = [120 + (hash[0] % 100), 110 + (hash[1] % 100), 100 + (hash[2] % 100)];
    return { buffer: solidPng(w, h, rgb), usage: { mock: true }, model: 'mock-image' };
  }
}

/** 의존성 없이 단색 PNG 를 만든다. 자리표시용이므로 품질은 상관없다. */
function solidPng(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (width * 3 + 1);
    raw[off] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = off + 1 + x * 3;
      // 위아래로 옅은 그라데이션을 줘서 단색 덩어리로 안 보이게
      const k = 1 - (y / height) * 0.35;
      raw[p] = Math.round(r * k);
      raw[p + 1] = Math.round(g * k);
      raw[p + 2] = Math.round(b * k);
    }
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
