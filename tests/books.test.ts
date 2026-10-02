import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { User } from "../src/lib/types.ts";

// 전자책 서가(F-43 ~ F-45) lib 테스트. src/lib/books.ts는 서버 전용(server-only, next/headers)이고
// 확장자 없는 상대 경로·"@/" 경로를 쓰므로, 이 파일 안에서만 쓰는 로더로 해석한다.
const ROOT = new URL("../", import.meta.url).href;
const HOOKS = `
const ROOT = ${JSON.stringify(ROOT)};
const stub = (src) => ({ url: "data:text/javascript," + encodeURIComponent(src), shortCircuit: true });
export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return stub("export default null");
  if (specifier === "next/headers") return stub("export async function headers(){return new Headers()} export async function cookies(){return {get(){return undefined},set(){}}}");
  if (specifier.startsWith("@/")) specifier = new URL("src/" + specifier.slice(2), ROOT).href;
  try {
    return await next(specifier, context);
  } catch (err) {
    if ((specifier.startsWith(".") || specifier.startsWith("file:")) && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
      for (const ext of [".ts", ".tsx"]) {
        try { return await next(specifier + ext, context); } catch {}
      }
    }
    throw err;
  }
}`;
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`);

// db.ts가 가져올 때 저장 위치를 정하므로 먼저 임시 폴더를 지정한다(프로젝트 data/는 건드리지 않는다).
const dataDir = mkdtempSync(path.join(os.tmpdir(), "dandi-books-test-"));
process.env.DANDI_DATA_DIR = dataDir;
delete process.env.SITES_DOMAIN;
delete process.env.HUB_ORIGIN;

const books = await import("../src/lib/books.ts");
const { readDb } = await import("../src/lib/db.ts");

after(() => rmSync(dataDir, { recursive: true, force: true }));

const T = "2026-09-28T00:00:00.000Z";
const teacher: User = { id: "seed_teacher", role: "teacher", name: "데모 교사", schoolLevel: "middle", createdAt: T };
const otherTeacher: User = { id: "u_other", role: "teacher", name: "다른 교사", schoolLevel: "high", createdAt: T };
const admin: User = { id: "seed_admin", role: "admin", name: "관리자", schoolLevel: null, createdAt: T };
const anon: User = { id: "u_anon", role: "anon", name: null, schoolLevel: null, createdAt: T };

const meta = (over: Partial<Parameters<typeof books.validateBookMeta>[0]> = {}) => ({
  title: "테스트 책",
  summary: "",
  authorName: "",
  schoolLevel: "all",
  license: "CC BY 4.0",
  visibility: "public",
  containsThirdPartyWorks: false,
  ...over,
});

/* ---------- 목차 파싱 ---------- */

const BASE = "https://example.github.io/book/";

const SEARCH_INDEX = {
  config: { lang: ["en"] },
  docs: [
    { location: "", title: "나만의 지도 웹", text: "" },
    { location: "#_2", title: "이 책의 구성", text: "" },
    { location: "ch00/", title: "0장 이 책에서 만드는 것", text: "" },
    { location: "ch00/#01", title: "0.1 완성된 모습", text: "" },
    { location: "ch00/#_1", title: "마커를 누르면 말풍선이 뜹니다", text: "" },
    { location: "ch00/#02", title: "0.2 <code>npm</code> 설치", text: "" },
    { location: "ch01/", title: "1장 설치", text: "" },
    { location: "ch01/#_1", title: "번호 없는 절", text: "" },
    { location: "ch01/#111", title: "1.1.1 세부 절", text: "" },
    { location: "ch28/", title: "부록 B 트러블슈팅 &amp; 치트시트", text: "" },
    { location: "ch28/#b1", title: "B.1 증상과 해결", text: "" },
    { location: "https://evil.example/phish/", title: "밖으로 나가는 링크", text: "" },
    { location: "javascript:alert(1)", title: "스크립트", text: "" },
    { location: "../other-book/", title: "다른 책", text: "" },
    { location: 42, title: "잘못된 항목" },
  ],
};

test("parseSearchIndex: docs 배열만 받고 형식이 다른 항목은 버린다", () => {
  assert.equal(books.parseSearchIndex(null), null);
  assert.equal(books.parseSearchIndex({ nodocs: [] }), null);
  const docs = books.parseSearchIndex(SEARCH_INDEX);
  assert.ok(docs);
  assert.equal(docs.length, SEARCH_INDEX.docs.length - 1);
});

test("tocFromSearchIndex: 페이지 depth 0, 번호 절 depth 1~2, 번호 없는 절은 앞 번호 절 아래", () => {
  const toc = books.tocFromSearchIndex(books.parseSearchIndex(SEARCH_INDEX)!, BASE);
  const byTitle = Object.fromEntries(toc.map((t) => [t.title, t]));
  assert.deepEqual(byTitle["나만의 지도 웹"], { title: "나만의 지도 웹", href: BASE, depth: 0 });
  assert.equal(byTitle["이 책의 구성"].depth, 1);
  assert.equal(byTitle["이 책의 구성"].href, `${BASE}#_2`);
  assert.equal(byTitle["0장 이 책에서 만드는 것"].href, `${BASE}ch00/`);
  assert.equal(byTitle["0.1 완성된 모습"].depth, 1);
  assert.equal(byTitle["마커를 누르면 말풍선이 뜹니다"].depth, 2);
  assert.equal(byTitle["0.2 npm 설치"].depth, 1, "태그를 벗긴다");
  assert.equal(byTitle["번호 없는 절"].depth, 1, "앞에 번호 절이 없으면 depth 1");
  assert.equal(byTitle["1.1.1 세부 절"].depth, 2);
  assert.ok(byTitle["부록 B 트러블슈팅 & 치트시트"], "HTML 엔티티를 푼다");
  assert.equal(byTitle["B.1 증상과 해결"].depth, 1, "영문자 번호(B.1)도 번호 절");
  // 책 밖(다른 origin, 상위 경로, javascript:)은 빠진다
  for (const t of toc) assert.ok(t.href.startsWith(BASE), t.href);
  assert.equal(toc.length, 11);
});

