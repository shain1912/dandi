import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SITE_PATH_HEADER, requestHost, siteLabelFromHost } from "./app/site-serve/host";
import { docsMarkdownRewrite } from "./lib/docs/paths";

// 1) 허브 정적 호스팅(F-51): Host가 <label>.localhost[:port] 또는 <label>.<SITES_DOMAIN>이면
//    /site-serve/<label>/<경로>로 rewrite한다. 사이트는 허브와 다른 origin이라 허브 세션 쿠키가 가지 않는다.
//    사이트 요청에는 쿠키를 발급하지 않고, 원래 경로는 요청 헤더로 넘긴다.
// 2) F-01 익명 인증(허브 호스트만): 처음 방문한 사람에게 로그인 없이 세션 쿠키를 발급한다.
//    같은 요청의 서버 컴포넌트도 새 세션을 볼 수 있도록 요청 쿠키에도 넣는다.
const SESSION_COOKIE = "dd_sid";

// 허브 호스트에서 세션 쿠키를 발급하지 않는 경로.
// - API(CLI·게이트웨이), 원격 MCP(/mcp), OAuth(/oauth/*, 동의 화면은 이미 로그인한 교사의 쿠키를 그대로 쓴다)는 Bearer 토큰·기존 세션을 쓴다.
// - 공개 캐시되는 문서·파일(/.well-known/*, /llms.txt, /llms-full.txt, CLI 배포 파일, pdf.js·cmaps)에 Set-Cookie가 붙으면
//   공유 캐시(CDN)가 한 사람의 익명 세션 쿠키를 모두에게 나눠 줄 수 있다(QA set-cookie-on-public-cacheable).
// 디렉터리형 경로는 정확히 그 경로이거나 그 아래 경로만, 파일형 경로는 정확히 그 이름만 건너뛴다.
const HUB_SKIP =
  /^\/(?:(?:api|_next\/static|_next\/image|examples|downloads|docs\/md|mcp|oauth|\.well-known|pdfjs|cmaps)(?:\/|$)|(?:favicon\.ico|llms\.txt|llms-full\.txt|dandi-[^/]+\.tgz|dandi-latest\.json)$)/;

export function proxy(request: NextRequest) {
  const label = siteLabelFromHost(requestHost(request.headers));
  if (label !== null) {
    const original = request.nextUrl.pathname;
    const url = request.nextUrl.clone();
    url.pathname = `/site-serve/${encodeURIComponent(label)}${original === "/" ? "" : original}`;
    const headers = new Headers(request.headers);
    headers.set(SITE_PATH_HEADER, original);
    headers.delete("cookie"); // 사이트 라우트는 쿠키를 쓰지 않는다.
    return NextResponse.rewrite(url, { request: { headers } });
  }

  const path = request.nextUrl.pathname;
  // 사이트 서빙 내부 경로는 사이트 호스트에서만 쓴다. 허브 origin에서 업로드된 HTML이 실행되지 않게 막는다.
  if (path === "/site-serve" || path.startsWith("/site-serve/")) {
    return new NextResponse("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
    });
  }
  // AI(LLM)가 읽는 문서 원문 /docs/<문서>.md → 라우트 핸들러 /docs/md/<문서>. 공개 문서라 세션 쿠키를 발급하지 않는다.
  const docsMd = docsMarkdownRewrite(path);
  if (docsMd) {
    const url = request.nextUrl.clone();
    url.pathname = docsMd;
    return NextResponse.rewrite(url);
  }
  if (HUB_SKIP.test(path) || request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  const sid = `s_${crypto.randomUUID().replace(/-/g, "")}`; // lib/tokens.ts generateSessionId와 같은 형식
  request.cookies.set(SESSION_COOKIE, sid);
  const response = NextResponse.next({ request: { headers: request.headers } });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: sid,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}

export const config = {
  // 사이트 호스트는 모든 경로(/_next/static, /api 포함: 정적 내보내기 사이트에도 이런 폴더가 있다)를 rewrite해야 하므로
  // 모든 요청에서 실행하고, 허브 호스트의 제외 경로는 위 HUB_SKIP으로 건너뛴다. /site-serve도 여기서 막는다.
  matcher: ["/:path*"],
};
