import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adjacentDocs,
  DOC_PAGES,
  docBody,
  docMarkdown,
  docMarkdownUrl,
  docsIndexMarkdown,
  DOCS_MD_MAX_BYTES,
  getDocPage,
  LEGACY_GUIDE_ANCHORS,
  llmResources,
} from "../src/lib/docs/index.ts";
import { escapeHtml, renderMarkdown, RENDERED_TAGS, safeHref } from "../src/lib/docs/markdown.ts";
import { DOCS_MD_PATH_RE, docsMarkdownRewrite } from "../src/lib/docs/paths.ts";
import {
  ANSWERS_TEMPLATE,
  APPROVAL_RULE,
  cliPrefix,
  connectPrompt,
  connectPromptWithAnswers,
  DEPLOY_SKILL,
  mcpInstall,
  POWERSHELL_UTF8,
  PRIVACY_QUESTIONS,
  secretGuidance,
  SKILL_AGENTS,
  skillSource,
  skillsAddCommand,
  windowsCli,
} from "../src/lib/runbook.ts";

// 사용 문서(src/lib/docs): 사람용 화면과 AI(LLM)용 원문이 같은 원본에서 나오는지, 크기·링크·안전한 렌더링을 확인한다.

const LOCAL = "http://localhost:3000";
const LAN = "http://192.168.0.5:3100";
const PUBLIC = "https://dandi.gne.go.kr";
const LONG = "https://dandi-hubprototype.teachers.gyeongnam-edu.example.kr"; // 60자
const HUBS = [LOCAL, LAN, PUBLIC, LONG];
const TAG = "0.2.0-1a2b3c4d";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const cliFor = (hub: string) => cliPrefix(hub, TAG);

