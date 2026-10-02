// 문서용 작은 마크다운 렌더러. 본문은 우리가 쓴 것이지만 원문 HTML은 절대 그대로 넣지 않는다.
// 모든 글자를 먼저 이스케이프하고, 아래 문법만 우리 태그로 바꾼다.
//   블록: #~#### 제목, 문단, - / * 목록, 1. 번호 목록(들여쓰기로 중첩), ``` 코드 블록, | 표, > 인용
//   인라인: `코드`, **굵게**, [글](주소), 맨 http(s) 주소, \ 이스케이프
// 링크는 http(s)·cursor://·vscode:·/경로·#앵커만 허용한다(javascript: 등은 글자로만 남긴다).
// Next.js·Node 전용 모듈을 쓰지 않는다(tests/docs.test.ts가 node --experimental-strip-types로 직접 import).

export interface TocItem {
  id: string;
  text: string;
}

export interface RenderOptions {
  /** 이 주소로 시작하는 절대 링크는 경로만 남긴다(허브 안 링크가 프록시 뒤에서도 열리게). */
  origin?: string;
}

export interface RenderedMarkdown {
  html: string;
  /** ## 제목 목록(차례) */
  toc: TocItem[];
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** 링크로 써도 되는 주소면 href 값을, 아니면 null. */
export function safeHref(url: string, origin?: string): string | null {
  if (/[\s\\<>"'`]/.test(url) || /[\u0000-\u001f\u007f]/.test(url)) return null;
  if (/^https?:\/\/[^/]/i.test(url)) {
    if (origin && (url === origin || url.startsWith(`${origin}/`) || url.startsWith(`${origin}#`) || url.startsWith(`${origin}?`))) {
      return url.slice(origin.length) || "/";
    }
    return url;
  }
  if (/^cursor:\/\//i.test(url) || /^vscode:/i.test(url)) return url;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  if (url.startsWith("#")) return url;
  return null;
}

/* ---------- 인라인 ---------- */

const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
// 맨 주소: 한국어 조사가 붙어도 주소에 섞이지 않게 ASCII만 받는다. *는 굵게 표시와 헷갈리므로 뺀다.
const BARE_URL_RE = /^https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'+,;=%]+/;
const LINK_RE = /^\[([^\]\n]+)\]\(([^()\s]+)\)/;

function renderInline(text: string, opts: RenderOptions): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length && PUNCT.includes(text[i + 1])) {
      out += escapeHtml(text[i + 1]);
      i += 2;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      const fence = "`".repeat(run);
      const end = text.indexOf(fence, i + run);
      if (end > i) {
        const code = text.slice(i + run, end);
        out += `<code>${escapeHtml(run > 1 ? code.trim() : code)}</code>`;
        i = end + run;
        continue;
      }
      out += escapeHtml(fence);
      i += run;
      continue;
    }
    if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        out += `<strong>${renderInline(text.slice(i + 2, end), opts)}</strong>`;
        i = end + 2;
        continue;
      }
    }
    if (ch === "[") {
      const m = LINK_RE.exec(text.slice(i));
      if (m) {
        const href = safeHref(m[2], opts.origin);
        const label = renderInline(m[1], opts);
        out += href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
        i += m[0].length;
        continue;
      }
    }
    if ((ch === "h" || ch === "H") && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
      const m = BARE_URL_RE.exec(text.slice(i));
      if (m) {
        let url = m[0];
        while (/[.,;:!?'")]$/.test(url)) url = url.slice(0, -1);
        const href = safeHref(url, opts.origin);
        if (href && url.length > "https://".length) {
          out += `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>`;
          i += url.length;
          continue;
        }
      }
    }
    out += escapeHtml(ch);
    i++;
  }
  return out;
}

/** 제목의 마크다운 표시를 걷어 낸 글자 */
export function plainText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`+/g, "")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .trim();
}

/** 제목 앵커 id. 한글·영문·숫자는 남기고 나머지는 하이픈으로 묶는다. */
export function headingId(text: string, used: Set<string>): string {
  const base =
    plainText(text)
      .normalize("NFC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section";
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

/* ---------- 블록 ---------- */

const FENCE_RE = /^(\s*)```/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const LIST_RE = /^(\s*)([-*]|\d{1,9}\.)\s+/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const QUOTE_RE = /^\s*>\s?/;

interface State {
  opts: RenderOptions;
  used: Set<string>;
  toc: TocItem[];
}

