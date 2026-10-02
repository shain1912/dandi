import { readBlob } from "@/lib/blobs";
import { resolveSiteRequest } from "@/lib/sites";
import { SITE_PATH_HEADER, hubOriginsForSiteHost, requestHost, requestProto, siteLabelFromHost } from "../../host";

// 허브 정적 호스팅 서빙(F-51). proxy.ts가 <label>.localhost(또는 <label>.<SITES_DOMAIN>) 요청을
// /site-serve/<label>/<경로>로 rewrite하면 여기서 배포 파일을 돌려준다.
// 허브 호스트로 이 경로에 직접 들어온 요청은 404로 막는다. 업로드된 HTML이 허브 origin에서 실행되면
// 교사 세션 쿠키로 허브 API를 호출할 수 있기 때문이다. 사이트 응답에는 Set-Cookie를 넣지 않는다.

type Ctx = { params: Promise<{ label: string; path?: string[] }> };

function plainNotFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

function urlProto(req: Request): string | null {
  try {
    return new URL(req.url).protocol.replace(/:$/, "");
  } catch {
    return null;
  }
}

function baseHeaders(req: Request, host: string, noindex: boolean): Headers {
  // X-Forwarded-Proto는 TRUST_PROXY일 때만 믿는다(host.ts requestProto).
  const ancestors = hubOriginsForSiteHost(host, requestProto(req.headers, urlProto(req)));
  const h = new Headers();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Content-Security-Policy", `frame-ancestors ${ancestors.length > 0 ? ancestors.join(" ") : "'self'"}`);
  h.set("Cache-Control", "no-store");
  if (noindex) h.set("X-Robots-Tag", "noindex");
  return h;
}

const PAGE_STYLE =
  "body{margin:0;font-family:system-ui,-apple-system,'Segoe UI','Malgun Gothic',sans-serif;line-height:1.6;color:#1a1a1a;background:#fff}" +
  "main{max-width:560px;margin:15vh auto 0;padding:0 16px}h1{font-size:1.3rem}p{color:#555}" +
  "@media (prefers-color-scheme: dark){body{color:#e8e8e8;background:#121212}p{color:#aaa}}";

/** 서버가 만드는 안내 페이지(403·404). 사용자 입력은 넣지 않는다. */
function infoPage(req: Request, host: string, status: 403 | 404, title: string, body: string, withBody: boolean): Response {
  const html =
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${title}</title><style>${PAGE_STYLE}</style></head>` +
    `<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
  const bytes = new TextEncoder().encode(html);
  const headers = baseHeaders(req, host, true);
  // 안내 페이지는 스크립트가 없으므로 더 좁은 정책을 쓴다.
  headers.set("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; ${headers.get("Content-Security-Policy")}`);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Length", String(bytes.byteLength));
  return new Response(withBody ? bytes : null, { status, headers });
}

/** 하위 폴더 index.html을 끝 슬래시 없이 열었을 때 상대 경로가 맞도록 <base href>를 넣는다. */
function injectBase(bytes: Uint8Array, href: string): Uint8Array {
  const html = new TextDecoder().decode(bytes);
  if (/<base[\s>]/i.test(html)) return bytes;
  const tag = `<base href="${href}">`;
  const anchor = /<head(?:\s[^>]*)?>/i.exec(html) ?? /<html(?:\s[^>]*)?>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);
  const out = anchor
    ? html.slice(0, anchor.index + anchor[0].length) + tag + html.slice(anchor.index + anchor[0].length)
    : tag + html;
  return new TextEncoder().encode(out);
}

/** Range: bytes=a-b 한 구간만 지원한다(동영상 탐색용). 해석할 수 없는 형식은 무시하고 전체를 보낸다. */
function parseRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  if (m[1] === "" && m[2] === "") return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || start > end || start >= size) return "invalid";
  return { start, end };
}

async function handle(req: Request, ctx: Ctx, withBody: boolean): Promise<Response> {
  const { label, path } = await ctx.params;
  const host = requestHost(req.headers);
  const hostLabel = siteLabelFromHost(host);
  // 허브 호스트(또는 다른 사이트 호스트)로 직접 들어온 요청은 막는다.
  if (!host || !hostLabel || hostLabel !== decodeURIComponentSafe(label)) return plainNotFound();

  const pathname = req.headers.get(SITE_PATH_HEADER) ?? `/${(path ?? []).map(encodeURIComponent).join("/")}`;
  const resolved = await resolveSiteRequest(hostLabel, pathname);

  if (resolved.kind === "pending") {
    return infoPage(
      req,
      host,
      403,
      "학교 내부 승인 대기 중",
      "이 사이트는 학교 내부 승인(운영위원회 등)을 기다리고 있습니다. 승인이 끝나면 이 주소로 열립니다. 사이트를 만든 선생님은 허브의 내 사이트 화면에서 미리보기 주소로 확인할 수 있습니다.",
      withBody,
    );
  }
  if (resolved.kind === "not_found") {
    const [title, body] =
      resolved.reason === "not_published"
        ? ["아직 공개되지 않은 사이트", "사이트를 만든 선생님이 허브에 등록(셀프점검 포함)하면 이 주소로 열립니다."]
        : resolved.reason === "no_site"
          ? ["사이트를 찾을 수 없습니다", "주소를 다시 확인하십시오. 미리보기 주소는 새 버전을 올리면 바뀔 수 있습니다."]
          : ["페이지를 찾을 수 없습니다", "주소를 다시 확인하십시오."];
    return infoPage(req, host, 404, title, body, withBody);
  }

  const stored = await readBlob(resolved.file.sha256);
  if (!stored) return infoPage(req, host, 404, "파일을 읽을 수 없습니다", "잠시 뒤 다시 시도하십시오.", withBody);
  const isHtml = resolved.file.contentType.startsWith("text/html");
  const bytes = resolved.baseHref && isHtml ? injectBase(stored, resolved.baseHref) : stored;

  const headers = baseHeaders(req, host, resolved.preview);
  headers.set("Content-Type", resolved.file.contentType);
  headers.set("Accept-Ranges", "bytes");

  let status: number = resolved.status;
  let body = bytes;
  if (resolved.status === 200) {
    const range = parseRange(req.headers.get("range"), bytes.byteLength);
    if (range === "invalid") {
      headers.set("Content-Range", `bytes */${bytes.byteLength}`);
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      status = 206;
      body = bytes.subarray(range.start, range.end + 1);
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${bytes.byteLength}`);
    }
  }
  headers.set("Content-Length", String(body.byteLength));
  return new Response(withBody ? (body as Uint8Array<ArrayBuffer>) : null, { status, headers });
}

function decodeURIComponentSafe(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  return handle(req, ctx, true);
}

export async function HEAD(req: Request, ctx: Ctx): Promise<Response> {
  return handle(req, ctx, false);
}