test("parseSitemap·tocFromSitemap: loc·lastmod, 엔티티·CDATA, 책 밖 주소 제외, 주소로 제목", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${BASE}</loc><lastmod>2026-09-08</lastmod></url>
  <url><loc>${BASE}ch01/</loc><lastmod>2026-09-10T12:00:00Z</lastmod></url>
  <url><loc><![CDATA[${BASE}part-2/getting_started.html]]></loc></url>
  <url><loc>${BASE}q?a=1&amp;b=2</loc></url>
  <url><loc>https://other.example/x/</loc></url>
</urlset>`;
  const entries = books.parseSitemap(xml);
  assert.equal(entries.length, 5);
  assert.equal(entries[1].lastmod, "2026-09-10");
  assert.equal(entries[2].loc, `${BASE}part-2/getting_started.html`);
  assert.equal(entries[3].loc, `${BASE}q?a=1&b=2`);
  const toc = books.tocFromSitemap(entries, BASE, "책 제목");
  assert.deepEqual(
    toc.map((t) => t.title),
    ["책 제목", "ch01", "getting started", "q"],
  );
  assert.ok(toc.every((t) => t.depth === 0));
});

test("normalizeBaseUrl: 끝 슬래시, 파일 이름·쿼리·해시 제거", () => {
  assert.equal(books.normalizeBaseUrl("https://a.example/book"), "https://a.example/book/");
  assert.equal(books.normalizeBaseUrl("https://a.example/book/"), "https://a.example/book/");
  assert.equal(books.normalizeBaseUrl("https://a.example/book/index.html?x=1#top"), "https://a.example/book/");
  assert.equal(books.normalizeBaseUrl("https://a.example"), "https://a.example/");
});

test("capToc: 500항목을 넘으면 깊은 절부터 뺀다", () => {
  const items = [];
  for (let p = 0; p < 100; p++) {
    items.push({ title: `${p}장`, href: `${BASE}ch${p}/`, depth: 0 });
    for (let s = 0; s < 3; s++) items.push({ title: `${p}.${s}`, href: `${BASE}ch${p}/#${s}`, depth: 1 });
    for (let s = 0; s < 3; s++) items.push({ title: `세부 ${s}`, href: `${BASE}ch${p}/#d${s}`, depth: 2 });
  }
  assert.equal(items.length, 700);
  const capped = books.capToc(items);
  assert.equal(capped.length, 400);
  assert.ok(capped.every((i) => i.depth <= 1));
  const many = Array.from({ length: 800 }, (_, i) => ({ title: `${i}`, href: `${BASE}${i}/`, depth: 0 }));
  assert.equal(books.capToc(many).length, 500);
});