/** 코드 블록과 인라인 코드를 뺀 본문(원문 HTML·문체 검사용) */
function withoutCode(md: string): string {
  return md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

const TAG_RE = /<\/?([a-zA-Z0-9]+)((?:\s+[a-z]+="[^"<>]*")*)\s*>/g;
const ALLOWED_ATTRS = new Set(["id", "href", "start", "class"]);

/** 렌더러가 만든 태그만 있는지 확인하고, 태그를 뺀 나머지에 '<'가 남지 않았는지 본다. */
function assertSafeHtml(html: string, label: string) {
  for (const m of html.matchAll(TAG_RE)) {
    assert.ok((RENDERED_TAGS as readonly string[]).includes(m[1]), `${label}: 허용하지 않은 태그 <${m[1]}>`);
    for (const a of m[2].matchAll(/\s+([a-z]+)="([^"]*)"/g)) {
      assert.ok(ALLOWED_ATTRS.has(a[1]), `${label}: 허용하지 않은 속성 ${a[1]}`);
      if (a[1] === "href") assert.ok(!/^\s*(?:javascript|data|vbscript):/i.test(a[2]), `${label}: href ${a[2]}`);
    }
  }
  const rest = html.replace(TAG_RE, "");
  assert.ok(!rest.includes("<") && !rest.includes(">"), `${label}: 이스케이프되지 않은 꺾쇠`);
}

test("문서 목록: slug는 고유하고 주소 규칙에 맞으며, 모두 사람용 문서다", () => {
  const slugs = DOC_PAGES.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.deepEqual(slugs, [
    "start",
    "ai-publish",
    "web-upload",
    "cli",
    "mcp",
    "projects",
    "skills",
    "books",
    "privacy",
    "troubleshooting",
  ]);
  for (const p of DOC_PAGES) {
    assert.equal(p.audience, "human");
    assert.ok(p.title.length > 0 && p.summary.length > 0, p.slug);
    assert.ok(!slugs.includes("index") && !slugs.includes("md"), "index·md는 원문 라우트가 쓴다");
    assert.ok(DOCS_MD_PATH_RE.test(`/docs/${p.slug}.md`), p.slug);
    assert.equal(getDocPage(p.slug), p);
  }
  assert.equal(getDocPage("nope"), null);
  assert.equal(adjacentDocs("start").prev, null);
  assert.equal(adjacentDocs("start").next?.slug, "ai-publish");
  assert.equal(adjacentDocs("troubleshooting").next, null);
});

test("모든 문서가 모든 허브 주소에서 렌더링되고, 원문 HTML 없이 허용한 태그만 나온다", () => {
  for (const hub of HUBS) {
    const cli = cliFor(hub);
    for (const p of DOC_PAGES) {
      const { html, toc } = renderMarkdown(docBody(p, hub, cli), { origin: hub });
      assert.ok(html.length > 200, `${hub} ${p.slug}`);
      assert.ok(toc.length >= 2, `${hub} ${p.slug} 차례`);
      assert.equal(new Set(toc.map((t) => t.id)).size, toc.length, `${p.slug} 앵커 중복`);
      for (const t of toc) assert.ok(html.includes(`<h2 id="${escapeHtml(t.id)}">`), `${p.slug} #${t.id}`);
      assertSafeHtml(html, `${hub} ${p.slug}`);
      // 허브 안 링크는 경로만 남아 프록시 뒤에서도 열린다.
      assert.ok(!html.includes(`href="${hub}/`), `${p.slug}: 허브 절대 링크가 남음`);
    }
  }
});

test("AI(LLM)용 원문: 12KB 이하, 원문 HTML 없음, 절대 주소, 문서 간 링크는 .md", () => {
  assert.equal(DOCS_MD_MAX_BYTES, 12 * 1024);
  for (const hub of HUBS) {
    const cli = cliFor(hub);
    const index = docsIndexMarkdown(hub);
    assert.ok(bytes(index) <= DOCS_MD_MAX_BYTES, `${hub} index ${bytes(index)}B`);
    for (const p of DOC_PAGES) {
      const md = docMarkdown(p, hub, cli);
      const label = `${hub} ${p.slug}`;
      assert.ok(bytes(md) <= DOCS_MD_MAX_BYTES, `${label} ${bytes(md)}B`);
      assert.ok(md.startsWith(`# ${p.title}\n\n> ${p.summary}\n`), label);
      const prose = withoutCode(md);
      assert.ok(!/<\/?[A-Za-z][^>]*>/.test(prose), `${label}: 원문 HTML`);
      // 링크 대상은 모두 절대 주소
      for (const m of md.matchAll(/\]\(([^)]*)\)/g)) {
        assert.ok(/^(?:https?:\/\/|cursor:\/\/|vscode:)/.test(m[1]), `${label}: 상대 링크 ${m[1]}`);
      }
      // 사람용 문서 링크는 .md로 바뀐다(맺음의 "사람용 페이지" 한 줄만 예외).
      for (const other of DOC_PAGES) {
        const human = `(${hub}/docs/${other.slug})`;
        assert.ok(!md.includes(human), `${label}: ${human}`);
      }
      assert.ok(md.includes(`- 사람용 페이지: ${hub}/docs/${p.slug}\n`), label);
      assert.ok(md.includes(`${hub}/docs/index.md`), label);
      assert.ok(md.includes(`${hub}/llms.txt`), label);
    }
  }
});

test("문서 목록 원문(/docs/index.md)이 모든 문서의 .md 주소와 AI용 주소를 싣는다", () => {
  for (const hub of HUBS) {
    const index = docsIndexMarkdown(hub);
    for (const p of DOC_PAGES) {
      assert.ok(index.includes(`- [${p.title}](${hub}/docs/${p.slug}.md): ${p.summary}`), `${hub} ${p.slug}`);
      assert.equal(docMarkdownUrl(hub, p.slug), `${hub}/docs/${p.slug}.md`);
    }
    for (const r of llmResources(hub)) assert.ok(index.includes(r.url), r.url);
    assert.ok(!/<\/?[A-Za-z][^>]*>/.test(withoutCode(index)));
  }
  const urls = llmResources(PUBLIC).map((r) => r.url);
  assert.deepEqual(urls, [
    `${PUBLIC}/llms.txt`,
    `${PUBLIC}/llms-full.txt`,
    `${PUBLIC}/docs/index.md`,
    `${PUBLIC}/docs/<slug>.md`,
    `${PUBLIC}/.well-known/agent-skills/index.json`,
    `${PUBLIC}/mcp`,
  ]);
});

test("/docs/<slug>.md rewrite 규칙", () => {
  assert.equal(docsMarkdownRewrite("/docs/start.md"), "/docs/md/start");
  assert.equal(docsMarkdownRewrite("/docs/ai-publish.md"), "/docs/md/ai-publish");
  assert.equal(docsMarkdownRewrite("/docs/index.md"), "/docs/md/index");
  for (const p of ["/docs/start", "/docs/.md", "/docs/Start.md", "/docs/a/b.md", "/docs/../x.md", "/docs/-x.md", "/x/start.md", "/docs/start.md/"]) {
    assert.equal(docsMarkdownRewrite(p), null, p);
  }
});

