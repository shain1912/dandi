# Dandi v0.2 프로토타입

교사·학생용 바이브코딩 & 미니앱 허브의 기능 확인용 프로토타입입니다. **처음 맡는 분은 [`HANDOVER.md`](./HANDOVER.md)부터 읽으십시오.** 요구사항은 [`docs/planning/PRD.md`](./docs/planning/PRD.md) v0.4를 따르며, 디자인은 최소화하고 기능 동작에 집중했습니다. v0.2에서 추가한 기능(PRD 15장)의 근거는 [벤치마크 문서](./docs/planning/벤치마크_AI연결_프로젝트키_스킬_전자책_20260928.md)에 있습니다.

## v0.2에서 추가한 것

| 기능 | 주소 | PRD |
|---|---|---|
| **AI에게 링크만 주면 사이트가 올라감** — AI가 읽는 실행 런북 | `/llms.txt`, `/llms-full.txt`, `/connect` | F-55, F-56 |
| 허브가 사이트를 직접 호스팅(비공개 미리보기 → 셀프점검 → 공개) | `/studio/sites`, `http://<이름>.localhost:3000` | F-51, F-52 |
| CLI 브라우저 승인 로그인(토큰 복사 없음), 에이전트용 `--json`·종료 코드 | `/device`, `npx -y <허브>/dandi-0.2.0.tgz` | F-53, F-54 |
| 원격 MCP + OAuth(힉스필드 방식), stdio MCP | `/mcp`, `/oauth/*`, `dandi mcp` | F-57, F-58 |
| 프로젝트별 API 키(Edge Impulse 방식: 여러 키·역할·1회 표시·만료·마지막 사용) | `/studio/projects` | F-31~F-35 |
| 스킬 레지스트리(skills.sh 방식, `npx skills add <허브>`) | `/skills`, `/.well-known/agent-skills/index.json` | F-37~F-41 |
| 전자책 서가(웹북 리더·PDF 리더·저작권 게이트) | `/books` | F-43~F-45 |

외부 계정 없이 로컬에서 바로 실행되도록 PRD 8장의 대체 목록(세션 쿠키, 데모 로그인, 로컬 JSON 저장소, 로컬 파일 저장소, 모의 AI 응답)을 적용했습니다.

## 실행

Node.js 22 이상이 필요합니다.

```bash
npm install
npm run dev          # http://localhost:3000 (CLI tarball·PDF 뷰어 파일을 먼저 만듭니다)
```

처음 실행하면 `data/db.json`이 시드 데이터(예시 미니앱 3개, 템플릿 4개, 게시글 2개, AI 모델 7개, 스킬 4개, 코드코리아 웹북 1권)로 만들어집니다. 처음 상태로 되돌리려면 `data/` 폴더를 삭제하십시오. 데이터 위치는 `DANDI_DATA_DIR` 환경 변수로 바꿀 수 있습니다.

```bash
npm test             # 개인정보 필터·CLI·런북·서가 단위 테스트
npm run typecheck
npm run lint
npm run build && npx next start
```

## AI에게 "내 사이트 올려줘" 시키기

1. 사이트 폴더(예: `index.html`이 있는 폴더)에서 AI 코딩 도구(Claude Code, Codex, Cursor 등)를 엽니다.
2. `/connect` 화면의 문장을 붙여 넣습니다. 로컬 허브는 WebFetch가 `localhost`를 막으므로 다음처럼 명령을 쓰는 문장을 줍니다.
   ```text
   npx -y http://localhost:3000/dandi-0.2.0.tgz guide 를 실행해 나온 안내를 그대로 따라 해서, 이 폴더의 사이트를 Dandi에 올려줘.
   ```
   공개 HTTPS 허브라면 `https://<허브>/llms.txt 를 읽고 …`로 충분합니다.
3. AI가 보여 주는 링크를 열어 화면의 코드가 같으면 **[승인]** 합니다(토큰을 복사하거나 대화창에 붙여 넣지 않습니다).
4. AI가 비공개 미리보기 주소를 보여 주고 셀프점검 5문항을 묻습니다. 답하면 허브에 등록되고 앱 주소가 나옵니다.

MCP로 연결하려면 `/connect`의 한 줄을 씁니다. 예) `claude mcp add --transport http dandi http://localhost:3000/mcp` → Claude Code에서 `/mcp` → 브라우저에서 허용.

## 시연 순서

1. 로그인하지 않은 상태로 허브(`/`)에서 미니앱을 실행하고, `/books`에서 코드코리아 웹북을 읽습니다.
2. `/login`에서 교사로 데모 로그인합니다(관리자 화면은 역할을 "교육청 관리자(데모)"로 선택). 같은 이름·역할이면 같은 계정입니다.
3. 위의 "AI에게 내 사이트 올려줘"를 실행합니다. 학교 내부 승인이 필요하다고 답하면 승인 대기로 등록되고, `/studio/sites`나 `/admin`에서 승인 완료를 표시해야 공개됩니다.
4. `/studio/projects`에서 프로젝트를 만들고 API 키를 발급(원문 1회 표시)한 뒤 `/ai`에서 게이트웨이를 호출합니다.
5. `/skills`에서 스킬 설치 명령을 복사해 AI 코딩 도구에 설치하고, `/skills/new`에서 스킬을 게시합니다.
6. `/community/new`에서 전화번호 등을 입력하면 경고가 나오고 등록이 막힙니다.
7. 관리자로 `/admin`에서 모델 상태, 스킬 검토, 감사 로그를 확인합니다.