test("finalizeToc: 중복 제거, 제목 개인정보 마스킹, 주소에 개인정보가 있으면 제외", () => {
  const toc = books.finalizeToc(
    [
      { title: "연락처 010-1234-5678 안내", href: `${BASE}a/`, depth: 0 },
      { title: "중복", href: `${BASE}a/`, depth: 0 },
      { title: "메일 주소 페이지", href: `${BASE}kim@school.kr/`, depth: 0 },
      { title: "깊이 보정", href: `${BASE}b/`, depth: 7 },
    ],
    BASE,
  );
  assert.equal(toc.length, 2);
  assert.equal(toc[0].title, "연락처 *** 안내");
  assert.equal(toc[1].depth, 2);
});

test("parseHtmlMeta: title, description(속성 순서 무관), og:description 대체", () => {
  const m = books.parseHtmlMeta(
    `<html><head><title>바이브코딩 &amp; 지도</title><meta content="설명입니다" name="description"></head></html>`,
  );
  assert.deepEqual(m, { title: "바이브코딩 & 지도", description: "설명입니다" });
  const og = books.parseHtmlMeta(`<meta property='og:description' content='오픈그래프 설명'>`);
  assert.equal(og.description, "오픈그래프 설명");
});

/* ---------- SSRF 방어 ---------- */