test("명령·문구를 runbook.ts에서 가져와 /llms.txt·/connect와 어긋나지 않는다", () => {
  for (const hub of HUBS) {
    const cli = cliFor(hub);
    const md = (slug: string) => docMarkdown(getDocPage(slug)!, hub, cli);
    const privacy = md("privacy");
    for (const q of PRIVACY_QUESTIONS) assert.ok(privacy.includes(`${q.mark} ${q.question} (${q.answer})`), q.key);
    assert.ok(privacy.includes(APPROVAL_RULE));
    assert.ok(privacy.includes(secretGuidance(hub)));
    const aiPublish = md("ai-publish");
    assert.ok(aiPublish.includes(connectPrompt(hub, TAG)));
    // 답을 함께 보내는 문장은 채운 예시가 아니라 괄호 틀을 쓴다(예시 답이 그대로 등록되지 않게).
    assert.ok(aiPublish.includes(connectPromptWithAnswers(hub, TAG)));
    assert.ok(aiPublish.includes(ANSWERS_TEMPLATE));
    for (const q of PRIVACY_QUESTIONS) assert.ok(aiPublish.includes(q.question), q.key);
    const cliDoc = md("cli");
    assert.ok(cliDoc.includes(`\`${cli}\``));
    assert.ok(cliDoc.includes(`\`${windowsCli(cli)}\``));
    assert.ok(cliDoc.includes(POWERSHELL_UTF8));
    const m = mcpInstall(hub, TAG);
    const mcp = md("mcp");
    const lines = [
      m.claudeCode,
      m.claudeCodeStdio,
      m.codex,
      m.codexStdio,
      m.cursorDeeplink,
      m.vscodeDeeplink,
      m.antigravity,
      m.antigravityStdio,
      m.grok,
      m.grokStdio,
    ];
    for (const line of lines) assert.ok(mcp.includes(line), line);
    assert.ok(mcp.includes(`agy mcp add dandi -- ${cli} mcp`));
    assert.ok(mcp.includes(`grok mcp add dandi -- ${cli} mcp`));
    assert.equal(mcp.includes("커넥터 추가"), m.claudeAiConnector !== null, hub);
    const skills = md("skills");
    assert.ok(skills.includes(skillsAddCommand(hub, DEPLOY_SKILL)));
    assert.ok(skills.includes(`${skillSource(hub, DEPLOY_SKILL)} --skill ${DEPLOY_SKILL}`));
    for (const a of SKILL_AGENTS) assert.ok(skills.includes(`\`${a}\``), a);
    // 모든 CLI 명령은 이 허브의 태그 접두어를 쓴다(다른 실행 방식이 섞이지 않게).
    for (const p of DOC_PAGES) {
      const text = md(p.slug);
      assert.ok(!text.includes("dandi@latest") && !text.includes("dandi-0.2.0.tgz"), p.slug);
      for (const x of text.matchAll(/npx(?:\.cmd)? -y (\S+\.tgz)/g)) assert.equal(x[1], `${hub}/dandi-${TAG}.tgz`, p.slug);
    }
  }
  // 로컬 허브는 링크 대신 guide 명령 문장을 준다.
  assert.ok(docMarkdown(getDocPage("ai-publish")!, LOCAL, cliFor(LOCAL)).includes(`${cliFor(LOCAL)} guide`));
});

test("문체: 합니다체 문서에 느낌표와 이모지가 없다", () => {
  for (const p of DOC_PAGES) {
    const prose = withoutCode(docMarkdown(p, PUBLIC, cliFor(PUBLIC))).replace(/https?:\/\/\S+/g, "");
    assert.ok(!prose.includes("!"), `${p.slug}: 느낌표`);
    assert.ok(!/\p{Extended_Pictographic}/u.test(prose), `${p.slug}: 이모지`);
    assert.ok(!/VibeHub|vibehub/.test(prose), `${p.slug}: 예전 이름`);
  }
});

