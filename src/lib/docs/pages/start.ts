import type { DocPage } from "../types.ts";
import { code, docLink } from "../shared.ts";

export const doc: DocPage = {
  slug: "start",
  title: "시작하기",
  summary: "Dandi가 무엇인지, 로그인 없이 쓸 수 있는 것과 교사 로그인이 필요한 것, 처음 만드는 순서를 안내합니다.",
  audience: "human",
  body: (hub) => `## Dandi는 무엇입니까

Dandi는 교사가 AI 코딩 도구로 만든 수업·업무용 미니앱과 사이트를 올리고 나누는 허브입니다. 올린 사이트는 허브가 직접 호스팅하고, 개인정보 셀프점검을 거쳐 미니앱 목록에 공개됩니다.

- 미니앱: 교사가 만든 웹앱을 학생과 동료 교사가 브라우저에서 바로 실행합니다.
- 사이트 올리기: AI에게 주소 하나를 주면 AI가 사이트를 올리고 비공개 미리보기를 보여 줍니다.
- 커뮤니티·자료실·템플릿·스킬·서가: 질문과 자료, 앱 뼈대, AI 작업 설명서, 웹북과 PDF를 나눕니다.

## 로그인 없이 쓸 수 있는 것

학생과 방문자는 로그인하지 않아도 됩니다.

- 공개된 미니앱 실행: ${hub}/apps
- 커뮤니티 글 읽기, 자료실 자료 내려받기
- 템플릿과 스킬 둘러보기, 공개된 책 읽기: ${hub}/books

## 교사 로그인이 필요한 것

사이트 올리기, 미니앱 등록, 글쓰기, 자료 올리기, 프로젝트·API 키 발급, 스킬 게시, 책 등록은 교사 로그인 후 사용할 수 있습니다.

- 로그인: ${hub}/login
- 프로토타입에서는 이름과 학교급만 입력하는 데모 로그인을 씁니다. 같은 이름과 역할로 다시 로그인하면 같은 계정입니다. 비밀번호가 없으므로 시연용으로만 쓰십시오.
- AI 도구가 로그인할 때도 이 브라우저의 교사 로그인으로 승인합니다. 토큰을 복사하거나 붙여 넣지 않습니다.

## 처음 만드는 순서

1. 템플릿 갤러리(${hub}/templates)에서 만들고 싶은 앱과 비슷한 템플릿을 고르고, 작업 지시서를 복사해 프로젝트 폴더의 ${code("docs/work-order.md")}로 저장합니다.
2. 아래 llms.txt와 DESIGN.md를 프로젝트 폴더 맨 위에 두고, AI 코딩 도구에 작업 지시서대로 만들어 달라고 요청합니다. 학생 개인정보는 입력받거나 저장하지 말라고 함께 적으십시오.
3. 브라우저에서 동작을 확인합니다. 휴대전화 너비(360px)에서 가로 스크롤이 없는지도 봅니다.
4. 완성되면 ${docLink(hub, "ai-publish", "AI에게 URL 하나 주고 사이트 올리기")}를 따릅니다.

## 내려받기 자료

| 파일 | 용도 | 둘 곳 |
|---|---|---|
| [llms.txt](${hub}/downloads/llms.txt) | 프로젝트 명세서. AI가 앱의 목적과 규칙을 먼저 읽습니다. | 프로젝트 루트 |
| [DESIGN.md](${hub}/downloads/DESIGN.md) | 색, 글꼴, 간격, 컴포넌트를 정한 디자인 명세 | 프로젝트 루트 |
| [SKILL.md](${hub}/downloads/SKILL.md) | 배포 스킬(dandi-deploy) 파일 | ${docLink(hub, "skills", "스킬 설치")} 참고 |
| [privacy-checklist.md](${hub}/downloads/privacy-checklist.md) | 개인정보 셀프점검표(임시 기준) | 프로젝트의 docs 폴더 |
| [mcp-guide.md](${hub}/downloads/mcp-guide.md) | Supabase·Vercel MCP 연동 가이드 | 읽기 자료 |

프로젝트에 두는 llms.txt는 허브의 ${hub}/llms.txt (AI 실행 런북)와 이름만 같고 역할이 다릅니다.

## 다음에 읽을 문서

- ${docLink(hub, "ai-publish", "AI에게 URL 하나 주고 사이트 올리기")}: 가장 빠른 방법입니다.
- ${docLink(hub, "web-upload", "웹에서 폴더 올리기")}: 터미널 없이 브라우저에서 올립니다.
- ${docLink(hub, "privacy", "개인정보 셀프점검")}: 공개 전에 답하는 5문항입니다.
`,
};
