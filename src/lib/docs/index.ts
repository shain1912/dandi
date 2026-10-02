// 사용 문서의 단일 원본. 사람용 화면(/docs, /docs/<slug>)과 AI(LLM)용 원문(/docs/index.md, /docs/<slug>.md)이
// 모두 여기서 나온다. 명령·문구는 src/lib/runbook.ts에서 가져와 /llms.txt·/connect와 어긋나지 않게 한다.
// Next.js·server-only를 import하지 않는다(tests/docs.test.ts가 node --experimental-strip-types로 직접 import).

import { normalizeHubOrigin } from "../runbook.ts";
import type { DocPage } from "./types.ts";
import { docUrl, llmResources } from "./shared.ts";
import { doc as start } from "./pages/start.ts";
import { doc as aiPublish } from "./pages/ai-publish.ts";
import { doc as webUpload } from "./pages/web-upload.ts";
import { doc as cliDoc } from "./pages/cli.ts";
import { doc as mcp } from "./pages/mcp.ts";
import { doc as projects } from "./pages/projects.ts";
import { doc as skills } from "./pages/skills.ts";
import { doc as books } from "./pages/books.ts";
import { doc as privacy } from "./pages/privacy.ts";
import { doc as troubleshooting } from "./pages/troubleshooting.ts";

export type { DocPage } from "./types.ts";
export { llmResources } from "./shared.ts";
export type { LlmResource } from "./shared.ts";

/** 읽는 순서대로 */
export const DOC_PAGES: readonly DocPage[] = [
  start,
  aiPublish,
  webUpload,
  cliDoc,
  mcp,
  projects,
  skills,
  books,
  privacy,
  troubleshooting,
];

/** AI(LLM)용 원문 한 개의 크기 상한(WebFetch 요약을 피하려고 작게 둔다) */
export const DOCS_MD_MAX_BYTES = 12 * 1024;

/**
 * 예전 /guide(따라하기 가이드)의 앵커. /guide는 /docs로 영구 이동하고 브라우저는 #앵커를 그대로 가져가므로,
 * /docs 목록에서 같은 id를 새 문서 옆에 둔다. #connect는 목록 맨 위 "AI에게 줄 주소" 상자다.
 */
export const LEGACY_GUIDE_ANCHORS: Readonly<Record<string, readonly string[]>> = {
  start: ["step-1", "step-2", "step-3", "step-4", "downloads"],
  "ai-publish": ["step-6", "step-7"],
  privacy: ["step-5"],
  projects: ["step-8"],
};

export function getDocPage(slug: string): DocPage | null {
  return DOC_PAGES.find((p) => p.slug === slug) ?? null;
}

/** 목록에서 앞뒤 문서 */
export function adjacentDocs(slug: string): { prev: DocPage | null; next: DocPage | null } {
  const i = DOC_PAGES.findIndex((p) => p.slug === slug);
  if (i < 0) return { prev: null, next: null };
  return { prev: DOC_PAGES[i - 1] ?? null, next: DOC_PAGES[i + 1] ?? null };
}

/** AI(LLM)용 원문 주소 */
export function docMarkdownUrl(hub: string, slug: string): string {
  return `${normalizeHubOrigin(hub)}/docs/${slug}.md`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 본문 속 사람용 문서 링크(<hub>/docs/<slug>, <hub>/docs)를 AI용 원문 주소(.md)로 바꾼다. */
function toMarkdownLinks(markdown: string, hub: string): string {
  const slugs = DOC_PAGES.map((p) => escapeRe(p.slug)).join("|");
  const base = escapeRe(`${hub}/docs`);
  return markdown
    .replace(new RegExp(`${base}/(${slugs})(?=[)\\s]|$)`, "g"), `${hub}/docs/$1.md`)
    .replace(new RegExp(`${base}(?=[)\\s]|$)`, "g"), `${hub}/docs/index.md`);
}

/** 사람용 화면이 그리는 본문 마크다운 */
export function docBody(page: DocPage, hub: string, cli: string): string {
  return page.body(normalizeHubOrigin(hub), cli);
}

/** /docs/<slug>.md 원문: 제목, 요약, 본문(링크는 .md 주소), 관련 주소 */
export function docMarkdown(page: DocPage, hub: string, cli: string): string {
  const h = normalizeHubOrigin(hub);
  const body = toMarkdownLinks(page.body(h, cli).trim(), h);
  return `# ${page.title}

> ${page.summary}

${body}

## 관련 주소

- 사람용 페이지: ${docUrl(h, page.slug)}
- 문서 목록: ${h}/docs/index.md
- AI 에이전트 실행 런북: ${h}/llms.txt
`;
}

/** /docs/index.md: 모든 문서의 한 줄 요약과 절대 주소, AI(LLM)용 주소 목록 */
export function docsIndexMarkdown(hub: string): string {
  const h = normalizeHubOrigin(hub);
  const pages = DOC_PAGES.map((p) => `- [${p.title}](${h}/docs/${p.slug}.md): ${p.summary}`).join("\n");
  const resources = llmResources(h)
    .map((r) => `- ${r.kind === "pattern" ? `\`${r.url}\`` : r.url} (${r.title}): ${r.who}`)
    .join("\n");
  return `# Dandi 문서 목록

> 교사가 읽는 Dandi 사용 문서의 마크다운 원문 목록입니다. 사이트를 올려 달라는 요청을 받은 AI 에이전트는 이 목록 대신 ${h}/llms.txt 를 읽고 그대로 따르십시오.

## 사람이 읽는 문서(마크다운 원문)

${pages}

## AI(LLM)가 읽는 페이지

${resources}

사람용 화면은 ${h}/docs 입니다.
`;
}
