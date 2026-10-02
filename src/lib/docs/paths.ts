// src/proxy.ts가 쓰는 문서 주소 규칙. 프록시에 가볍게 들어가도록 아무것도 import하지 않는다.

/** AI(LLM)용 원문 주소: /docs/<slug>.md (문서 목록은 /docs/index.md) */
export const DOCS_MD_PATH_RE = /^\/docs\/([a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?)\.md$/;

/** 원문을 내려 주는 라우트 핸들러(src/app/docs/md/[file]/route.ts)의 경로 */
export const DOCS_MD_ROUTE = "/docs/md";

/** /docs/<slug>.md 이면 라우트 핸들러 경로(/docs/md/<slug>)를, 아니면 null을 돌려준다. */
export function docsMarkdownRewrite(pathname: string): string | null {
  const m = DOCS_MD_PATH_RE.exec(pathname);
  return m ? `${DOCS_MD_ROUTE}/${m[1]}` : null;
}