test("isPrivateAddress: 사설·루프백·링크 로컬·예약 대역과 IPv4 매핑 IPv6", () => {
  for (const ip of [
    "10.0.0.1", "127.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.0.10", "169.254.169.254", "100.64.1.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "::ffff:a9fe:a9fe", "64:ff9b::10.0.0.1", "2001:db8::1", "[::1]", "not-an-ip",
  ]) {
    assert.equal(books.isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["185.199.108.153", "8.8.8.8", "172.32.0.1", "2606:50c0:8000::153", "::ffff:8.8.8.8"]) {
    assert.equal(books.isPrivateAddress(ip), false, ip);
  }
});

const HUB = "http://localhost:3000";

test("checkBookUrl: https 공개 주소 또는 허브 사이트 주소만", () => {
  const ok = (u: string) => {
    const r = books.checkBookUrl(u, HUB);
    assert.equal(r.ok, true, `${u} → ${r.ok ? "" : r.error}`);
    return r as { ok: true; hubSite: boolean };
  };
  const bad = (u: string, re: RegExp) => {
    const r = books.checkBookUrl(u, HUB);
    assert.equal(r.ok, false, u);
    if (!r.ok) assert.match(r.error, re, u);
  };
  assert.equal(ok("https://shain1912.github.io/vibecoding-map-book/").hubSite, false);
  assert.equal(ok("http://my-book.localhost:3000/").hubSite, true);
  assert.equal(ok("http://my-book--ab12cd34ef.localhost:3000/docs/").hubSite, true, "미리보기 주소");
  bad("http://example.com/book/", /https/);
  bad("http://my-book.localhost:4000/", /https/);
  bad("http://localhost:3000/books", /https/);
  bad("http://a.b.localhost:3000/", /https/);
  bad("ftp://example.com/", /https/);
  bad("https://example.com:8443/", /443/);
  bad("https://localhost/", /인터넷/);
  bad("https://intranet/", /인터넷/);
  bad("https://printer.local/", /인터넷/);
  bad("https://10.0.0.5/", /사설/);
  bad("https://[::1]/", /사설/);
  bad("https://2130706433/", /사설/);
  bad("https://user:pw@example.com/", /비밀번호/);
  bad("https://example.com/010-1234-5678/", /개인정보/);
  bad(`https://example.com/${"a".repeat(600)}`, /500자/);
  bad("", /입력/);
  bad("책 주소", /올바른/);
});

test("checkBookUrl: SITES_DOMAIN이 있으면 https://<label>.<SITES_DOMAIN>만 허브 사이트", () => {
  process.env.SITES_DOMAIN = "dandi-sites.kr";
  try {
    assert.deepEqual(
      (({ ok, hubSite }) => ({ ok, hubSite }))(books.checkBookUrl("https://quiz.dandi-sites.kr/", HUB) as { ok: true; hubSite: boolean }),
      { ok: true, hubSite: true },
    );
    assert.equal(books.checkBookUrl("http://quiz.localhost:3000/", HUB).ok, false);
  } finally {
    delete process.env.SITES_DOMAIN;
  }
});

type Addr = { address: string; family: number };
const fakeResolver = (answers: Record<string, Addr[]>) => {
  const calls: string[] = [];
  const fn = (hostname: string, _opts: { all: true }, cb: (err: NodeJS.ErrnoException | null, a: Addr[]) => void) => {
    calls.push(hostname);
    const a = answers[hostname];
    if (!a) return cb(Object.assign(new Error("nx"), { code: "ENOTFOUND" }), []);
    cb(null, a);
  };
  return { fn, calls };
};

function lookupOnce(fn: ReturnType<typeof books.createGuardedLookup>, host: string, all = false) {
  return new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) =>
    fn(host, { all }, (err, address, family) => resolve({ err, address, family })),
  );
}

test("createGuardedLookup: 결과 중 하나라도 사설 IP면 연결 거부, *.localhost는 허브 사이트일 때만", async () => {
  const r = fakeResolver({
    "public.example": [{ address: "185.199.108.153", family: 4 }],
    "mixed.example": [{ address: "185.199.108.153", family: 4 }, { address: "10.0.0.8", family: 4 }],
    "rebind.example": [{ address: "::ffff:127.0.0.1", family: 6 }],
  });
  const guarded = books.createGuardedLookup(false, r.fn);
  const pub = await lookupOnce(guarded, "public.example");
  assert.equal(pub.err, null);
  assert.equal(pub.address, "185.199.108.153");
  assert.deepEqual((await lookupOnce(guarded, "public.example", true)).address, [{ address: "185.199.108.153", family: 4 }]);
  assert.equal((await lookupOnce(guarded, "mixed.example")).err?.code, "EBLOCKEDHOST");
  assert.equal((await lookupOnce(guarded, "rebind.example")).err?.code, "EBLOCKEDHOST");
  assert.equal((await lookupOnce(guarded, "book.localhost")).err?.code, "EBLOCKEDHOST");
  assert.equal((await lookupOnce(guarded, "nx.example")).err?.code, "ENOTFOUND");
  const hubSite = books.createGuardedLookup(true, r.fn);
  assert.equal((await lookupOnce(hubSite, "book.localhost")).address, "127.0.0.1");
  assert.equal((await lookupOnce(hubSite, "mixed.example")).err, null);
});

