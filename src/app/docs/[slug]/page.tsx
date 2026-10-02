import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { adjacentDocs, DOC_PAGES, docBody, docMarkdownUrl, getDocPage } from "@/lib/docs";
import { renderMarkdown } from "@/lib/docs/markdown";
import { hubOrigin } from "@/lib/origin";
import { cliPrefix, normalizeHubOrigin, readCliVersion } from "@/lib/runbook";

// 사람이 읽는 문서 한 페이지. 본문은 src/lib/docs의 마크다운을 서버에서 HTML로 그린다.
// 렌더러(src/lib/docs/markdown.ts)가 모든 글자를 먼저 이스케이프하므로 원문 HTML은 들어가지 않는다.

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = getDocPage(slug);
  return page ? { title: `${page.title} · Dandi 문서`, description: page.summary } : { title: "문서 · Dandi" };
}

export default async function DocView({ params }: Props) {
  const { slug } = await params;
  const page = getDocPage(slug);
  if (!page) notFound();

  const hub = normalizeHubOrigin(await hubOrigin());
  const cli = cliPrefix(hub, readCliVersion());
  const { html, toc } = renderMarkdown(docBody(page, hub, cli), { origin: hub });
  const { prev, next } = adjacentDocs(page.slug);

  return (
    <>
      <p className="muted">
        <Link href="/docs">문서</Link> / {page.title}
      </p>
      <nav className="filter" aria-label="문서 목록">
        {DOC_PAGES.map((p) => (
          <Link key={p.slug} href={`/docs/${p.slug}`} aria-current={p.slug === page.slug ? "page" : undefined}>
            {p.title}
          </Link>
        ))}
      </nav>

      <h1>{page.title}</h1>
      <p className="muted">{page.summary}</p>
      {toc.length > 0 && (
        <details open>
          <summary>이 문서의 차례</summary>
          <ol>
            {toc.map((t) => (
              <li key={t.id}>
                <a href={`#${t.id}`}>{t.text}</a>
              </li>
            ))}
          </ol>
        </details>
      )}

      <div dangerouslySetInnerHTML={{ __html: html }} />

      <nav className="filter" aria-label="이전·다음 문서" style={{ marginTop: 24 }}>
        {prev && <Link href={`/docs/${prev.slug}`}>이전: {prev.title}</Link>}
        {next && <Link href={`/docs/${next.slug}`}>다음: {next.title}</Link>}
      </nav>
      <p className="muted">
        AI(LLM)용 원문: <a href={`/docs/${page.slug}.md`}>{docMarkdownUrl(hub, page.slug)}</a>
      </p>
    </>
  );
}
