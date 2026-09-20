# INK 마케팅 스튜디오

글감·사진을 넣으면 블로그 원고와 인스타 카드뉴스를 함께 만드는 맥·윈도우 설치형 앱.

**앱이 실제로 뜨고 전체 흐름이 돈다.**

```bash
npm install
npm start                                            # 앱 실행
npm run generate -- --mock --input samples/글감.txt   # CLI 로 같은 흐름
npm test                                             # 회귀 15개
```

`--mock` 은 API 키 없이 파이프라인 전체를 돌린다. 파이프라인 버그와 모델 품질 문제를
분리해서 볼 수 있고, 회귀 테스트가 돈을 쓰지 않는다. 실제 호출은 `OPENAI_API_KEY` 를
설정하고 `--mock` 을 빼면 된다.

## 구조

```
config/providers.json     모델 ID·단가·품질 — 소스에 하드코딩하지 않는다 (D3)
samples/                  예시 브랜드와 글감

src/core/
  field.mjs               필드 단위 잠금과 병합 (D4) — 가장 나중에 바꾸기 비싼 코드
  bundle.mjs              생성 결과 → 콘텐츠 묶음
src/providers/
  schema.mjs              구조화 출력 스키마 + 지시문
  openai.mjs              원고(Responses API) + 이미지(gpt-image-2)
  gemini.mjs              대체 이미지 공급자 (자동 전환하지 않는다)
  mock.mjs                키 없이 도는 모의 공급자
  errors.mjs              오류 분류 — 재시도할 것과 즉시 설명할 것을 가른다
  cost.mjs                비용 추정과 예산 확인
src/jobs/
  store.mjs               SQLite. 유료 호출 장부가 핵심
  runner.mjs              전체 파이프라인 (단계 재개 포함)
src/render/cards.mjs      카드 일괄 렌더 (캡처 방식 주입)
src/checks/validate.mjs   분량·금칙어·채널 제약·글자 잘림
src/export/exporter.mjs   내보내기 — 1차 버전의 정식 발행 경로 (D1)
src/publish/naver/        블로그 임시저장. 붙여넣기 대신 타이핑한다

electron/
  main.mjs                창·IPC 중계·카드 렌더
  preload.cjs             화면이 부를 수 있는 것의 전부 (화이트리스트)
  worker.mjs              API 호출과 파이프라인. 키는 여기서만 쓴다
  keys.mjs                OS 보안 저장소(safeStorage)
  capture.mjs             제품 캡처 경로 (DevTools 프로토콜)
src/ui/                   React + TypeScript 화면

templates/                카드 디자인 3종. 합성은 HTML/CSS 단일 경로 (D2)
docs/decisions.md         확정된 결정과 근거
```

## 파이프라인

```
글감 → 원고(구조화 출력) → 이미지 생성 → 카드 렌더 → 검사 → 내보내기
```

- **단계마다 완료를 기록한다.** 앱이 죽어도 완료 단계부터 이어간다.
- **유료 호출은 보내기 전에 장부에 남긴다.** 재시작 후 같은 요청에 돈을 두 번 쓰지 않는다.
- **이미지 하나가 실패해도** 원고와 나머지 이미지는 보존한다.
- **공급자를 자동으로 바꾸지 않는다.** 키·잔액·권한 오류는 즉시 설명하고 멈춘다.

## 명령

| | |
|---|---|
| `npm run generate -- --mock --input 글감.txt` | 전체 생성 (키 없이) |
| `npm run generate -- --input 글감.txt --cards 7 --budget 1.0` | 실제 호출 |
| `npm run verify:providers` | 1단계 연동 검증 (유료, $0.15 내외) |
| `npm run render:card` | 템플릿 하나만 렌더 |
| `npm run naver:draft -- --blog-id 내블로그 --file 원고.md` | 네이버 임시저장 |
| `npm start` | 앱 실행 |
| `npm run smoke -- --generate` | 앱이 뜨고 제품 캡처 경로로 카드가 나오는지 |
| `node scripts/ui-preview.mjs result` | 화면만 따로 (Electron·키 없이) |
| `npm run typecheck` | TypeScript 확인 |
| `npm test` | 전체 회귀 |
| `npm run test:typing` | 네이버 타이핑 회귀 (목업 대상) |

## 1단계 연동 검증

유료 API 호출이 발생한다.

```bash
OPENAI_API_KEY=sk-... GEMINI_API_KEY=... npm run verify:providers
```

| | 확인 대상 | 왜 먼저 확인하는가 |
|---|---|---|
| T1 | gpt-image-2 접근 (403 조직 인증) | "OpenAI 키 하나면 된다"는 MVP 대전제 |
| T2 | 4:5 커스텀 해상도 수락 여부 | 크롭이 필요하면 구도 프롬프트가 달라진다 |
| T3 | 응답 usage 회수 | 비용 표시 기능 전체의 전제 |
| T4 | 참조 이미지 입력 | "사진만 넣어도 생성" 시나리오의 전제 |
| T5 | 한국에서의 지연시간 | 장당 대기 × 11장 = 사용자 체감 |
| T6 | Gemini 대체 경로 생존 | 모델 은퇴·403·가격 인상 공통 보험 |

## 키 취급

API 키는 OS 보안 저장소(Electron `safeStorage` — macOS Keychain / Windows DPAPI)에
보관한다. keytar 는 유지보수가 끝났으므로 쓰지 않는다.
렌더러 프로세스는 키에 접근할 수 없게 하고(`contextIsolation: true`, IPC 화이트리스트),
API 호출은 작업 프로세스에서만 한다.
화면 코드·로그·내보내기 파일·프로젝트 묶음 어디에도 키를 넣지 않는다.

개발 중 임시 확인은 환경변수로만 하고 `.env` 는 커밋하지 않는다.

구조와 프로세스 경계는 [`docs/architecture.md`](docs/architecture.md).

## 아직 없는 것

- 사진 입력 화면 — 파이프라인은 사용자 제공 사진을 받게 되어 있으나 화면이 없다
- 본문 서식 적용(굵게·크기) — 네이버 업로더는 현재 평문으로 넣는다
- 사진 전처리(Sharp) — 사용자 제공 사진의 리사이즈·EXIF 회전·메타데이터 제거
- 인스타 Business Suite 입력 자동화 (베타 기능으로 예정, D1)
- 패키징·서명·자동 업데이트