test("guardedFetchText: https 주소가 사설 IP로 풀리면 연결하지 않는다", async () => {
  const r = fakeResolver({ "books.example.com": [{ address: "169.254.169.254", family: 4 }] });
  const res = await books.guardedFetchText("https://books.example.com/", HUB, { resolver: r.fn, timeoutMs: 2000 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /내부망/);
  assert.deepEqual(r.calls, ["books.example.com"]);
});

/* ---------- 로컬 "허브 사이트" 서버로 가져오기 전 과정 ---------- */

const INDEX_HTML = `<!doctype html><html><head><title>로컬 웹북</title><meta name="description" content="로컬 테스트용 웹북"></head><body>본문</body></html>`;
const SITEMAP = (origin: string, prefix: string) =>
  `<urlset><url><loc>${origin}${prefix}</loc><lastmod>2026-09-01</lastmod></url><url><loc>${origin}${prefix}intro/</loc><lastmod>2026-09-05</lastmod></url></urlset>`;

let server: http.Server;
let port = 0;
let hub = "";
let bookOrigin = "";

async function startServer(): Promise<void> {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    const origin = `http://${req.headers.host}`;
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    if (p === "/" || p === "/nosearch/" || p === "/big/" || p === "/framed/") {
      const headers: Record<string, string> = p === "/framed/" ? { "x-frame-options": "DENY" } : {};
      return send(200, "text/html; charset=utf-8", INDEX_HTML, headers);
    }
    if (p === "/gz/") return send(200, "text/html", zlib.gzipSync(Buffer.from(INDEX_HTML)), { "content-encoding": "gzip" });
    if (p === "/sitemap.xml") return send(200, "application/xml", SITEMAP(origin, "/"));
    if (p === "/search/search_index.json") {
      return send(200, "application/json", JSON.stringify({
        docs: [
          { location: "", title: "로컬 웹북", text: "" },
          { location: "intro/", title: "1장 시작", text: "" },
          { location: "intro/#11", title: "1.1 준비 010-9876-5432", text: "" },
        ],
      }));
    }
    if (p === "/nosearch/sitemap.xml") return send(200, "application/xml", SITEMAP(origin, "/nosearch/"));
    if (p === "/big/search/search_index.json") {
      // content-length 없이 3MB를 조금씩 보낸다
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = "x".repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 3 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once("drain", pump);
        }
        res.end();
      };
      return pump();
    }
    if (p === "/declared-big") {
      res.writeHead(200, { "content-type": "text/html", "content-length": String(5 * 1024 * 1024) });
      return res.end();
    }
    if (p === "/hang") return; // 응답하지 않는다
    if (p === "/redirect-out") return send(302, "text/plain", "", { location: "http://example.com/" });
    if (p === "/redirect-in") return send(301, "text/plain", "", { location: "/" });
    if (p === "/loop") return send(302, "text/plain", "", { location: "/loop" });
    if (p === "/json/") return send(200, "application/json", "{}");
    send(404, "text/plain", "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  hub = `http://localhost:${port}`;
  bookOrigin = `http://my-book.localhost:${port}`;
}

after(() => new Promise<void>((resolve) => {
  if (!server) return resolve();
  server.closeAllConnections();
  server.close(() => resolve());
}));

test("importWebbook: 허브 사이트 주소에서 search_index로 목차, sitemap으로 최종 수정일", async () => {
  await startServer();
  const r = await books.importWebbook(`${bookOrigin}/redirect-in`, hub);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;
  const v = r.value;
  assert.equal(v.baseUrl, `${bookOrigin}/`);
  assert.equal(v.title, "로컬 웹북");
  assert.equal(v.summary, "로컬 테스트용 웹북");
  assert.equal(v.source, "search_index");
  assert.equal(v.pageCount, 2);
  assert.equal(v.lastmod, "2026-09-05");
  assert.deepEqual(v.toc.map((t) => [t.depth, t.href.slice(bookOrigin.length), t.title]), [
    [0, "/", "로컬 웹북"],
    [0, "/intro/", "1장 시작"],
    [1, "/intro/#11", "1.1 준비 ***"],
  ]);
  assert.equal(v.frameBlocked, false);
});

