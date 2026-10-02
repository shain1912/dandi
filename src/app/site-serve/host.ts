// 사이트 호스트 판별(F-51). proxy.ts와 사이트 서빙 라우트가 함께 쓰므로 Node 전용 API나 DB를 쓰지 않는다.
// 사이트는 허브와 다른 origin에서 서빙한다: 로컬 http://<label>.localhost:<port>, 운영 https://<label>.<SITES_DOMAIN>.
// label은 공개 주소면 slug, 미리보기면 "<slug>--<token>"이다.

/** proxy가 rewrite할 때 원래 요청 경로(퍼센트 인코딩 그대로)를 담아 보내는 요청 헤더 */
export const SITE_PATH_HEADER = "x-dandi-site-path";

/**
 * 믿을 수 있는 역방향 프록시 뒤인가(TRUST_PROXY=1). origin.ts의 TRUST_PROXY와 같은 규칙이다.
 * origin.ts는 server-only·next/headers를 가져오므로 proxy.ts가 쓰는 이 파일에서는 환경변수를 직접 읽는다.
 */
function trustProxy(): boolean {
  const v = process.env.TRUST_PROXY;
  return v === "1" || v === "true";
}

/**
 * 요청의 호스트. X-Forwarded-Host는 TRUST_PROXY일 때만 따른다(origin.ts originFromHeaders와 같은 규칙).
 * 그렇지 않으면 누구나 헤더를 넣어 허브 호스트 요청을 사이트 요청처럼(또는 그 반대로) 보이게 할 수 있다.
 */
export function requestHost(headers: Headers): string | null {
  const raw = (trustProxy() ? headers.get("x-forwarded-host") : null) ?? headers.get("host");
  if (!raw) return null;
  const first = raw.split(",")[0].trim().toLowerCase();
  return first || null;
}

/** 요청 프로토콜(http/https). X-Forwarded-Proto는 TRUST_PROXY일 때만 따르고, 아니면 fallback을 쓴다. */
export function requestProto(headers: Headers, fallback: string | null = null): string | null {
  const forwarded = trustProxy() ? headers.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase() : null;
  return forwarded || fallback;
}

function hostnameOf(host: string): string | null {
  // IPv6 리터럴([::1]:3000)은 사이트 호스트가 될 수 없다.
  const m = /^([^:[\]]+)(?::\d{1,5})?$/.exec(host);
  return m ? m[1].replace(/\.$/, "") : null;
}

function configuredHubHostname(): string | null {
  const hub = process.env.HUB_ORIGIN;
  if (!hub) return null;
  try {
    return new URL(hub).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function sitesDomain(): string | null {
  const d = process.env.SITES_DOMAIN?.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  return d || null;
}

/**
 * 호스트가 사이트 호스트이면 label을, 허브 호스트이면 null을 돌려준다.
 * label 형식 검사는 하지 않는다(형식이 틀린 사이트 호스트도 허브 화면 대신 사이트 404를 받게 하려고).
 */
export function siteLabelFromHost(host: string | null): string | null {
  if (!host) return null;
  const name = hostnameOf(host.toLowerCase());
  if (!name) return null;
  if (name === configuredHubHostname()) return null;
  const domains = ["localhost"];
  const extra = sitesDomain();
  if (extra) domains.push(extra);
  for (const d of domains) {
    if (name.length > d.length + 1 && name.endsWith(`.${d}`)) return name.slice(0, -(d.length + 1));
  }
  return null;
}

/**
 * 사이트를 iframe으로 넣을 수 있는 허브 origin 목록(CSP frame-ancestors).
 * HUB_ORIGIN이 있으면 그것만, 없으면 로컬 규칙(<label>.localhost:<port> → localhost:<port>, 127.0.0.1:<port>)으로 구한다.
 */
export function hubOriginsForSiteHost(host: string | null, proto: string | null): string[] {
  const hub = process.env.HUB_ORIGIN?.replace(/\/+$/, "");
  if (hub) return [hub];
  if (!host) return [];
  const m = /^[^:]+\.localhost(:\d{1,5})?$/.exec(host.toLowerCase());
  if (!m) return [];
  const scheme = proto === "https" ? "https" : "http";
  const port = m[1] ?? "";
  return [`${scheme}://localhost${port}`, `${scheme}://127.0.0.1${port}`];
}
