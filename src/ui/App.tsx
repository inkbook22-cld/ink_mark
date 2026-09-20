import { useEffect, useState } from 'react';
import type { Brand, Bundle, GenerateResult, Issue, KeyStatus } from './types';
import { Regenerate } from './Regenerate';

type Tab = 'create' | 'result' | 'brand' | 'settings';

export default function App() {
  const [tab, setTab] = useState<Tab>('create');
  const [brands, setBrands] = useState<Brand[]>([]);
  const [keys, setKeys] = useState<KeyStatus | null>(null);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    window.ink.listBrands().then(setBrands);
    window.ink.keyStatus().then(setKeys);
    return window.ink.onProgress((p) => setProgress(p.text));
  }, []);

  const refreshBrands = () => window.ink.listBrands().then(setBrands);

  return (
    <div className="app">
      <nav className="side">
        <h1>INK 마케팅 스튜디오</h1>
        <button aria-current={tab === 'create'} onClick={() => setTab('create')}>새로 만들기</button>
        <button aria-current={tab === 'result'} onClick={() => setTab('result')} disabled={!result}>결과</button>
        <button aria-current={tab === 'brand'} onClick={() => setTab('brand')}>브랜드</button>
        <button aria-current={tab === 'settings'} onClick={() => setTab('settings')}>설정</button>
        <div className="spacer" />
        {keys && !keys.openai.set && (
          <p className="note">API 키가 없어 예시 데이터로 동작합니다. 설정에서 키를 넣어 주세요.</p>
        )}
      </nav>

      <main>
        {tab === 'create' && (
          <Create
            brands={brands}
            onDone={(r) => { setResult(r); setTab('result'); setProgress(null); }}
            onProgress={setProgress}
          />
        )}
        {tab === 'result' && result && <Result result={result} onUpdate={setResult} />}
        {tab === 'brand' && <BrandForm brands={brands} onSaved={refreshBrands} />}
        {tab === 'settings' && <Settings keys={keys} onChange={setKeys} />}
      </main>

      {progress && <div className="progress">{progress}</div>}
    </div>
  );
}

/* ── 새로 만들기 ────────────────────────────────────────── */
function Create({ brands, onDone, onProgress }: {
  brands: Brand[];
  onDone: (r: GenerateResult) => void;
  onProgress: (s: string | null) => void;
}) {
  const [brandId, setBrandId] = useState('');
  const [source, setSource] = useState('');
  const [cardCount, setCardCount] = useState(7);
  const [budget, setBudget] = useState('');
  const [estimate, setEstimate] = useState<{ totalUsd: number; imageCount: number; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!brandId && brands[0]?.id) setBrandId(brands[0].id); }, [brands, brandId]);
  // 시작 버튼을 누르기 전에 예상 비용을 보여준다
  useEffect(() => { window.ink.estimate({ cardCount }).then(setEstimate); }, [cardCount]);

  async function run() {
    setBusy(true);
    setError(null);
    onProgress('시작하는 중');
    try {
      const r = await window.ink.generate({
        brandId, source, cardCount,
        budgetUsd: budget ? Number(budget) : undefined,
      });
      if (r.error) setError(r.error);
      else onDone(r);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
      onProgress(null);
    }
  }

  return (
    <>
      <h2>새로 만들기</h2>
      <p className="sub">글감을 넣으면 블로그 원고와 인스타 카드뉴스를 함께 만듭니다.</p>

      {error && <div className="banner error">{error}</div>}
      {!brands.length && <div className="banner warn">먼저 브랜드를 하나 만들어 주세요.</div>}

      <section>
        <div className="row">
          <div>
            <label htmlFor="brand">브랜드</label>
            <select id="brand" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="cards">카드 장수</label>
            <input id="cards" type="number" min={3} max={20} value={cardCount}
                   onChange={(e) => setCardCount(Number(e.target.value))} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="source">글감</label>
          <textarea id="source" value={source} onChange={(e) => setSource(e.target.value)}
                    placeholder="알리고 싶은 내용을 붙여넣으세요. 확인되지 않은 날짜·가격·주소는 지어내지 않고 '채워야 할 것'으로 표시합니다." />
        </div>

        <div className="field" style={{ maxWidth: 240 }}>
          <label htmlFor="budget">프로젝트 예산 (USD, 선택)</label>
          <input id="budget" type="number" step="0.1" value={budget}
                 onChange={(e) => setBudget(e.target.value)} placeholder="예: 1.0" />
          <p className="hint">다음 요청 전에 잔여를 확인합니다. 공급자 청구를 강제로 막는 한도는 아닙니다.</p>
        </div>
      </section>

      {estimate && (
        <div className="banner info">
          예상 비용 약 <strong>${estimate.totalUsd}</strong> (이미지 {estimate.imageCount}장) — {estimate.note}
        </div>
      )}

      <button className="btn" onClick={run} disabled={busy || !brandId}>
        {busy ? '만드는 중…' : '전체 만들기'}
      </button>
    </>
  );
}