## 운영 환경 변수

로컬 시연에는 필요 없습니다. 공개 서버에 올릴 때는 다음을 설정하십시오.

| 변수 | 의미 |
|---|---|
| `HUB_ORIGIN` | 허브 주소(예: `https://dandi.example.kr`). OAuth 발급자·설치 명령·런북의 주소가 됩니다. **반드시 설정**하십시오. |
| `SITES_DOMAIN` | 교사 사이트 전용 도메인(예: `dandi-sites.kr`, 와일드카드 DNS·TLS 필요). 사이트는 `https://<이름>.<도메인>`에서 서빙되어 허브 세션과 분리됩니다. |
| `TRUST_PROXY=1` | 믿을 수 있는 리버스 프록시 뒤에서만 켭니다. 켜면 `X-Forwarded-Host/Proto/For`를 사용합니다(가장 오른쪽 IP). |
| `DANDI_OAUTH_SECRET` | 서버를 여러 대로 돌려 `data/`를 공유하지 않을 때 32자 이상으로 설정합니다(갱신 토큰 재전송 허용용). |
| `DANDI_DATA_DIR` | 저장소 위치. 기본은 `data/`. |

CLI는 `public/dandi-<버전>-<해시>.tgz`로 배포됩니다. 내용이 바뀌면 파일 이름이 바뀌므로, 이미 `npx`로 실행한 PC도 새 CLI를 받습니다(같은 이름이면 `npx`가 캐시된 옛 CLI를 계속 실행합니다).

## E2E

실제 Chrome으로 전체 시나리오를 확인하려면 서버를 3100번 포트에서 별도 데이터 폴더로 띄운 뒤 실행합니다.

```bash
npm run build
DANDI_DATA_DIR=/tmp/dandi-e2e npx next start -p 3100
node e2e/demo.e2e.mjs          # 다른 주소는 BASE_URL=http://... 로 지정
```

데모 로그인은 비밀번호가 없는 시연용입니다. 로그아웃하면 서버의 로그인 세션이 폐기됩니다.

## 주요 경로

| 경로 | 기능 (PRD ID) |
|---|---|
| `/`, `/apps`, `/apps/[id]` | 허브, 미니앱 목록·무로그인 실행 (F-04~F-06) |
| `/studio`, `/studio/apps`, `/studio/sites`, `/studio/projects` | 교사 스튜디오: 앱·사이트·프로젝트 (F-04, F-16, F-31, F-51) |
| `/connect`, `/llms.txt`, `/llms-full.txt` | AI 에이전트 연결 (F-55, F-56) |
| `/device`, `/api/cli/*`, `cli/` | CLI 로그인·API·명령 (F-53, F-54, F-58) |
| `/mcp`, `/oauth/*`, `/.well-known/oauth-*` | 원격 MCP와 OAuth (F-57) |
| `/api/sites/*`, `http://<이름>.localhost:3000` | 정적 호스팅 (F-51) |
| `/ai`, `/api/ai/chat`, `/api/ai/models` | 모델 가이드·게이트웨이 (F-21~F-23, F-32) |
| `/skills`, `/.well-known/agent-skills/*`, `/admin/skills` | 스킬 레지스트리 (F-37~F-40) |
| `/books`, `/api/files/[id]/view` | 전자책 서가 (F-43~F-45) |
| `/community`, `/files`, `/templates`, `/guide` | 게시판·자료실·템플릿·가이드 (F-07~F-12) |
| `/admin` | 모델 정책, 승인 대기 앱, 감사 로그 (F-23, F-24, F-27) |

## 코드 구조

- `src/lib/` — 도메인 로직. Supabase로 옮길 때는 `db.ts`와 각 도메인 파일만 바꾸면 됩니다.
  - `pii.ts`, `text.ts`: 개인정보 검사기(클라이언트·서버 공용)와 입력 정리
  - `session.ts`, `agent-auth.ts`, `device-auth.ts`, `oauth.ts`: 세션·CLI·MCP 인증
  - `sites.ts`, `blobs.ts`: 정적 호스팅과 내용 주소 저장소
  - `projects.ts`, `ai.ts`: 프로젝트 키와 AI 게이트웨이
  - `skills.ts`, `books.ts`, `runbook.ts`, `mcp-tools.ts`: 스킬·서가·에이전트 런북·MCP 도구
- `cli/` — 의존성 없는 `dandi` CLI(stdio MCP 포함). `npm run pack:cli`가 `public/dandi-<버전>.tgz`를 만듭니다.
- `docs/v0.2-contracts.md` — v0.2 병렬 개발에 쓴 인터페이스 계약
- `e2e/` — 실제 Chrome E2E(`node e2e/demo.e2e.mjs`)
