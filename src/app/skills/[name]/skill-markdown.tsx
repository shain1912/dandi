import type { ReactNode } from "react";

// SKILL.md를 최소한의 마크다운으로 보여 준다(F-37). 게시자가 쓴 내용이므로 HTML로 해석하지 않고
// 제목·목록·코드·표·인용·굵게·인라인 코드·http(s) 링크만 React 요소로 만든다(dangerouslySetInnerHTML 사용 안 함).

const MAX_CHARS = 100_000;

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[] | null; rows: string[][] }
  | { kind: "hr" }
  | { kind: "para"; text: string };

const LIST_ITEM = /^\s*(?:[-*+]|(\d{1,3})[.)])\s+(.*)$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function parseBlocks(md: string): Block[] {
  const lines = md.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].replace(/\s+#+\s*$/, "") });
      i++;
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const raw: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) raw.push(lines[i++]);
      const isSep = (l: string) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
      if (raw.length >= 2 && isSep(raw[1])) {
        blocks.push({ kind: "table", header: splitRow(raw[0]), rows: raw.slice(2).map(splitRow) });
      } else {
        blocks.push({ kind: "table", header: null, rows: raw.filter((l) => !isSep(l)).map(splitRow) });
      }
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join(" ") });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = item[1] !== undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m) {
          items.push(m[2]);
          i++;
        } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length > 0) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i++;
        } else break;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s|^\s*(```|~~~)|^\s*\||^\s*>/.test(lines[i]) &&
      !LIST_ITEM.test(lines[i])
    ) {
      para.push(lines[i++].trim());
    }
    blocks.push({ kind: "para", text: para.join(" ") });
  }
  return blocks;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let key = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<code key={key++}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={key++}>{m[2]}</strong>);
    else if (/^https?:\/\//i.test(m[4])) {
      out.push(
        <a key={key++} href={m[4]} rel="nofollow noopener noreferrer" target="_blank">
          {m[3]}
        </a>,
      );
    } else out.push(`${m[3]} (${m[4]})`);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.kind) {
    case "heading": {
      // 화면의 h1·h2 아래에 오도록 두 단계 내려 쓴다.
      const level = Math.min(6, b.level + 2);
      const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
      return <Tag key={key}>{inline(b.text)}</Tag>;
    }
    case "code":
      return <pre key={key}>{b.text}</pre>;
    case "hr":
      return <hr key={key} />;
    case "quote":
      return <blockquote key={key}>{inline(b.text)}</blockquote>;
    case "list": {
      const items = b.items.map((it, i) => <li key={i}>{inline(it)}</li>);
      return b.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case "table":
      return (
        <div key={key} className="table-wrap">
          <table>
            {b.header && (
              <thead>
                <tr>
                  {b.header.map((c, i) => (
                    <th key={i}>{inline(c)}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "para":
      return <p key={key}>{inline(b.text)}</p>;
  }
}

/** SKILL.md 전체(앞부분 포함)를 받는다. 앞부분은 원문 그대로 보여 준다. */
export function SkillMarkdown({ text }: { text: string }) {
  const src = text.replace(/\r\n?/g, "\n");
  const truncated = src.length > MAX_CHARS;
  const body = truncated ? src.slice(0, MAX_CHARS) : src;
  let frontmatter: string | null = null;
  let rest = body;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---", 3);
    if (end > 0) {
      frontmatter = body.slice(0, end + 4);
      rest = body.slice(end + 4);
    }
  }
  return (
    <div>
      {frontmatter && <pre>{frontmatter}</pre>}
      {parseBlocks(rest).map(renderBlock)}
      {truncated && <p className="muted">내용이 길어 앞부분만 보여 줍니다. 전체는 설치하거나 zip을 내려받아 확인하십시오.</p>}
    </div>
  );
}