test("importWebbook: search_index가 없으면 sitemap, 너무 크면 경고 후 대체, gzip 응답 처리", async () => {
  const noSearch = await books.importWebbook(`${bookOrigin}/nosearch/`, hub);
  assert.equal(noSearch.ok, true);
  if (noSearch.ok) {
    assert.equal(noSearch.value.source, "sitemap");
    assert.deepEqual(noSearch.value.toc.map((t) => t.title), ["로컬 웹북", "intro"]);
    assert.deepEqual(noSearch.warnings, []);
  }
  const big = await books.importWebbook(`${bookOrigin}/big/`, hub);
  assert.equal(big.ok, true);
  if (big.ok) {
    assert.equal(big.value.source, "page");
    assert.ok(big.warnings.some((w) => /너무 큽니다/.test(w)), big.warnings.join(" / "));
  }
  const gz = await books.guardedFetchText(`${bookOrigin}/gz/`, hub);
  assert.equal(gz.ok && gz.text, INDEX_HTML);
  const framed = await books.importWebbook(`${bookOrigin}/framed/`, hub);
  assert.equal(framed.ok && framed.value.frameBlocked, true);
  const json = await books.importWebbook(`${bookOrigin}/json/`, hub);
  assert.equal(json.ok, false);
});

test("guardedFetchText: 2MB 상한, 타임아웃, 허용되지 않는 리다이렉트, 리다이렉트 횟수", async () => {
  const declared = await books.guardedFetchText(`${bookOrigin}/declared-big`, hub);
  assert.equal(declared.ok, false);
  if (!declared.ok) assert.match(declared.error, /너무 큽니다/);

  const started = Date.now();
  const hang = await books.guardedFetchText(`${bookOrigin}/hang`, hub, { timeoutMs: 300 });
  assert.equal(hang.ok, false);
  if (!hang.ok) assert.match(hang.error, /응답이 없습니다/);
  assert.ok(Date.now() - started < 2000);

  const out = await books.guardedFetchText(`${bookOrigin}/redirect-out`, hub);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error, /허용되지 않는 주소/);

  const loop = await books.guardedFetchText(`${bookOrigin}/loop`, hub);
  assert.equal(loop.ok, false);
  if (!loop.ok) assert.match(loop.error, /리다이렉트가 너무 많습니다/);

  const notFound = await books.guardedFetchText(`${bookOrigin}/missing`, hub);
  assert.equal(!notFound.ok && notFound.status, 404);
});

/* ---------- 저작권 게이트·검증·등록 ---------- */

test("applyCopyrightGate: 제3자 저작물이면 교사 전용 강제와 제25조 경고", () => {
  assert.deepEqual(books.applyCopyrightGate({ containsThirdPartyWorks: false, visibility: "public" }), {
    visibility: "public",
    forced: false,
    warning: null,
  });
  const g = books.applyCopyrightGate({ containsThirdPartyWorks: true, visibility: "public" });
  assert.equal(g.visibility, "teachers");
  assert.equal(g.forced, true);
  assert.match(g.warning ?? "", /저작권법」 제25조/);
  assert.equal(books.applyCopyrightGate({ containsThirdPartyWorks: true, visibility: "teachers" }).forced, false);
});

