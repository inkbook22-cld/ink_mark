/**
 * 공급자 오류 분류.
 *
 * 재시도할 수 있는 오류와 그렇지 않은 오류를 나눈다. 잘못된 키·잔액 부족·권한
 * 오류를 반복 재시도하면 시간만 쓰고 사용자에게는 아무 설명도 못 준다.
 */

export class ProviderError extends Error {
  /** @param {{kind: 'auth'|'verification'|'quota'|'rate'|'transient'|'invalid'|'unknown', status?: number, provider?: string, retryable?: boolean}} info */
  constructor(message, info) {
    super(message);
    this.name = 'ProviderError';
    Object.assign(this, info);
    this.retryable = info.retryable ?? ['rate', 'transient'].includes(info.kind);
  }

  /** 사용자에게 그대로 보여줄 한국어 설명. */
  get userMessage() {
    switch (this.kind) {
      case 'auth':
        return 'API 키가 올바르지 않습니다. 설정에서 키를 다시 입력해 주세요.';
      case 'verification':
        return 'OpenAI 조직 인증이 필요한 모델입니다. OpenAI 플랫폼에서 조직 인증을 마치거나, 이미지 공급자를 Gemini로 바꿔 주세요.';
      case 'quota':
        return '공급자 잔액이 부족하거나 사용 한도에 걸렸습니다. 결제 상태를 확인해 주세요.';
      case 'rate':
        return '요청이 너무 잦습니다. 잠시 후 자동으로 다시 시도합니다.';
      case 'invalid':
        return `요청이 거부되었습니다: ${this.message}`;
      case 'transient':
        return '일시적인 네트워크 오류입니다. 다시 시도합니다.';
      default:
        return `알 수 없는 오류입니다: ${this.message}`;
    }
  }
}

export function classify(status, body, provider) {
  const msg = body?.error?.message ?? body?.message ?? '';
  if (status === 401) return new ProviderError(msg || '인증 실패', { kind: 'auth', status, provider });
  if (status === 403) {
    const kind = /verif/i.test(msg) ? 'verification' : 'auth';
    return new ProviderError(msg || '권한 없음', { kind, status, provider });
  }
  if (status === 429) {
    // 429 는 속도 제한일 수도, 잔액 부족일 수도 있다. 메시지로 가른다.
    const kind = /quota|billing|insufficient/i.test(msg) ? 'quota' : 'rate';
    return new ProviderError(msg || '요청 한도', { kind, status, provider });
  }
  if (status === 400 || status === 422) return new ProviderError(msg || '잘못된 요청', { kind: 'invalid', status, provider });
  if (status >= 500) return new ProviderError(msg || '공급자 오류', { kind: 'transient', status, provider });
  return new ProviderError(msg || `HTTP ${status}`, { kind: 'unknown', status, provider });
}

/**
 * 일시 오류만 제한적으로 재시도한다.
 * 유료 요청이므로 무한 반복하지 않는다 — 기본 2회까지.
 */
export async function withRetry(fn, { attempts = 2, baseMs = 1500, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof ProviderError) || !err.retryable || i === attempts) throw err;
      const wait = baseMs * 2 ** i;
      onRetry?.(i + 1, wait, err);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
