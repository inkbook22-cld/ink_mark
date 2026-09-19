/**
 * Gemini 이미지 공급자 — 대체 경로.
 *
 * 자동 전환하지 않는다. OpenAI 가 조직 인증 등으로 막혔을 때 사용자가 직접 고른다.
 */

import { classify, withRetry } from './errors.mjs';

export class GeminiImageProvider {
  constructor({ apiKey, config }) {
    this.apiKey = apiKey;
    this.config = config;
    this.name = 'gemini';
  }

  async generateImage({ prompt }) {
    const cfg = this.config.image.gemini;
    const url = `${cfg.endpoint}/${cfg.model}:generateContent`;

    const json = await withRetry(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw classify(res.status, body, 'gemini');
      return body;
    });

    const part = json?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part) throw classify(500, { error: { message: '이미지 데이터가 비어 있다' } }, 'gemini');

    return { buffer: Buffer.from(part.inlineData.data, 'base64'), usage: json.usageMetadata ?? null, model: cfg.model };
  }
}
