/**
 * OpenAI 공급자 — 원고(Responses API)와 이미지(Images API).
 *
 * 모델 ID 는 여기 박지 않는다. config/providers.json 에서 받아 쓴다(D3).
 */

import { classify, withRetry } from './errors.mjs';
import { CONTENT_SCHEMA, buildSystemPrompt, buildUserPrompt } from './schema.mjs';

export class OpenAIProvider {
  /** @param {{apiKey:string, config:object}} opts */
  constructor({ apiKey, config }) {
    this.apiKey = apiKey;
    this.config = config;
    this.name = 'openai';
  }

  async #post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw classify(res.status, json, 'openai');
    return json;
  }

  /**
   * 원고 생성. 구조화 출력으로 받아 스키마 위반을 즉시 잡는다.
   * @returns {Promise<{content: object, usage: object, model: string}>}
   */
  async generateContent({ brand, brief, signal }) {
    const cfg = this.config.text.openai;
    const json = await withRetry(() =>
      this.#post(cfg.endpoint, {
        model: cfg.model,
        input: [
          { role: 'system', content: buildSystemPrompt(brand) },
          { role: 'user', content: buildUserPrompt(brief) },
        ],
        text: {
          format: { type: 'json_schema', name: 'content_bundle', strict: true, schema: CONTENT_SCHEMA },
        },
      }),
    );

    const text = extractText(json);
    if (!text) throw classify(500, { error: { message: '응답에서 본문을 찾지 못했다' } }, 'openai');

    return { content: JSON.parse(text), usage: json.usage ?? null, model: cfg.model };
  }

  /**
   * 이미지 생성. 품질은 medium 고정이 기본이다 — 글자는 앱이 합성하므로
   * high 를 쓸 이유가 없다(D3).
   * @returns {Promise<{buffer: Buffer, usage: object|null, model: string}>}
   */
  async generateImage({ prompt, size, quality, signal }) {
    const cfg = this.config.image.openai;
    const json = await withRetry(() =>
      this.#post(cfg.endpoint, {
        model: cfg.model,
        prompt,
        size: size ?? cfg.size,
        quality: quality ?? cfg.quality,
        n: 1,
      }),
    );

    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) throw classify(500, { error: { message: '이미지 데이터가 비어 있다' } }, 'openai');

    return { buffer: Buffer.from(b64, 'base64'), usage: json.usage ?? null, model: cfg.model };
  }
}

/** Responses API 의 출력에서 텍스트를 꺼낸다. 응답 모양이 바뀌어도 견디도록 여러 경로를 본다. */
function extractText(json) {
  if (typeof json.output_text === 'string' && json.output_text) return json.output_text;
  const parts = [];
  for (const item of json.output ?? []) {
    for (const c of item.content ?? []) {
      if (typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('');
}
