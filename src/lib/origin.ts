import "server-only";
import { headers } from "next/headers";

// 허브 주소와 사이트 주소 계산(F-51, F-55, F-57).
// 사이트는 허브와 다른 origin에서 서빙한다. 로컬은 http://<slug>.localhost:<port>,
// 운영은 SITES_DOMAIN 환경변수(예: dandi-sites.kr)를 쓴다.
//
// 운영에서는 HUB_ORIGIN을 반드시 설정한다. 설정하지 않으면 요청의 Host로 허브 주소를 만드는데,
// X-Forwarded-Host/Proto/For는 믿을 수 있는 리버스 프록시 뒤(TRUST_PROXY=1)에서만 쓴다.
// 그렇지 않으면 누구나 헤더를 조작해 OAuth 메타데이터·설치 명령에 다른 주소를 넣을 수 있다.

export const TRUST_PROXY = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";

type HeaderGetter = { get(name: string): string | null };

/** 헤더에서 허브 origin을 구한다. HUB_ORIGIN이 있으면 그것을 쓴다. */
export function originFromHeaders(h: HeaderGetter): string {
  if (process.env.HUB_ORIGIN) return process.env.HUB_ORIGIN.replace(/\/+$/, "");
  const host = (TRUST_PROXY ? h.get("x-forwarded-host") : null) ?? h.get("host");
  const proto = TRUST_PROXY ? h.get("x-forwarded-proto") : null;
  return originFromHost(host?.split(",")[0].trim() ?? null, proto?.split(",")[0].trim() ?? null);
}

/** 요청 헤더 기준 허브 origin (예: "http://localhost:3000"). 서버 컴포넌트·서버 액션용. */
export async function hubOrigin(): Promise<string> {
  return originFromHeaders(await headers());
}

/** Request 객체에서 허브 origin을 구한다(라우트 핸들러용). */
export function hubOriginFromRequest(req: Request): string {
  return originFromHeaders(req.headers);
}

/**
 * 프록시 정보가 없을 때 체계(http/https)를 추정한다. 공개 도메인만 https로 보고,
 * localhost·IP 주소·점 없는 PC 이름·사설 접미사(.local .lan .internal .intranet .home.arpa)는 http로 본다.
 * (연수장 LAN에서 http://192.168.0.5:3000 으로 연 허브가 https 주소를 안내하지 않게)
 */
function looksLocalHost(hostWithPort: string): boolean {
  const host = hostWithPort.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return true; // IPv4·IPv6 리터럴
  if (!host.includes(".")) return true;
  return /\.(local|lan|internal|intranet|home\.arpa|corp)$/.test(host);
}

function originFromHost(host: string | null, proto: string | null): string {
  const h = host ?? "localhost:3000";
  return `${proto ?? (looksLocalHost(h) ? "http" : "https")}://${h}`;
}

/**
 * 요청한 클라이언트 IP(속도 제한·승인 화면 표시·중복 제거용). TRUST_PROXY일 때만 X-Forwarded-For를 보고,
 * 프록시가 덧붙인 가장 오른쪽 값을 쓴다(맨 앞 값은 클라이언트가 마음대로 넣을 수 있다).
 * 프록시가 없으면 Next 라우트 핸들러에서는 소켓 주소를 알 수 없으므로 "local"로 묶는다.
 */
export function clientIp(h: HeaderGetter): string {
  if (!TRUST_PROXY) return "local";
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return h.get("x-real-ip")?.trim() || "unknown";
}

/**
 * 사이트 주소. 허브 origin에서 호스트 앞에 사이트 이름을 붙인다.
 * 예) hub "http://localhost:3000", label "quiz" → "http://quiz.localhost:3000"
 * SITES_DOMAIN이 있으면 "https://quiz.<SITES_DOMAIN>".
 */
export function siteOrigin(hub: string, label: string): string {
  if (process.env.SITES_DOMAIN) return `https://${label}.${process.env.SITES_DOMAIN}`;
  const u = new URL(hub);
  return `${u.protocol}//${label}.${u.host}`;
}

/** 로그인 뒤 돌아갈 경로로 쓸 수 있는지(같은 사이트 안의 상대 경로만 허용). */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return null;
  return next;
}