test("예전 /guide 앵커는 있는 문서에만 걸리고 서로 겹치지 않는다", () => {
  const ids = Object.values(LEGACY_GUIDE_ANCHORS).flat();
  assert.equal(new Set(ids).size, ids.length);
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) assert.ok(ids.includes(`step-${n}`), `step-${n}`);
  assert.ok(ids.includes("downloads"));
  for (const slug of Object.keys(LEGACY_GUIDE_ANCHORS)) assert.ok(getDocPage(slug), slug);
});

/* ---------- 렌더러 ---------- */

test("렌더러: 원문 HTML과 위험한 링크를 그대로 넣지 않는다", () => {
  const evil = [
    "<script>alert(1)</script>",
    "",
    '<img src=x onerror="alert(1)"> **<b>굵게</b>**',
    "",
    "[누르기](javascript:alert(1)) [데이터](data:text/html,x) [둘](//evil.example) [따옴표](https://a.example/\"onmouseover=x)",
    "",
    "- <iframe src=x></iframe>",
    "",
    "| <td>칸</td> | `<code>` |",
    "|---|---|",
    "| <svg onload=x> | a |",
    "",
    "```html",
    "<script>alert(2)</script>",
    "```",
    "",
    "## <em>제목</em>",
    "",
    "> <style>body{}</style>",
  ].join("\n");
  const { html } = renderMarkdown(evil);
  assertSafeHtml(html, "evil");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;script&gt;alert(2)&lt;/script&gt;"));
  assert.ok(!/href="(?:javascript|data):/i.test(html));
  assert.ok(!html.includes('href="//evil.example"'));
  assert.ok(!/<(?:script|img|iframe|svg|style|em|b)\b/i.test(html));
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("JaVaScRiPt:alert(1)"), null);
  assert.equal(safeHref("//evil.example"), null);
  assert.equal(safeHref("https://a.example/x y"), null);
  assert.equal(safeHref("https://hub.example/docs/cli", "https://hub.example"), "/docs/cli");
  assert.equal(safeHref("https://hub.example.evil/docs", "https://hub.example"), "https://hub.example.evil/docs");
  assert.equal(safeHref("cursor://anysphere.cursor-deeplink/mcp/install?name=dandi"), "cursor://anysphere.cursor-deeplink/mcp/install?name=dandi");
  assert.equal(safeHref("/docs/start.md"), "/docs/start.md");
  assert.equal(safeHref("#차례"), "#차례");
});

test("렌더러: 제목, 목록(중첩·번호 이어 가기), 코드, 링크, 굵게, 표, 인용", () => {
  const md = [
    "## 첫 제목",
    "",
    "문단 **굵게**와 `코드 <a>` 그리고 [링크](https://hub.example/docs/cli), 맨 주소 https://hub.example/llms.txt 를 봅니다.",
    "두 번째 줄은 같은 문단입니다.",
    "",
    "- 하나",
    "  - 안쪽",
    "- 둘",
    "",
    "3. 셋째",
    "4. 넷째",
    "",
    "```text",
    "npx -y x.tgz <폴더>",
    "```",
    "",
    "| 명령 | 뜻 |",
    "|---|---|",
    "| `a \\| b` | 파이프 |",
    "",
    "> 인용 문장",
    "",
    "## 첫 제목",
  ].join("\n");
  const { html, toc } = renderMarkdown(md, { origin: "https://hub.example" });
  assert.deepEqual(toc, [
    { id: "첫-제목", text: "첫 제목" },
    { id: "첫-제목-2", text: "첫 제목" },
  ]);
  assert.ok(html.includes('<h2 id="첫-제목">첫 제목</h2>'));
  assert.ok(html.includes("<strong>굵게</strong>"));
  assert.ok(html.includes("<code>코드 &lt;a&gt;</code>"));
  assert.ok(html.includes('<a href="/docs/cli">링크</a>'));
  assert.ok(html.includes('<a href="/llms.txt">https://hub.example/llms.txt</a> 를'));
  assert.ok(html.includes("같은 문단입니다.</p>"));
  assert.ok(html.includes("<ul><li>하나<ul><li>안쪽</li></ul></li><li>둘</li></ul>"));
  assert.ok(html.includes('<ol start="3"><li>셋째</li><li>넷째</li></ol>'));
  assert.ok(html.includes("<pre><code>npx -y x.tgz &lt;폴더&gt;</code></pre>"));
  assert.ok(html.includes("<td><code>a | b</code></td><td>파이프</td>"));
  assert.ok(html.includes("<blockquote><p>인용 문장</p></blockquote>"));
  assertSafeHtml(html, "features");
});
