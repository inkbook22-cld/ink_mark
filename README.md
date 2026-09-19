# INK 마케팅 스튜디오

글감·사진을 넣으면 블로그 원고와 인스타 카드뉴스를 함께 만드는 맥·윈도우 설치형 앱.

현재 **1단계(연동 검증)** 단계다. 앱 본체는 아직 없다.

## 지금 있는 것

```
config/providers.json          모델 ID·단가·품질. 소스 하드코딩 금지 (D3)
scripts/verify-providers.mjs   1단계 연동 검증 — MVP 전제가 성립하는지 확인
scripts/render-card.mjs        템플릿 렌더 테스트 하네스 (Electron 없이 CI용)
templates/                     카드 템플릿. 합성은 HTML/CSS 단일 경로 (D2)
src/publish/naver/             블로그 임시저장. 붙여넣기 대신 타이핑한다
scripts/naver-draft.mjs        임시저장 CLI
docs/decisions.md              확정된 결정과 근거
```

## 1단계 검증 돌리기

유료 API 호출이 발생한다(전부 실행 시 $0.15 내외).

```bash
OPENAI_API_KEY=sk-... GEMINI_API_KEY=... node scripts/verify-providers.mjs
```

확인 항목:

| | 확인 대상 | 왜 먼저 확인하는가 |
|---|---|---|
| T1 | gpt-image-2 접근 (403 조직 인증) | "OpenAI 키 하나면 된다"는 MVP 대전제 |
| T2 | 4:5 커스텀 해상도 수락 여부 | 크롭이 필요하면 구도 프롬프트가 달라진다 |
| T3 | 응답 usage 회수 | 비용 표시 기능 전체의 전제 |
| T4 | 참조 이미지 입력 | "사진만 넣어도 생성" 시나리오의 전제 |
| T5 | 한국에서의 지연시간 | 장당 대기 × 11장 = 사용자 체감 |
| T6 | Gemini 대체 경로 생존 | 모델 은퇴·403·가격 인상 공통 보험 |

FAIL이 하나라도 있으면 2단계로 넘어가기 전에 전제를 고친다.

## 템플릿 렌더 확인

```bash
node scripts/render-card.mjs
# → scripts/out/card-preview.png, 글자 잘림 목록
```

## 네이버 임시저장

```bash
node scripts/naver-draft.mjs --blog-id myblog --title "제목" --file 원고.md
npm run test:typing            # 로컬 목업 대상 회귀 테스트
```

본문은 붙여넣지 않고 타이핑한다. 이유와 한계는
[`src/publish/naver/README.md`](src/publish/naver/README.md).

셀렉터는 `src/publish/naver/profile.json` 에 모여 있고 아직 실측되지 않았다
(`verifiedAt: null`). 실제 계정으로 한 번 통과시킨 뒤 날짜를 기록할 것.

## 키 취급

API 키는 OS 보안 저장소(Electron `safeStorage` — macOS Keychain / Windows DPAPI)에
보관한다. keytar는 유지보수가 끝났으므로 쓰지 않는다.
렌더러 프로세스는 키에 접근할 수 없게 하고(`contextIsolation: true`, IPC 화이트리스트),
API 호출은 작업 프로세스에서만 한다.
화면 코드·로그·내보내기 파일·프로젝트 묶음 어디에도 키를 넣지 않는다.

개발 중 임시 확인은 환경변수로만 하고, `.env` 는 커밋하지 않는다.
