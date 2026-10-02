import { DEPLOY_SKILL, SKILLS_CLI, skillsAddCommand } from "../../runbook.ts";
import type { DocPage } from "../types.ts";
import { code, docLink, fence, SKILL_AGENT_DIRS } from "../shared.ts";

export const doc: DocPage = {
  slug: "skills",
  title: "스킬 설치와 게시",
  summary: "AI 코딩 도구가 따라 하는 작업 설명서(스킬)를 Claude Code, Codex, Cursor, Antigravity, Grok에 설치하고 게시하는 방법입니다.",
  audience: "human",
  body: (hub, cli) => `스킬은 AI 코딩 도구가 읽고 따라 하는 작업 설명서(SKILL.md)입니다. 공개 스킬 목록은 ${hub}/skills 에 있습니다.

## 배포 스킬(${DEPLOY_SKILL})

${DEPLOY_SKILL}를 설치하면 "Dandi에 올려 줘"라고만 해도 AI가 허브의 런북을 읽고 ${docLink(hub, "ai-publish", "AI에게 URL 하나 주고 사이트 올리기")}와 같은 순서(브라우저 승인 로그인, 비공개 미리보기, 셀프점검, 허브 등록)를 따릅니다. 프로젝트 폴더의 터미널에서 아래 한 줄을 실행하면 Claude Code, Cursor, Codex, Antigravity, Grok에 한 번에 설치됩니다.

${fence(skillsAddCommand(hub, DEPLOY_SKILL))}

- 쓰지 않는 도구의 ${code("-a")} 항목은 빼도 됩니다. Node.js 18 이상이 필요합니다.
- ${code(SKILLS_CLI)} 를 그대로 두십시오. ${code("-a grok")} 은 skills 1.7.0부터 받으며, npx가 예전에 받아 둔 사본을 쓰면 설치 전체가 실패합니다.

## 도구별 설치 위치

| 도구 | -a 값 | 프로젝트 폴더 | 전역(-g) 폴더 |
|---|---|---|---|
${SKILL_AGENT_DIRS.map((a) => `| ${a.label} | ${code(a.id)} | ${code(a.dir)} | ${code(a.globalDir)} |`).join("\n")}

- ${code("-g")} 를 붙이면 모든 프로젝트에서 쓰도록 사용자 폴더에 설치합니다.
- Codex, Cursor, Antigravity는 같은 ${code(".agents/skills")} 폴더를 읽습니다. Grok은 ${code(".grok/skills")} 와 함께 ${code(".agents/skills")}, ${code(".claude/skills")} 도 읽습니다.
- Grok은 신뢰한 폴더에서만 프로젝트 폴더의 스킬을 읽습니다. 처음 여는 폴더라면 Grok에서 ${code("/hooks-trust")} 를 실행하고, 한 번에 실행하는 방식(${code("grok -p")})에는 ${code("--trust")} 를 붙이십시오. 폴더마다 신뢰하기 번거로우면 ${code("-g")} 로 사용자 폴더(${code("~/.grok/skills")})에 설치합니다.
- dandi CLI로도 설치할 수 있습니다. ${code("--agent")} 를 빼면 CLI의 기본 도구에 설치합니다.

${fence(`${cli} skill add ${DEPLOY_SKILL} --agent codex,antigravity-cli,grok`)}

- 설치 도구가 읽는 목록은 ${hub}/.well-known/agent-skills/index.json 입니다.

## 찾기

- 화면: ${hub}/skills
- 터미널: ${code(`${cli} skill list <검색어>`)}
- 스킬 화면마다 도구별 설치 명령이 있습니다.

## 게시

1. 스킬 폴더에 SKILL.md를 둡니다. 맨 위 머리말(front matter)에 name(영문 소문자, 숫자, 하이픈 64자 이하), description(1~1024자), license가 있어야 합니다.
2. ${code(`${cli} skill publish <폴더>`)} 를 실행하거나 ${hub}/skills/new 에서 게시합니다. 교사 로그인이 필요합니다.
3. 프롬프트만 있는 스킬은 자동 검토 후 바로 공개됩니다. scripts 폴더나 훅이 있는 스킬은 관리자 검토를 거친 뒤 공개됩니다.
4. 게시할 때마다 바뀌지 않는 새 버전이 생깁니다. 검토 대기나 반려된 버전은 나와 관리자에게만 보입니다.

## 안전

- 스킬에 학생 개인정보, API 키, 토큰을 넣지 마십시오.
- 스크립트가 든 스킬은 설치하기 전에 스킬 화면에서 내용을 읽어 보십시오.
- AI 도구가 스킬을 따르다 명령 실행 허락을 물으면, 무엇을 하는 명령인지 확인한 뒤 허락하십시오.
`,
};
