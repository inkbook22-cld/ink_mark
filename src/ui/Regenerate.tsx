import { useEffect, useState } from 'react';
import type { GenerateResult } from './types';

/**
 * 재생성 — D4 의 화면 쪽 구현.
 *
 * 버튼을 둘로 나눈 것이 핵심이다. 하나로 합치면 "다시 만들기"를 누를 때 무엇이
 * 사라지는지 사용자가 예측할 수 없고, 그러면 버튼을 아예 안 누르게 된다.
 *
 * 각 버튼 아래에 무엇이 유지되는지 항상 적는다(D4 규칙 4). 이 문구는 화면이
 * 지어내지 않고 실제 잠금 상태에서 계산해 온다.
 */
export function Regenerate({ result, onUpdate }: {
  result: GenerateResult;
  onUpdate: (r: GenerateResult) => void;
}) {
  const [keeps, setKeeps] = useState<{ photo: string; text: string }>({ photo: '', text: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [versions, setVersions] = useState<{ version: number; label: string }[]>([]);

  const refresh = () => {
    Promise.all([
      window.ink.describeLocks(result.projectId, 'photo'),
      window.ink.describeLocks(result.projectId, 'text'),
    ]).then(([p, t]) => setKeeps({ photo: p.message, text: t.message }));
    window.ink.getBundle(result.projectId).then((r) => setVersions(r.versions));
  };

  useEffect(refresh, [result.projectId, result.bundle]);

  async function run(mode: 'photo' | 'text') {
    setBusy(mode);
    try {
      const r = await window.ink.regenerate({ projectId: result.projectId, mode });
      if (!r.error) onUpdate({ ...result, ...r });
    } finally {
      setBusy(null);
      refresh();
    }
  }

  async function revert(version: number) {
    const { bundle } = await window.ink.revert(result.projectId, version);
    onUpdate({ ...result, bundle });
    refresh();
  }

  return (
    <section>
      <h3>다시 만들기</h3>
      <div className="regen">
        <div className="opt">
          <h4>사진만 다시</h4>
          <p className="keeps">{keeps.photo}</p>
          <button className="btn" onClick={() => run('photo')} disabled={busy !== null}>
            {busy === 'photo' ? '만드는 중…' : '사진만 다시 만들기'}
          </button>
        </div>

        <div className="opt">
          <h4>문구만 다시</h4>
          <p className="keeps">{keeps.text}</p>
          <button className="btn" onClick={() => run('text')} disabled={busy !== null}>
            {busy === 'text' ? '만드는 중…' : '문구만 다시 만들기'}
          </button>
        </div>
      </div>

      {versions.length > 1 && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>
            이전 버전 {versions.length}개 — 되돌리기
          </summary>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>버전</th><th>내용</th><th /></tr></thead>
            <tbody>
              {versions.slice(1).map((v) => (
                <tr key={v.version}>
                  <td>v{v.version}</td>
                  <td>{v.label}</td>
                  <td><button className="btn ghost" onClick={() => revert(v.version)}>이 버전으로</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