/* ── 결과 ───────────────────────────────────────────────── */
function Result({ result, onUpdate }: { result: GenerateResult; onUpdate: (r: GenerateResult) => void }) {
  const b = result.bundle;
  const [issues, setIssues] = useState<Issue[]>(result.issues);

  async function edit(path: string, value: string) {
    const { bundle } = await window.ink.editField(result.projectId, path, value);
    onUpdate({ ...result, bundle });
    window.ink.validate(result.projectId).then((v) => setIssues(v.issues));
  }

  return (
    <>
      <h2>{b.blog.title.value}</h2>
      <p className="sub">
        카드 {b.instagram.cards.length}장 · 비용 ${result.costUsd} (예상 ${result.estimate.totalUsd})
        {result.mocked && ' · 예시 데이터'}
      </p>

      {result.failures.length > 0 && (
        <div className="banner warn">
          <strong>실패한 항목이 있습니다.</strong> 나머지 결과는 그대로 보존했습니다.
          <ul style={{ marginTop: 6, paddingLeft: 18 }}>
            {result.failures.map((f, i) => <li key={i}>{f.where} — {f.message}</li>)}
          </ul>
        </div>
      )}

      {result.mergeReport && result.mergeReport.overwritten.length > 0 && (
        <div className="banner warn">
          직접 수정하신 {result.mergeReport.overwritten.length}개 항목이 새 결과로 바뀌었습니다.
          이전 버전으로 되돌릴 수 있습니다.
        </div>
      )}

      <Regenerate result={result} onUpdate={onUpdate} />

      <section>
        <h3>인스타 카드</h3>
        <div className="cards">
          {result.cards.map((c) => (
            <figure key={c.cardId}>
              <img src={assetUrl(c.path)} alt={`카드 ${c.cardId}`} />
              <figcaption>{c.cardId} · {c.design}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section>
        <h3>블로그 원고</h3>
        <div className="field">
          <label htmlFor="btitle">
            제목
            {b.blog.title.locked && <span className="locked">직접 수정함 · 재생성해도 유지</span>}
          </label>
          <input id="btitle" type="text" defaultValue={b.blog.title.value}
                 onBlur={(e) => e.target.value !== b.blog.title.value && edit('blog.title', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="bbody">
            본문
            {b.blog.bodyMarkdown.locked && <span className="locked">직접 수정함 · 재생성해도 유지</span>}
          </label>
          <textarea id="bbody" rows={14} defaultValue={b.blog.bodyMarkdown.value}
                    onBlur={(e) => e.target.value !== b.blog.bodyMarkdown.value && edit('blog.bodyMarkdown', e.target.value)} />
          <p className="hint">다른 곳을 누르면 저장됩니다. 저장하면 이 항목은 잠기고 재생성해도 유지됩니다.</p>
        </div>
      </section>

      <section>
        <h3>인스타 캡션</h3>
        <textarea rows={6} defaultValue={b.instagram.caption.value}
                  onBlur={(e) => e.target.value !== b.instagram.caption.value && edit('instagram.caption', e.target.value)} />
        <p className="hint">
          {b.instagram.caption.value.length} / 2200자 · 해시태그 {b.instagram.hashtags.value.length} / 30개
        </p>
      </section>

      {issues.length > 0 && (
        <section>
          <h3>검사 결과</h3>
          <ul className="issues">
            {issues.map((i, k) => (
              <li key={k} className={i.level}>
                <span className="tag">{{ error: '오류', warn: '주의', info: '안내' }[i.level]}</span>
                <span className="where">{i.where}</span> — {i.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>발행</h3>
        <div className="banner info">
          내보내기 폴더의 <strong>발행체크리스트.md</strong> 를 따라가면 붙여넣기만으로 발행할 수 있습니다.
        </div>
        <div className="btnrow">
          <button className="btn" onClick={() => result.exported && window.ink.openFolder(result.exported.outDir)}>
            내보내기 폴더 열기
          </button>
          <button className="btn ghost"
                  onClick={() => navigator.clipboard.writeText(b.instagram.caption.value)}>
            인스타 문구 복사
          </button>
        </div>
      </section>
    </>
  );
}

/** 로컬 파일 경로를 화면에서 쓸 수 있는 주소로. 이미 주소면 그대로 둔다. */
function assetUrl(p: string) {
  return /^[a-z]+:/i.test(p) ? p : `file://${p}`;
}

/* ── 브랜드 ─────────────────────────────────────────────── */
function BrandForm({ brands, onSaved }: { brands: Brand[]; onSaved: () => void }) {
  const [b, setB] = useState<Brand>(brands[0] ?? { name: '' });
  const [saved, setSaved] = useState(false);
  const set = (patch: Partial<Brand>) => { setB({ ...b, ...patch }); setSaved(false); };

  async function save() {
    await window.ink.saveBrand(b);
    setSaved(true);
    onSaved();
  }

  return (
    <>
      <h2>브랜드</h2>
      <p className="sub">말투와 금칙어는 원고 품질에 가장 크게 영향을 줍니다.</p>

      {brands.length > 1 && (
        <div className="field" style={{ maxWidth: 300 }}>
          <label>편집할 브랜드</label>
          <select value={b.id ?? ''} onChange={(e) => setB(brands.find((x) => x.id === e.target.value) ?? { name: '' })}>
            {brands.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </div>
      )}

      <section>
        <div className="row">
          <div><label>브랜드명</label>
            <input type="text" value={b.name} onChange={(e) => set({ name: e.target.value })} /></div>
          <div><label>문의처</label>
            <input type="text" value={b.contact ?? ''} onChange={(e) => set({ contact: e.target.value })} /></div>
        </div>

        <div className="field">
          <label>주요 고객</label>
          <input type="text" value={b.audience ?? ''} onChange={(e) => set({ audience: e.target.value })}
                 placeholder="예: 동네에 사는 30~40대, 아침 출근길에 빵을 사는 사람" />
        </div>

        <div className="row">
          <div><label>주 색상</label>
            <input type="text" value={b.colors?.primary ?? ''}
                   onChange={(e) => set({ colors: { ...b.colors, primary: e.target.value } })} placeholder="#2f4f3e" /></div>
          <div><label>강조 색상</label>
            <input type="text" value={b.colors?.accent ?? ''}
                   onChange={(e) => set({ colors: { ...b.colors, accent: e.target.value } })} placeholder="#c8794a" /></div>
        </div>

        <div className="field">
          <label>말투 예시 (한 줄에 하나)</label>
          <textarea rows={4} value={(b.toneExamples ?? []).join('\n')}
                    onChange={(e) => set({ toneExamples: e.target.value.split('\n').filter(Boolean) })} />
        </div>

        <div className="field">
          <label>금칙어 (쉼표로 구분)</label>
          <input type="text" value={(b.bannedWords ?? []).join(', ')}
                 onChange={(e) => set({ bannedWords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
          <p className="hint">원고에 들어가면 검사에서 오류로 잡습니다.</p>
        </div>

        <div className="field" style={{ maxWidth: 300 }}>
          <label>네이버 블로그 아이디</label>
          <input type="text" value={b.channels?.naverBlogId ?? ''}
                 onChange={(e) => set({ channels: { ...b.channels, naverBlogId: e.target.value } })} />
        </div>
      </section>

      <div className="btnrow">
        <button className="btn" onClick={save} disabled={!b.name}>저장</button>
        {saved && <span className="hint">저장했습니다.</span>}
      </div>
    </>
  );
}

/* ── 설정 ───────────────────────────────────────────────── */
function Settings({ keys, onChange }: { keys: KeyStatus | null; onChange: (k: KeyStatus) => void }) {
  const [openai, setOpenai] = useState('');
  const [gemini, setGemini] = useState('');

  async function save(provider: 'openai' | 'gemini', value: string) {
    const next = await window.ink.setKey(provider, value || null);
    onChange(next);
    if (provider === 'openai') setOpenai(''); else setGemini('');
  }

  return (
    <>
      <h2>설정</h2>
      <p className="sub">키는 운영체제 보안 저장소에 보관합니다. 화면·로그·내보내기 파일에는 들어가지 않습니다.</p>

      {keys && !keys.available && (
        <div className="banner error">이 컴퓨터에서는 보안 저장소를 쓸 수 없어 키를 저장할 수 없습니다.</div>
      )}

      <div className="banner info">
        입력한 글감과 선택한 사진은 원고·이미지 생성을 위해 AI 공급자에게 전송됩니다.
      </div>

      <section className="card">
        <h3>OpenAI</h3>
        <p className="hint" style={{ marginBottom: 10 }}>
          원고와 이미지를 모두 담당합니다. 이 키 하나로 전체 제작이 됩니다.
          {keys?.openai.set && ` 현재 저장됨 (${keys.openai.hint})`}
        </p>
        <div className="btnrow">
          <input type="password" value={openai} onChange={(e) => setOpenai(e.target.value)}
                 placeholder="sk-..." style={{ maxWidth: 380 }} />
          <button className="btn" onClick={() => save('openai', openai)} disabled={!openai}>저장</button>
          {keys?.openai.set && <button className="btn ghost" onClick={() => save('openai', '')}>삭제</button>}
        </div>
      </section>

      <section className="card">
        <h3>Gemini (선택)</h3>
        <p className="hint" style={{ marginBottom: 10 }}>
          이미지 대체 공급자입니다. OpenAI 조직 인증 문제로 막혔을 때 쓸 수 있습니다.
          자동으로 전환하지는 않습니다.
          {keys?.gemini.set && ` 현재 저장됨 (${keys.gemini.hint})`}
        </p>
        <div className="btnrow">
          <input type="password" value={gemini} onChange={(e) => setGemini(e.target.value)}
                 placeholder="AIza..." style={{ maxWidth: 380 }} />
          <button className="btn" onClick={() => save('gemini', gemini)} disabled={!gemini}>저장</button>
          {keys?.gemini.set && <button className="btn ghost" onClick={() => save('gemini', '')}>삭제</button>}
        </div>
      </section>
    </>
  );
}