test("validateBookMeta: 길이 먼저, 개인정보 마스킹, 라이선스·학교급·공개 범위 검사", () => {
  const long = books.validateBookMeta(meta({ summary: `${"가".repeat(1001)}010-1234-5678` }), teacher);
  assert.equal(long.ok, false);
  if (!long.ok) assert.match(long.error, /1000자/);
  const masked = books.validateBookMeta(meta({ summary: "문의 010-1234-5678", authorName: "" }), teacher);
  assert.equal(masked.ok, true);
  if (masked.ok) {
    assert.equal(masked.value.summary, "문의 ***");
    assert.equal(masked.value.authorName, "데모 교사");
    assert.ok(masked.value.warnings.some((w) => /1건/.test(w)));
  }
  assert.equal(books.validateBookMeta(meta({ license: "마음대로" }), teacher).ok, false);
  assert.equal(books.validateBookMeta(meta({ schoolLevel: "univ" }), teacher).ok, false);
  assert.equal(books.validateBookMeta(meta({ visibility: "everyone" }), teacher).ok, false);
  assert.equal(books.validateBookMeta(meta({ title: " " }), teacher).ok, false);
  const fallback = books.validateBookMeta(meta({ title: "" }), teacher, "가져온 제목");
  assert.equal(fallback.ok && fallback.value.title, "가져온 제목");
  const gated = books.validateBookMeta(meta({ containsThirdPartyWorks: true, visibility: "public" }), teacher);
  assert.equal(gated.ok && gated.value.visibility, "teachers");
});

test("createWebbook: 교사만, 제3자 저작물이면 교사 전용으로 저장, 목록·열람 수·권한", async () => {
  const denied = await books.createWebbook({ ...meta(), url: `${bookOrigin}/` }, anon, hub);
  assert.equal(denied.ok, false);

  const pub = await books.createWebbook({ ...meta({ title: "" }), url: `${bookOrigin}/` }, teacher, hub);
  assert.equal(pub.ok, true, pub.ok ? "" : pub.error);
  const gated = await books.createWebbook(
    { ...meta({ title: "교과서 발췌 모음", containsThirdPartyWorks: true, visibility: "public" }), url: `${bookOrigin}/` },
    teacher,
    hub,
  );
  assert.equal(gated.ok, true);
  if (!pub.ok || !gated.ok) return;
  assert.equal(pub.value.title, "로컬 웹북", "제목을 비우면 가져온 제목");
  assert.equal(pub.value.visibility, "public");
  assert.equal(gated.value.visibility, "teachers");
  assert.ok(gated.warnings.some((w) => /교사 전용으로 바꾸었습니다/.test(w)));

  const anonList = await books.listBooks({}, anon);
  assert.ok(anonList.some((b) => b.id === pub.value.id));
  assert.ok(!anonList.some((b) => b.id === gated.value.id), "익명에게 교사 전용 책은 보이지 않는다");
  assert.ok((await books.listBooks({}, otherTeacher)).some((b) => b.id === gated.value.id));
  assert.ok((await books.listBooks({ kind: "pdf" }, teacher)).every((b) => b.kind === "pdf"));

  await books.incrementBookViews(gated.value.id, anon);
  await books.incrementBookViews(gated.value.id, otherTeacher);
  await books.incrementBookViews(pub.value.id, anon);
  assert.equal((await books.getBook(gated.value.id))?.viewCount, 1);
  assert.equal((await books.getBook(pub.value.id))?.viewCount, 1);
  const byViews = await books.listBooks({ sort: "views" }, teacher);
  assert.ok(byViews[0].viewCount >= byViews[byViews.length - 1].viewCount);

  // 수정: 다른 교사는 불가, 본인은 가능하며 게이트가 다시 적용된다
  assert.equal((await books.updateBook(pub.value.id, meta(), otherTeacher)).ok, false);
  const upd = await books.updateBook(pub.value.id, meta({ containsThirdPartyWorks: true, visibility: "public" }), teacher);
  assert.equal(upd.ok && upd.value.visibility, "teachers");
  const byAdmin = await books.updateBook(pub.value.id, meta({ visibility: "public" }), admin);
  assert.equal(byAdmin.ok && byAdmin.value.visibility, "public");

  const refreshed = await books.refreshWebbookToc(pub.value.id, teacher, hub);
  assert.equal(refreshed.ok && refreshed.value.toc.length, 3);

  assert.equal((await books.deleteBook(pub.value.id, otherTeacher)).ok, false);
  assert.equal((await books.deleteBook(pub.value.id, teacher)).ok, true);
  assert.equal(await books.getBook(pub.value.id), null);

  const audit = (await readDb()).audit.map((a) => a.action);
  assert.ok(audit.includes("book.create") && audit.includes("book.update") && audit.includes("book.delete"));
});

