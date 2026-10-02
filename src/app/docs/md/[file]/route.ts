import { docMarkdown, docsIndexMarkdown, getDocPage } from "@/lib/docs";
import { hubOriginFromRequest } from "@/lib/origin";
import { cliPrefix, markdownResponse, normalizeHubOrigin, readCliVersion } from "@/lib/runbook";

// AI(LLM)가 읽는 문서 원문. src/proxy.ts가 /docs/<slug>.md 를 이 경로(/docs/md/<slug>)로 rewrite한다.
// 사람용 화면(/docs/<slug>)과 같은 원본(src/lib/docs)에서 만든 마크다운을 리다이렉트 없이 200으로 준다.
export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await params;
  const slug = file.replace(/\.md$/, "");
  const hub = normalizeHubOrigin(hubOriginFromRequest(req));
  if (slug === "index") return markdownResponse(docsIndexMarkdown(hub));
  const page = getDocPage(slug);
  if (!page) {
    return new Response(`Not Found. 문서 목록: ${hub}/docs/index.md\n`, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
    });
  }
  return markdownResponse(docMarkdown(page, hub, cliPrefix(hub, readCliVersion())));
}
