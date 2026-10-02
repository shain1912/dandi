import type { NextConfig } from "next";

// 클릭재킹 방지.
// - 허브 화면은 허브 자신만 iframe으로 넣을 수 있다(미니앱 실행 화면이 /examples/*를 넣기 때문).
// - 승인 화면(로그인, CLI 기기 승인, MCP 연결 동의)은 어디에도 넣을 수 없다.
// - 교사 사이트 호스트(*.localhost, *.SITES_DOMAIN)는 site-serve가 자체 정책(frame-ancestors 허브)을 붙이므로 제외한다.
const SAME_ORIGIN_ONLY = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
];
const NO_FRAME = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SITE_HOSTS = [
  { type: "host" as const, value: "(?<site>.+)\\.localhost" },
  ...(process.env.SITES_DOMAIN
    ? [{ type: "host" as const, value: `(?<site2>.+)\\.${escapeRe(process.env.SITES_DOMAIN)}` }]
    : []),
];

const nextConfig: NextConfig = {
  experimental: {
    // 자료실 업로드(F-08) 최대 50MB + multipart 오버헤드
    serverActions: { bodySizeLimit: "52mb" },
    proxyClientMaxBodySize: "52mb",
  },
  async headers() {
    // 같은 헤더 키가 여러 규칙에 걸리면 뒤의 규칙이 이긴다. 승인 화면 규칙을 마지막에 둔다.
    return [
      { source: "/:path*", missing: SITE_HOSTS, headers: SAME_ORIGIN_ONLY },
      ...["/login", "/device", "/device/:path*", "/oauth/:path*"].map((source) => ({
        source,
        missing: SITE_HOSTS,
        headers: NO_FRAME,
      })),
    ];
  },
};

export default nextConfig;