test("PDF 책: 새 업로드는 자료실에 저장, PDF가 아니면 거부, 자료실 파일은 본인·관리자만, 교사 전용 파일 열람 제한", async () => {
  const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
  const notPdf = await books.createPdfBookFromUpload(
    { ...meta(), file: new File([Buffer.from("<html>not pdf</html>")], "fake.pdf", { type: "application/pdf" }) },
    teacher,
  );
  assert.equal(notPdf.ok, false);
  if (!notPdf.ok) assert.match(notPdf.error, /PDF 형식이 아닌/);

  const wrongExt = await books.createPdfBookFromUpload({ ...meta(), file: new File([pdfBytes], "doc.hwp") }, teacher);
  assert.equal(wrongExt.ok, false);

  const up = await books.createPdfBookFromUpload(
    { ...meta({ title: "", containsThirdPartyWorks: true }), file: new File([pdfBytes], "수업 자료.pdf") },
    teacher,
  );
  assert.equal(up.ok, true, up.ok ? "" : up.error);
  if (!up.ok) return;
  assert.equal(up.value.kind, "pdf");
  assert.equal(up.value.title, "수업 자료");
  assert.equal(up.value.visibility, "teachers");
  const fileId = up.value.fileId as string;
  const db = await readDb();
  const file = db.files.find((f) => f.id === fileId);
  assert.ok(file, "자료실에 등록된다");
  assert.equal(await books.storedFileIsPdf(file!), true);

  // 교사 전용 책의 파일: 익명은 열람 불가, 교사는 가능
  assert.equal(await books.canViewFileInline(fileId, anon), false);
  assert.equal(await books.canViewFileInline(fileId, otherTeacher), true);

  // 자료실 파일로 책 만들기: 다른 교사는 불가, 관리자는 가능
  assert.equal((await books.createPdfBookFromFile({ ...meta(), fileId }, otherTeacher)).ok, false);
  const byAdmin = await books.createPdfBookFromFile({ ...meta({ title: "관리자 등록" }), fileId }, admin);
  assert.equal(byAdmin.ok, true);
  assert.equal((await books.createPdfBookFromFile({ ...meta(), fileId: "file_nope" }, teacher)).ok, false);
  assert.deepEqual((await books.listPdfFilesFor(teacher)).map((f) => f.id), [fileId]);
  assert.deepEqual(await books.listPdfFilesFor(otherTeacher), []);
  assert.deepEqual(await books.listPdfFilesFor(anon), []);

  // 교사 전용 책을 지우면(공개 책만 남으면) 누구나 열람
  assert.equal((await books.deleteBook(up.value.id, teacher)).ok, true);
  assert.equal(await books.canViewFileInline(fileId, anon), true);
});

test("시드: 코드코리아 웹북은 공개 웹북이고 목차 주소가 모두 책 주소 아래 절대 주소", async () => {
  const { SEED_BOOKS } = await import("../src/lib/seed-books.ts");
  assert.equal(SEED_BOOKS.length, 1);
  const b = SEED_BOOKS[0];
  assert.equal(b.kind, "webbook");
  assert.equal(b.visibility, "public");
  assert.equal(b.authorName, "코드코리아");
  assert.equal(b.baseUrl, "https://shain1912.github.io/vibecoding-map-book/");
  assert.ok(b.toc.length > 30 && b.toc.length <= books.TOC_MAX_ITEMS);
  assert.equal(b.toc.filter((t) => t.depth === 0).length, 30);
  for (const t of b.toc) assert.ok(books.isWithinBook(t.href, b.baseUrl!), t.href);
  assert.ok(books.BOOK_LICENSES.includes(b.license as (typeof books.BOOK_LICENSES)[number]));
  // 새 저장소는 시드 책으로 시작한다
  assert.ok((await readDb()).books.some((x) => x.id === b.id));
});
