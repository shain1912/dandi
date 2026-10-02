// 문서 페이지들이 함께 쓰는 작은 도우미. 명령·문구는 가능한 한 src/lib/runbook.ts에서 가져와
// /llms.txt·/llms-full.txt·/connect와 어긋나지 않게 한다.

import { CLI_VERSION_FALLBACK } from "../runbook.ts";

const BT = "`";

/** 인라인 코드 */
export function code(text: string): string {
  const fence = text.includes(BT) ? BT.repeat(2) : BT;
  return fence === BT ? `${BT}${text}${BT}` : `${fence} ${text} ${fence}`;
}

/** 코드 블록 */
export function fence(text: string, lang = "text"): string {
  return `${BT.repeat(3)}${lang}\n${text}\n${BT.repeat(3)}`;
}

/** 사람용 문서 주소. AI용 원문(/docs/<slug>.md)에서는 docMarkdown이 .md 주소로 바꾼다. */
export function docUrl(hub: string, slug: string): string {
  return `${hub}/docs/${slug}`;
}

/** 다른 문서로 가는 마크다운 링크 */
export function docLink(hub: string, slug: string, label: string): string {
  return `[${label}](${docUrl(hub, slug)})`;
}

const TARBALL_RE = /\/dandi-([^/\s]+)\.tgz$/;

/** 실행 접두어(npx -y <hub>/dandi-<태그>.tgz)에서 CLI 태그를 꺼낸다. */
export function versionFromCli(cli: string): string {
  return TARBALL_RE.exec(cli)?.[1] ?? CLI_VERSION_FALLBACK;
}

/**
 * skills CLI(vercel-labs/skills)의 도구 id와 설치 폴더(표시용). 설치 명령 자체는 runbook.ts의 skillsAddCommand를 쓴다.
 * 폴더는 skills CLI 소스의 skillsDir·globalSkillsDir 값이다.
 */
export const SKILL_AGENT_DIRS: readonly { id: string; label: string; dir: string; globalDir: string }[] = [
  { id: "claude-code", label: "Claude Code", dir: ".claude/skills", globalDir: "~/.claude/skills" },
  { id: "codex", label: "Codex", dir: ".agents/skills", globalDir: "~/.codex/skills" },
  { id: "cursor", label: "Cursor", dir: ".agents/skills", globalDir: "~/.cursor/skills" },
  { id: "antigravity-cli", label: "Antigravity CLI (agy)", dir: ".agents/skills", globalDir: "~/.gemini/antigravity-cli/skills" },
  { id: "antigravity", label: "Antigravity 편집기", dir: ".agents/skills", globalDir: "~/.gemini/antigravity/skills" },
  { id: "grok", label: "Grok", dir: ".grok/skills", globalDir: "~/.grok/skills" },
];

/** /docs 목록과 /docs/index.md가 함께 쓰는 "AI(LLM)가 읽는 페이지" 목록 */
export interface LlmResource {
  /** 절대 주소. kind가 "pattern"이면 <slug> 자리표시가 든 주소 모양 */
  url: string;
  /** link: 열어 볼 수 있는 문서, pattern: 주소 모양, endpoint: 도구에 등록하는 주소(브라우저로 열 일이 없음) */
  kind: "link" | "pattern" | "endpoint";
  title: string;
  who: string;
}

export function llmResources(hub: string): LlmResource[] {
  return [
    {
      url: `${hub}/llms.txt`,
      kind: "link",
      title: "실행 런북(AI에게 주는 주소)",
      who: "사이트를 올려 달라고 할 때 AI 코딩 도구에 이 주소 하나를 줍니다. AI가 그대로 따라 하는 단계별 명령입니다.",
    },
    {
      url: `${hub}/llms-full.txt`,
      kind: "link",
      title: "전체 레퍼런스",
      who: "AI가 런북에 없는 명령·JSON·종료 코드·MCP 설정을 찾을 때 읽습니다.",
    },
    {
      url: `${hub}/docs/index.md`,
      kind: "link",
      title: "문서 목록(마크다운)",
      who: "AI가 사람용 문서 전체를 훑어볼 때 읽습니다.",
    },
    {
      url: `${hub}/docs/<slug>.md`,
      kind: "pattern",
      title: "각 문서의 마크다운 원문",
      who: "AI에게 특정 문서를 읽히거나 요약시킬 때 줍니다. 사람용 페이지와 내용이 같습니다.",
    },
    {
      url: `${hub}/.well-known/agent-skills/index.json`,
      kind: "link",
      title: "스킬 설치 목록",
      who: "npx skills add 같은 스킬 설치 도구가 읽습니다. 사람이 열 일은 없습니다.",
    },
    {
      url: `${hub}/mcp`,
      kind: "endpoint",
      title: "MCP 서버 주소",
      who: "AI 도구에 Dandi를 MCP로 연결할 때 등록합니다. 연결은 브라우저에서 승인합니다.",
    },
  ];
}