function leading(line: string): number {
  return line.length - line.trimStart().length;
}

function isOrdered(marker: string): boolean {
  return /^\d/.test(marker);
}

function parseFence(lines: string[], start: number): { html: string; next: number } {
  const indent = (FENCE_RE.exec(lines[start])?.[1] ?? "").length;
  const body: string[] = [];
  let i = start + 1;
  while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
    const line = lines[i];
    body.push(leading(line) >= indent ? line.slice(indent) : line.trimStart());
    i++;
  }
  return { html: `<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`, next: i + 1 };
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "`") {
      inCode = !inCode;
      cur += c;
    } else if (c === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function parseTable(lines: string[], start: number, st: State): { html: string; next: number } {
  const head = splitRow(lines[start]);
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim().startsWith("|")) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  const th = head.map((c) => `<th>${renderInline(c, st.opts)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${head.map((_, k) => `<td>${renderInline(r[k] ?? "", st.opts)}</td>`).join("")}</tr>`)
    .join("");
  return {
    html: `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`,
    next: i,
  };
}

interface ListItem {
  text: string[];
  children: string[];
}

function parseList(lines: string[], start: number, st: State): { html: string; next: number } {
  const first = LIST_RE.exec(lines[start]);
  if (!first) return { html: "", next: start + 1 };
  const indent = first[1].length;
  const ordered = isOrdered(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j >= lines.length) break;
      const m = LIST_RE.exec(lines[j]);
      if (m && m[1].length === indent && isOrdered(m[2]) === ordered) {
        i = j;
        continue;
      }
      if (leading(lines[j]) > indent && items.length > 0) {
        i = j;
        continue;
      }
      break;
    }
    const m = LIST_RE.exec(line);
    const lead = leading(line);
    if (m && lead === indent) {
      if (isOrdered(m[2]) !== ordered) break;
      items.push({ text: [line.slice(m[0].length)], children: [] });
      i++;
      continue;
    }
    if (lead <= indent || items.length === 0) break;
    const cur = items[items.length - 1];
    if (m) {
      const r = parseList(lines, i, st);
      cur.children.push(r.html);
      i = r.next;
    } else if (FENCE_RE.test(line)) {
      const r = parseFence(lines, i);
      cur.children.push(r.html);
      i = r.next;
    } else {
      cur.text.push(line.trim());
      i++;
    }
  }
  const tag = ordered ? "ol" : "ul";
  const open = ordered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
  const lis = items.map((it) => `<li>${renderInline(it.text.join(" "), st.opts)}${it.children.join("")}</li>`).join("");
  return { html: `${open}${lis}</${tag}>`, next: i };
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    LIST_RE.test(line) ||
    QUOTE_RE.test(line) ||
    (line.trim().startsWith("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]))
  );
}

function renderBlocks(lines: string[], st: State): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (FENCE_RE.test(line)) {
      const r = parseFence(lines, i);
      out.push(r.html);
      i = r.next;
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      const level = Math.min(h[1].length, 4);
      const id = headingId(h[2], st.used);
      if (level === 2) st.toc.push({ id, text: plainText(h[2]) });
      out.push(`<h${level} id="${escapeHtml(id)}">${renderInline(h[2], st.opts)}</h${level}>`);
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const r = parseTable(lines, i, st);
      out.push(r.html);
      i = r.next;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        inner.push(lines[i].replace(QUOTE_RE, ""));
        i++;
      }
      out.push(`<blockquote>${renderBlocks(inner, st)}</blockquote>`);
      continue;
    }
    if (LIST_RE.test(line)) {
      const r = parseList(lines, i, st);
      out.push(r.html);
      i = r.next;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && (para.length === 0 || !startsBlock(lines, i))) {
      para.push(lines[i].trim());
      i++;
    }
    out.push(`<p>${renderInline(para.join(" "), st.opts)}</p>`);
  }
  return out.join("\n");
}

/** 마크다운을 안전한 HTML 문자열과 차례(## 제목)로 바꾼다. */
export function renderMarkdown(markdown: string, opts: RenderOptions = {}): RenderedMarkdown {
  const st: State = { opts, used: new Set(), toc: [] };
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  return { html: renderBlocks(lines, st), toc: st.toc };
}

/** 렌더러가 만들 수 있는 태그(테스트와 검토용) */
export const RENDERED_TAGS = [
  "h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "pre", "code", "a", "strong",
  "table", "thead", "tbody", "tr", "th", "td", "blockquote", "div",
] as const;
