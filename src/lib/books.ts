import "server-only";
import dns from "node:dns";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";
import { isLevelOrAll, isSchoolLevel } from "./constants";
import { mutate, newId, nowIso, readDb } from "./db";
import { saveUpload, storedFilePath } from "./files";
import { maskFields, maskPII } from "./pii";
import { displayName, ensureUser, isTeacher, writeAudit } from "./session";
import { normalizeNewlines, urlHasPII } from "./text";
import type { Book, BookTocItem, DB, FileItem, LevelOrAll, User } from "./types";

// 전자책 서가 도메인 로직(F-43 ~ F-45).
// - 웹북: 이미 올라가 있는 사이트 주소를 등록하면 서버가 sitemap.xml·search/search_index.json(mkdocs)에서 목차를 모은다.
//   서버가 교사가 준 주소로 직접 요청을 보내므로 SSRF 방어가 필요하다: https 주소(또는 이 허브의 사이트 주소)만 받고,
//   DNS 조회 결과가 사설·예약 IP면 연결하지 않는다(연결 시점에 검사해 DNS 재바인딩도 막는다). 5초·2MB·500항목 상한.
// - PDF: 자료실(F-08) 파일을 서가에 올리거나 새로 올린다. 브라우저 안 열람은 /api/files/[id]/view가 맡는다.
// - 저작권 게이트(F-45): 제3자 저작물이 포함된 책은 교사 전용으로 강제하고 경고 문구를 붙인다(저작권법 제25조).

export type BookResult<T> = { ok: true; value: T; warnings: string[] } | { ok: false; error: string };

export const BOOK_TITLE_MAX = 100;
export const BOOK_SUMMARY_MAX = 1000;
export const BOOK_AUTHOR_MAX = 60;
export const BOOK_URL_MAX = 500;
export const TOC_MAX_ITEMS = 500;
export const TOC_TITLE_MAX = 200;
export const IMPORT_TIMEOUT_MS = 5000;
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** 이용 조건 선택지. 자유 입력 대신 목록에서 고르게 해 표기를 통일한다. */
export const BOOK_LICENSES = [
  "CC BY 4.0",
  "CC BY-SA 4.0",
  "CC BY-NC 4.0",
  "CC BY-NC-SA 4.0",
  "CC BY-ND 4.0",
  "CC BY-NC-ND 4.0",
  "CC0 1.0",
  "공공누리 제1유형",
  "공공누리 제2유형",
  "공공누리 제3유형",
  "공공누리 제4유형",
  "저작권자 이용 허락",
  "모든 권리 보유",
] as const;

/** F-45 경고 문구(저작권법 제25조, 같은 법 시행령 제9조의 경고문구 표시). */
export const COPYRIGHT_WARNING =
  "이 책에는 제3자의 저작물이 포함되어 있어 교사 전용으로만 열람할 수 있습니다. 「저작권법」 제25조에 따라 수업 목적으로만 이용할 수 있으며, 수업 목적 외의 복제·배포·공중송신을 금지합니다.";

export const BOOK_KIND_LABEL: Record<Book["kind"], string> = { webbook: "웹북", pdf: "PDF" };

/* ---------- 열람 권한 ---------- */

/** 교사 전용 책인가. 제3자 저작물이 포함된 책은 저장된 값과 관계없이 교사 전용으로 본다. */
export function isTeachersOnly(book: Pick<Book, "visibility" | "containsThirdPartyWorks">): boolean {
  return book.visibility === "teachers" || book.containsThirdPartyWorks;
}

export function canViewBook(book: Book, viewer: User | null): boolean {
  if (!isTeachersOnly(book)) return true;
  return !!viewer && isTeacher(viewer);
}

/** 수정·삭제·목차 다시 가져오기: 등록한 교사 본인 또는 관리자. */
export function canManageBook(book: Book, viewer: User | null): boolean {
  if (!viewer) return false;
  return viewer.role === "admin" || (isTeacher(viewer) && viewer.id === book.ownerUserId);
}

/* ---------- 저작권 게이트 (F-45) ---------- */

export function applyCopyrightGate(input: {
  containsThirdPartyWorks: boolean;
  visibility: Book["visibility"];
}): { visibility: Book["visibility"]; forced: boolean; warning: string | null } {
  if (!input.containsThirdPartyWorks) return { visibility: input.visibility, forced: false, warning: null };
  return { visibility: "teachers", forced: input.visibility !== "teachers", warning: COPYRIGHT_WARNING };
}

/* ---------- 목록·조회 ---------- */

export type BookSort = "recent" | "views";

export async function listBooks(
  filter: { level?: string | null; kind?: string | null; sort?: string | null } = {},
  viewer: User | null = null,
): Promise<Book[]> {
  const db = await readDb();
  const level = isSchoolLevel(filter.level) ? filter.level : null;
  const kind = filter.kind === "webbook" || filter.kind === "pdf" ? filter.kind : null;
  const sort: BookSort = filter.sort === "views" ? "views" : "recent";
  return db.books
    .filter((b) => canViewBook(b, viewer))
    .filter((b) => !level || b.schoolLevel === level || b.schoolLevel === "all")
    .filter((b) => !kind || b.kind === kind)
    .sort((a, b) =>
      sort === "views"
        ? b.viewCount - a.viewCount || b.updatedAt.localeCompare(a.updatedAt)
        : b.updatedAt.localeCompare(a.updatedAt),
    );
}

export async function getBook(id: string): Promise<Book | null> {
  const db = await readDb();
  return db.books.find((b) => b.id === id) ?? null;
}

/** 열람 수 +1. 볼 수 없는 책(교사 전용인데 교사가 아님)은 세지 않는다. */
export async function incrementBookViews(id: string, viewer: User | null): Promise<void> {
  await mutate((db) => {
    const book = db.books.find((b) => b.id === id);
    if (book && canViewBook(book, viewer)) book.viewCount += 1;
  });
}

/** PDF 책으로 올릴 수 있는 자료실 파일: 본인이 올린 PDF(관리자는 전체). */
export async function listPdfFilesFor(user: User): Promise<FileItem[]> {
  if (!isTeacher(user)) return [];
  const db = await readDb();
  return db.files
    .filter((f) => f.ext === "pdf" && (user.role === "admin" || f.authorId === user.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 교사 전용 책이 쓰는 자료실 파일인가. 이 파일은 교사만 브라우저에서 열람할 수 있다. */
export function fileRestrictedToTeachers(db: DB, fileId: string): boolean {
  return db.books.some((b) => b.kind === "pdf" && b.fileId === fileId && isTeachersOnly(b));
}

/** /api/files/[id]/view 열람 허용 여부. 공개 자료는 로그인 없이, 교사 전용 책의 파일은 교사만. */
export async function canViewFileInline(fileId: string, viewer: User | null): Promise<boolean> {
  return (await fileInlineAccess(fileId, viewer)).allowed;
}

/** canViewFileInline과 같은 판단에 교사 전용 여부(restricted)를 함께 돌려준다(캐시 정책을 정할 때 쓴다). */
export async function fileInlineAccess(fileId: string, viewer: User | null): Promise<{ allowed: boolean; restricted: boolean }> {
  const db = await readDb();
  const restricted = fileRestrictedToTeachers(db, fileId);
  return { allowed: !restricted || (!!viewer && isTeacher(viewer)), restricted };
}

/** 앞 1KB 안에 PDF 머리말(%PDF-)이 있는가. 확장자만 pdf인 다른 파일을 PDF로 내보내지 않기 위해 쓴다. */
export function looksLikePdf(head: Uint8Array): boolean {
  const text = Buffer.from(head.subarray(0, 1024)).toString("latin1");
  return text.includes("%PDF-");
}

/* ---------- PDF 열람 응답(/api/files/[id]/view): 부분 요청·캐시 검증 ---------- */

export type ByteRange = { start: number; end: number };

/**
 * Range 헤더(단일 구간만). pdf.js가 큰 PDF를 앞부분부터 나눠 받을 때 쓴다(RFC 9110 14.2).
 * null = Range를 무시하고 전체를 보낸다(없음·다른 단위·여러 구간·형식 오류), "unsatisfiable" = 416.
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null; // 여러 구간(쉼표)·다른 단위는 전체 응답으로 대신한다(허용되는 동작)
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a.length > 15 || b.length > 15) return null;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  if (b !== "" && Number(b) < start) return null; // 잘못된 구간은 무시(RFC 9110: 무효한 Range는 무시)
  if (start >= size) return "unsatisfiable";
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  return { start, end };
}

/** 저장 파일의 ETag. 자료실 파일은 저장 후 바뀌지 않으므로 크기·수정 시각으로 만든다(강한 검증자). */
export function fileEtag(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

/** If-None-Match가 이 ETag와 맞는가(약한 비교, "*" 포함). */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = etag.replace(/^W\//, "");
  return ifNoneMatch.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v.replace(/^W\//, "") === bare;
  });
}

/** If-Range가 있으면 지금 파일과 같을 때만 Range를 적용한다(강한 비교 또는 같은 Last-Modified). */
export function ifRangeAllows(ifRange: string | null | undefined, etag: string, lastModified: string): boolean {
  if (!ifRange) return true;
  const v = ifRange.trim();
  if (v.startsWith('"') || v.startsWith("W/")) return v === etag;
  return v === lastModified;
}

/** If-Modified-Since 이후로 바뀌지 않았는가(초 단위). If-None-Match가 있으면 그것만 본다(호출하는 쪽이 판단). */
export function notModifiedSince(ifModifiedSince: string | null | undefined, mtimeMs: number): boolean {
  if (!ifModifiedSince) return false;
  const since = Date.parse(ifModifiedSince);
  return Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
}

export async function storedFileIsPdf(item: Pick<FileItem, "storedName" | "ext">): Promise<boolean> {
  if (item.ext !== "pdf") return false;
  const full = storedFilePath(item);
  if (!full) return false;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(full, "r");
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return looksLikePdf(buf.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/* ---------- SSRF 방어 ---------- */

// 연결하면 안 되는 주소 대역: 사설망·루프백·링크 로컬·CGNAT·문서용·멀티캐스트·예약 대역.
const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 96], // 미지정(::)·루프백(::1)·IPv4 호환 주소
  ["100::", 64], // 폐기 대역
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // 문서용
  ["2002::", 16], // 6to4
  ["64:ff9b:1::", 48], // 로컬 NAT64
  ["fc00::", 7], // 고유 로컬
  ["fe80::", 10], // 링크 로컬
  ["fec0::", 10], // 사이트 로컬(폐기)
  ["ff00::", 8], // 멀티캐스트
] as const) {
  BLOCKED.addSubnet(addr, prefix, "ipv6");
}

/** IPv6 안에 IPv4가 들어 있는 형식(::ffff:a.b.c.d, 64:ff9b::a.b.c.d)이면 그 IPv4를 꺼낸다. */
function embeddedIpv4(ip: string): string | null {
  const m = /^(?:::ffff:|64:ff9b::)(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(ip);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16);
  const lo = parseInt(m[3], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** 서버가 연결하면 안 되는 주소인가(사설·루프백·링크 로컬·예약 등). IP가 아니면 true(안전 쪽). */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const kind = net.isIP(bare);
  if (kind === 4) return BLOCKED.check(bare, "ipv4");
  if (kind === 6) {
    const v4 = embeddedIpv4(bare);
    if (v4) return net.isIP(v4) !== 4 || BLOCKED.check(v4, "ipv4");
    return BLOCKED.check(bare, "ipv6");
  }
  return true;
}

const SITE_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * 이 허브가 호스팅하는 사이트 주소인가(F-51). origin.ts siteOrigin과 같은 규칙:
 * SITES_DOMAIN이 있으면 https://<label>.<SITES_DOMAIN>, 없으면 허브 호스트 앞에 label을 붙인 주소.
 */
export function isHubSiteUrl(u: URL, hub: string): boolean {
  const host = u.hostname.toLowerCase();
  const sitesDomain = process.env.SITES_DOMAIN?.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (sitesDomain) {
    if (u.protocol !== "https:" || u.port !== "") return false;
    return host.endsWith(`.${sitesDomain}`) && SITE_LABEL_RE.test(host.slice(0, -sitesDomain.length - 1));
  }
  let h: URL;
  try {
    h = new URL(hub);
  } catch {
    return false;
  }
  const hubHost = h.hostname.toLowerCase();
  if (net.isIP(hubHost.replace(/^\[|\]$/g, ""))) return false;
  if (u.protocol !== h.protocol || u.port !== h.port) return false;
  return host.endsWith(`.${hubHost}`) && SITE_LABEL_RE.test(host.slice(0, -hubHost.length - 1));
}

export type UrlCheck = { ok: true; url: URL; hubSite: boolean } | { ok: false; error: string };

/**
 * 등록·가져오기에 쓸 수 있는 주소인지 형식만 검사한다(DNS 확인은 연결 시점에 한다).
 * 허용: https 기본 포트 주소, 또는 이 허브의 사이트 주소(로컬 http://<slug>.localhost:3000 포함).
 */
export function checkBookUrl(raw: string, hub: string): UrlCheck {
  return checkPublicUrl(raw, hub, "책 주소");
}

/** checkBookUrl과 같은 규칙. what은 오류 문구에 쓰는 이름("책 주소", "표지 이미지 주소"). */
function checkPublicUrl(raw: string, hub: string, what: string): UrlCheck {
  const text = raw.trim();
  if (!text) return { ok: false, error: `${what}를 입력하십시오.` };
  // 길이를 먼저 확인한 뒤 형식·개인정보를 검사한다.
  if (text.length > BOOK_URL_MAX) return { ok: false, error: `${what}는 ${BOOK_URL_MAX}자 이하로 입력하십시오.` };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "올바른 주소가 아닙니다. https:// 로 시작하는 전체 주소를 입력하십시오." };
  }
  if (url.username || url.password) return { ok: false, error: "주소에 사용자 이름이나 비밀번호를 넣을 수 없습니다." };
  if (urlHasPII(text)) {
    return { ok: false, error: "주소에 개인정보(전화번호·이메일 등)로 보이는 값이 있습니다. 개인정보가 없는 주소를 입력하십시오." };
  }
  if (isHubSiteUrl(url, hub)) return { ok: true, url, hubSite: true };
  if (url.protocol !== "https:") {
    return { ok: false, error: "https 주소 또는 이 허브에 올린 사이트 주소만 등록할 수 있습니다." };
  }
  if (url.port !== "") return { ok: false, error: "기본 포트(443)를 쓰는 https 주소만 등록할 수 있습니다." };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) return { ok: false, error: "내부망(사설 IP) 주소는 등록할 수 없습니다." };
    return { ok: true, url, hubSite: false };
  }
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|home\.arpa)$/.test(host)) {
    return { ok: false, error: "인터넷에 공개된 주소만 등록할 수 있습니다." };
  }
  return { ok: true, url, hubSite: false };
}

export type CoverCheck = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * 표지 이미지 주소(F-43). 비우면 표지 없음(null). 책 주소와 같은 규칙(https 공개 주소 또는 이 허브의 사이트 주소)만 받는다.
 * 서버는 이 주소로 요청을 보내지 않고, 서가 화면의 <img>가 방문자 브라우저에서 불러온다.
 * 그래서 내부망 주소를 막아 방문자 브라우저가 학교 내부 기기로 요청을 보내게 만들지 못하게 한다.
 */
export function checkCoverUrl(raw: string, hub: string): CoverCheck {
  const text = raw.trim();
  if (!text) return { ok: true, value: null };
  const r = checkPublicUrl(text, hub, "표지 이미지 주소");
  if (!r.ok) return { ok: false, error: r.error.startsWith("표지") ? r.error : `표지 이미지 주소: ${r.error}` };
  r.url.hash = "";
  const value = r.url.toString();
  if (value.length > BOOK_URL_MAX) return { ok: false, error: `표지 이미지 주소는 ${BOOK_URL_MAX}자 이하로 입력하십시오.` };
  return { ok: true, value };
}

type LookupAll = (
  hostname: string,
  options: { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

const defaultResolver: LookupAll = (hostname, options, callback) => dns.lookup(hostname, options, callback);

function lookupError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/**
 * http(s).request의 lookup 옵션. 연결할 때 DNS를 조회해, 결과 중 하나라도 사설·예약 주소면 연결하지 않는다.
 * allowPrivate(허브 사이트 주소)일 때는 검사하지 않고, *.localhost는 루프백으로 해석한다(RFC 6761).
 */
export function createGuardedLookup(allowPrivate: boolean, resolver: LookupAll = defaultResolver): net.LookupFunction {
  return (hostname, options, callback) => {
    const finish = (addresses: dns.LookupAddress[]) => {
      const wanted = options.family === 4 || options.family === 6 ? addresses.filter((a) => a.family === options.family) : addresses;
      if (wanted.length === 0) return callback(lookupError("ENOTFOUND", "주소를 찾을 수 없습니다."), "", 0);
      if (options.all) return callback(null, wanted);
      return callback(null, wanted[0].address, wanted[0].family);
    };
    if (/(^|\.)localhost$/i.test(hostname)) {
      if (!allowPrivate) return callback(lookupError("EBLOCKEDHOST", "내부망 주소입니다."), "", 0);
      return finish([{ address: "127.0.0.1", family: 4 }]);
    }
    resolver(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      if (!allowPrivate && (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address)))) {
        return callback(lookupError("EBLOCKEDHOST", "내부망 주소입니다."), "", 0);
      }
      finish(addresses);
    });
  };
}

export type FetchTextResult =
  | {
      ok: true;
      text: string;
      finalUrl: string;
      contentType: string;
      /** 다른 사이트 안(iframe)에 표시하는 것을 막는 응답 헤더가 있었는가 */
      frameBlocked: boolean;
    }
  | { ok: false; error: string; status?: number };

export interface FetchOptions {
  accept?: string;
  timeoutMs?: number;
  maxBytes?: number;
  resolver?: LookupAll;
}

type OnceResult =
  | { kind: "redirect"; location: string | null }
  | { kind: "body"; text: string; contentType: string; frameBlocked: boolean }
  | { kind: "error"; error: string; status?: number };

function describeNetError(err: NodeJS.ErrnoException, timeoutMs: number): string {
  switch (err.code) {
    case "EBLOCKEDHOST":
      return "내부망(사설 IP)으로 연결되는 주소라 가져올 수 없습니다.";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "주소를 찾을 수 없습니다. 주소를 다시 확인하십시오.";
    case "ETIMEDOUT":
      return `${Math.round(timeoutMs / 1000)}초 안에 응답이 없습니다.`;
    case "ECONNREFUSED":
      return "사이트가 연결을 거부했습니다.";
    default:
      return err.code?.startsWith("ERR_TLS") || err.code?.includes("CERT")
        ? "사이트의 보안 인증서를 확인하지 못했습니다."
        : "사이트에 연결하지 못했습니다.";
  }
}

function headerText(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v.join(", ") : String(v ?? "")).toLowerCase();
}

function parseUrlSafe(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** URL의 포트(없으면 스킴의 기본 포트). */
function effectivePort(u: URL): string {
  if (u.port) return u.port;
  return u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "";
}

/** 스킴이 같거나 http → https 승격인가(CSP3 scheme-part match). */
function schemeMatches(expected: string, actual: string): boolean {
  return expected === actual || (expected === "http:" && actual === "https:");
}

/**
 * CSP 원본 식(source expression) 하나가 ancestor origin을 허용하는가(CSP3 6.7.2 요약).
 * self는 보호받는 문서(가져온 웹북 페이지)의 origin이다. 경로 부분은 무시한다(경고용이라 느슨하게).
 */
function cspSourceAllows(source: string, ancestor: URL, self: URL): boolean {
  const s = source.trim().toLowerCase();
  if (!s || s === "'none'") return false;
  if (s === "*") return ancestor.protocol === "https:" || ancestor.protocol === "http:" || ancestor.protocol === self.protocol;
  if (s === "'self'") return ancestor.origin === self.origin;
  const schemeOnly = /^([a-z][a-z0-9+.-]*):$/.exec(s);
  if (schemeOnly) return schemeMatches(`${schemeOnly[1]}:`, ancestor.protocol);
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::(\d{1,5}|\*))?(?:\/.*)?$/.exec(s);
  if (!m) return false;
  const [, scheme, host, port] = m;
  if (!schemeMatches(scheme ? `${scheme}:` : self.protocol, ancestor.protocol)) return false;
  const ah = ancestor.hostname.toLowerCase();
  if (host.startsWith("*.")) {
    if (!ah.endsWith(host.slice(1))) return false;
  } else if (host !== "*" && host !== ah) {
    return false;
  }
  if (port === "*") return true;
  const ap = effectivePort(ancestor);
  if (port) return port === ap || (port === "80" && ap === "443" && ancestor.protocol === "https:");
  // 포트를 적지 않으면 ancestor 스킴의 기본 포트만 맞는다.
  return ancestor.port === "";
}

/**
 * 응답 헤더를 보면 이 허브(hub) 화면 안의 iframe으로 표시할 수 없는가(F-43 리더 경고용).
 * - CSP frame-ancestors가 있으면 X-Frame-Options보다 우선한다(브라우저 동작과 같다). 정책이 여러 개면 모두 허용해야 한다.
 *   허브 origin을 적었거나(허브 사이트는 `frame-ancestors <허브>`를 보낸다) *, 같은 origin의 'self'면 허용으로 본다.
 * - frame-ancestors가 없으면 X-Frame-Options: DENY는 차단, SAMEORIGIN은 허브와 같은 origin일 때만 허용.
 * - hub가 올바른 주소가 아니면 frame-ancestors가 있기만 해도 차단으로 본다(예전 동작).
 */
export function isFrameBlocked(
  headers: Record<string, string | string[] | undefined>,
  pageUrl: string,
  hub: string,
): boolean {
  const self = parseUrlSafe(pageUrl);
  const hubUrl = parseUrlSafe(hub);
  const policies = headerText(headers["content-security-policy"])
    .split(",")
    .map((policy) =>
      policy
        .split(";")
        .map((d) => d.trim().split(/\s+/))
        .find((tokens) => tokens[0] === "frame-ancestors"),
    )
    .filter((d): d is string[] => !!d);
  if (policies.length > 0) {
    if (!self || !hubUrl) return true;
    return policies.some((tokens) => !tokens.slice(1).some((src) => cspSourceAllows(src, hubUrl, self)));
  }
  const xfo = headerText(headers["x-frame-options"])
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (xfo.includes("deny")) return true;
  if (xfo.includes("sameorigin")) return !self || !hubUrl || self.origin !== hubUrl.origin;
  return false;
}

type RequestOptions = Required<Omit<FetchOptions, "resolver">> & { resolver?: LookupAll; hub: string };

function requestOnce(url: URL, allowPrivate: boolean, deadline: number, opts: RequestOptions): Promise<OnceResult> {
  return new Promise((resolve) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return resolve({ kind: "error", error: `${Math.round(opts.timeoutMs / 1000)}초 안에 응답이 없습니다.` });
    let settled = false;
    let req: http.ClientRequest | null = null;
    const done = (r: OnceResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req?.destroy();
      resolve(r);
    };
    const timer = setTimeout(
      () => done({ kind: "error", error: `${Math.round(opts.timeoutMs / 1000)}초 안에 응답이 없습니다.` }),
      remaining,
    );
    const tooLarge = `응답이 너무 큽니다(최대 ${Math.round(opts.maxBytes / (1024 * 1024))}MB).`;
    const mod = url.protocol === "https:" ? https : http;
    try {
      req = mod.request(
        url,
        {
          method: "GET",
          agent: false, // 연결을 재사용하지 않아 요청마다 lookup 검사를 거친다
          lookup: createGuardedLookup(allowPrivate, opts.resolver),
          headers: {
            "user-agent": "Dandi-BookImporter/0.2",
            accept: opts.accept,
            "accept-encoding": "gzip, deflate, br",
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            res.resume();
            return done({ kind: "redirect", location: typeof res.headers.location === "string" ? res.headers.location : null });
          }
          if (status < 200 || status >= 300) {
            res.resume();
            return done({ kind: "error", error: `사이트가 오류 응답(${status})을 보냈습니다.`, status });
          }
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > opts.maxBytes) return done({ kind: "error", error: tooLarge });

          const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
          let stream: Readable = res;
          if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(zlib.createGunzip());
          else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
          else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
          else if (encoding && encoding !== "identity") return done({ kind: "error", error: "지원하지 않는 압축 형식입니다." });

          const chunks: Buffer[] = [];
          let total = 0;
          stream.on("data", (chunk: Buffer) => {
            total += chunk.length;
            // 압축을 푼 크기로 센다(압축 폭탄 방지).
            if (total > opts.maxBytes) {
              stream.destroy();
              return done({ kind: "error", error: tooLarge });
            }
            chunks.push(chunk);
          });
          stream.on("end", () =>
            done({
              kind: "body",
              text: Buffer.concat(chunks).toString("utf8"),
              contentType: String(res.headers["content-type"] ?? ""),
              frameBlocked: isFrameBlocked(res.headers, url.toString(), opts.hub),
            }),
          );
          stream.on("error", () => done({ kind: "error", error: "응답을 읽지 못했습니다." }));
          res.on("error", () => done({ kind: "error", error: "응답을 읽지 못했습니다." }));
        },
      );
    } catch {
      return done({ kind: "error", error: "사이트에 연결하지 못했습니다." });
    }
    req.on("error", (err: NodeJS.ErrnoException) => done({ kind: "error", error: describeNetError(err, opts.timeoutMs) }));
    req.end();
  });
}

/**
 * SSRF 방어를 거친 GET. 주소 검사(checkBookUrl) → 연결 시 DNS 검사 → 리다이렉트마다 다시 검사.
 * 전체 5초(리다이렉트 포함), 압축을 푼 본문 2MB 상한.
 */
export async function guardedFetchText(rawUrl: string, hub: string, options: FetchOptions = {}): Promise<FetchTextResult> {
  const opts: RequestOptions = {
    accept: options.accept ?? "*/*",
    timeoutMs: options.timeoutMs ?? IMPORT_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? IMPORT_MAX_BYTES,
    resolver: options.resolver,
    hub,
  };
  const deadline = Date.now() + opts.timeoutMs;
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = checkBookUrl(current, hub);
    if (!check.ok) return { ok: false, error: hop === 0 ? check.error : `다른 주소로 이동했지만 허용되지 않는 주소입니다. ${check.error}` };
    const r = await requestOnce(check.url, check.hubSite, deadline, opts);
    if (r.kind === "error") return { ok: false, error: r.error, status: r.status };
    if (r.kind === "body") {
      return { ok: true, text: r.text, finalUrl: check.url.toString(), contentType: r.contentType, frameBlocked: r.frameBlocked };
    }
    if (!r.location) return { ok: false, error: "이동할 주소가 없는 리다이렉트 응답입니다." };
    try {
      current = new URL(r.location, check.url).toString();
    } catch {
      return { ok: false, error: "리다이렉트 주소가 올바르지 않습니다." };
    }
  }
  return { ok: false, error: "리다이렉트가 너무 많습니다." };
}

/* ---------- 목차 파싱 ---------- */

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

function cutAt(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

/** 외부 사이트에서 가져온 한 줄 텍스트: 태그 제거 → 엔티티 해석 → 제어 문자·공백 정리 → 길이 자르기. */
export function cleanRemoteText(s: string, max: number): string {
  const t = decodeEntities(s.replace(/<[^>]{0,500}>/g, " "))
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cutAt(t, max);
}

/** 책 주소를 "디렉터리" 형태로 맞춘다(쿼리·해시 제거, 파일 이름 제거, 끝 슬래시). */
export function normalizeBaseUrl(input: URL | string): string {
  const u = new URL(input.toString());
  u.hash = "";
  u.search = "";
  const last = u.pathname.split("/").pop() ?? "";
  if (last.includes(".")) u.pathname = u.pathname.slice(0, u.pathname.length - last.length);
  else if (!u.pathname.endsWith("/")) u.pathname += "/";
  return u.toString();
}

/** href가 이 책(같은 origin, 책 경로 아래)에 속하는 http(s) 주소인가. */
export function isWithinBook(href: string, baseUrl: string): boolean {
  try {
    const u = new URL(href);
    const b = new URL(baseUrl);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === b.origin && u.pathname.startsWith(b.pathname);
  } catch {
    return false;
  }
}

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export function parseSitemap(xml: string): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  const re = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
  for (let m = re.exec(xml); m && out.length < 10000; m = re.exec(xml)) {
    const loc = /<loc\b[^>]*>([\s\S]*?)<\/loc>/i.exec(m[1]);
    if (!loc) continue;
    const lastmod = /<lastmod\b[^>]*>\s*(\d{4}-\d{2}-\d{2})/i.exec(m[1]);
    out.push({
      loc: decodeEntities(loc[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()),
      lastmod: lastmod ? lastmod[1] : null,
    });
  }
  return out;
}

export interface SearchIndexDoc {
  location: string;
  title: string;
}

/** mkdocs(및 Material) search/search_index.json의 docs 배열. 형식이 다르면 null. */
export function parseSearchIndex(data: unknown): SearchIndexDoc[] | null {
  if (!data || typeof data !== "object") return null;
  const docs = (data as { docs?: unknown }).docs;
  if (!Array.isArray(docs)) return null;
  const out: SearchIndexDoc[] = [];
  for (const d of docs.slice(0, 20000)) {
    if (!d || typeof d !== "object") continue;
    const { location, title } = d as { location?: unknown; title?: unknown };
    if (typeof location === "string" && typeof title === "string") out.push({ location, title });
  }
  return out;
}

// "1.2 제목", "A.3 제목", "10.1.2 제목"처럼 번호가 붙은 절
const NUMBERED_SECTION = /^((?:\d{1,3}|[A-Z])(?:\.\d{1,3})+)\.?\s/;

/**
 * search_index 문서 목록 → 목차. 페이지(주소에 #이 없음)는 depth 0, 절은 depth 1~2.
 * 번호가 붙은 절(1.2)은 번호 깊이로, 번호 없는 절은 같은 페이지에 번호 절이 앞서 나왔으면 그 아래(depth 2)로 둔다.
 */
export function tocFromSearchIndex(docs: SearchIndexDoc[], baseUrl: string): BookTocItem[] {
  const items: BookTocItem[] = [];
  let pageHasNumbered = false;
  for (const d of docs) {
    let href: string;
    try {
      href = new URL(d.location, baseUrl).toString();
    } catch {
      continue;
    }
    if (!isWithinBook(href, baseUrl)) continue;
    const title = cleanRemoteText(d.title, TOC_TITLE_MAX);
    if (!title) continue;
    const hashAt = d.location.indexOf("#");
    const isSection = hashAt >= 0 && hashAt < d.location.length - 1;
    if (!isSection) {
      pageHasNumbered = false;
      items.push({ title, href, depth: 0 });
      continue;
    }
    const num = NUMBERED_SECTION.exec(title);
    let depth: number;
    if (num) {
      depth = Math.min(2, num[1].split(".").length - 1);
      pageHasNumbered = true;
    } else {
      depth = pageHasNumbered ? 2 : 1;
    }
    items.push({ title, href, depth });
  }
  return items;
}

function titleFromPath(href: string, baseUrl: string): string {
  const rest = decodeURIComponentSafe(new URL(href).pathname.slice(new URL(baseUrl).pathname.length));
  const segments = rest.split("/").filter(Boolean);
  const last = (segments.pop() ?? "").replace(/\.html?$/i, "").replace(/[-_]+/g, " ");
  return cleanRemoteText(last, TOC_TITLE_MAX);
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** sitemap 항목 → 목차(모두 depth 0). 제목은 주소 마지막 부분, 책 첫 페이지는 rootTitle. */
export function tocFromSitemap(entries: SitemapEntry[], baseUrl: string, rootTitle: string): BookTocItem[] {
  const items: BookTocItem[] = [];
  for (const e of entries) {
    let href: string;
    try {
      href = new URL(e.loc).toString();
    } catch {
      continue;
    }
    if (!isWithinBook(href, baseUrl)) continue;
    const rest = new URL(href).pathname.slice(new URL(baseUrl).pathname.length).replace(/index\.html?$/i, "");
    const title = rest === "" ? rootTitle : titleFromPath(href, baseUrl) || rootTitle;
    items.push({ title, href, depth: 0 });
  }
  return items;
}

/** 항목 수 상한. 넘치면 깊은 절부터 뺀다(페이지 목록을 먼저 지킨다). */
export function capToc(items: BookTocItem[], max = TOC_MAX_ITEMS): BookTocItem[] {
  if (items.length <= max) return items;
  for (const keep of [1, 0]) {
    const kept = items.filter((i) => i.depth <= keep);
    if (kept.length <= max) return kept;
  }
  return items.filter((i) => i.depth === 0).slice(0, max);
}

/** 저장 직전 정리: 같은 주소 중복 제거, 주소에 개인정보가 보이면 제외, 제목 마스킹(F-14), 상한 적용. */
export function finalizeToc(items: BookTocItem[], baseUrl: string): BookTocItem[] {
  const seen = new Set<string>();
  const out: BookTocItem[] = [];
  for (const item of items) {
    if (seen.has(item.href) || !isWithinBook(item.href, baseUrl) || item.href.length > 1000) continue;
    if (urlHasPII(item.href)) continue;
    seen.add(item.href);
    const title = maskPII(cutAt(item.title, TOC_TITLE_MAX)).text;
    out.push({ title, href: item.href, depth: Math.max(0, Math.min(2, Math.trunc(item.depth))) });
  }
  return capToc(out);
}

/** <head> 앞부분의 <meta> 태그마다 [name 또는 property(소문자), content]. */
function metaEntries(html: string): [string, string][] {
  const head = html.slice(0, 200_000);
  const out: [string, string][] = [];
  const metaRe = /<meta\b([^>]*)>/gi;
  for (let m = metaRe.exec(head); m; m = metaRe.exec(head)) {
    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (let a = attrRe.exec(m[1]); a; a = attrRe.exec(m[1])) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? "";
    out.push([(attrs.name ?? attrs.property ?? "").toLowerCase(), attrs.content ?? ""]);
  }
  return out;
}

export function parseHtmlMeta(html: string): { title: string; description: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 200_000));
  let description = "";
  let ogDescription = "";
  for (const [key, content] of metaEntries(html)) {
    if (key === "description" && !description) description = content;
    if (key === "og:description" && !ogDescription) ogDescription = content;
  }
  return {
    title: titleMatch ? cleanRemoteText(titleMatch[1], BOOK_TITLE_MAX) : "",
    description: cleanRemoteText(description || ogDescription, BOOK_SUMMARY_MAX),
  };
}

const IMAGE_META_ORDER = ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"];

/** 대표 이미지 후보(og:image 등)를 우선순위대로. 값은 엔티티만 풀고 주소 검사는 하지 않는다. */
export function parseImageMeta(html: string): string[] {
  const entries = metaEntries(html);
  const out: string[] = [];
  for (const wanted of IMAGE_META_ORDER) {
    for (const [key, content] of entries) {
      const value = decodeEntities(content).trim();
      if (key === wanted && value && value.length <= 2000 && !out.includes(value)) out.push(value);
    }
  }
  return out.slice(0, 10);
}

/** 웹북 첫 페이지의 대표 이미지를 표지 후보로 고른다. 허용되는 주소(checkCoverUrl)인 첫 후보, 없으면 null. */
export function coverFromPage(html: string, pageUrl: string, hub: string): string | null {
  for (const candidate of parseImageMeta(html)) {
    let abs: string;
    try {
      abs = new URL(candidate, pageUrl).toString();
    } catch {
      continue;
    }
    const c = checkCoverUrl(abs, hub);
    if (c.ok && c.value) return c.value;
  }
  return null;
}

export interface WebbookPreview {
  baseUrl: string;
  title: string;
  summary: string;
  toc: BookTocItem[];
  pageCount: number;
  lastmod: string | null;
  source: "search_index" | "sitemap" | "page";
  frameBlocked: boolean;
  /** 첫 페이지 og:image에서 고른 표지 후보(없으면 null) */
  coverUrl: string | null;
}

/**
 * 웹북 주소에서 제목·설명·목차를 가져온다(F-43). 첫 페이지 → (sitemap.xml, search/search_index.json) 순서.
 * 목차는 search_index를 우선하고, 없으면 sitemap, 둘 다 없으면 첫 페이지 하나로 만든다.
 */
export async function importWebbook(rawUrl: string, hub: string, options: FetchOptions = {}): Promise<BookResult<WebbookPreview>> {
  const check = checkBookUrl(rawUrl, hub);
  if (!check.ok) return { ok: false, error: check.error };

  const page = await guardedFetchText(check.url.toString(), hub, {
    ...options,
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
  });
  if (!page.ok) return { ok: false, error: `책 주소를 열지 못했습니다. ${page.error}` };
  if (!/html/i.test(page.contentType)) {
    return { ok: false, error: "웹 페이지(HTML) 주소가 아닙니다. 웹북의 첫 페이지 주소를 입력하십시오." };
  }
  const baseUrl = normalizeBaseUrl(page.finalUrl);
  const meta = parseHtmlMeta(page.text);

  const [sitemapRes, indexRes] = await Promise.all([
    guardedFetchText(new URL("sitemap.xml", baseUrl).toString(), hub, { ...options, accept: "application/xml,text/xml;q=0.9,*/*;q=0.5" }),
    guardedFetchText(new URL("search/search_index.json", baseUrl).toString(), hub, { ...options, accept: "application/json,*/*;q=0.5" }),
  ]);

  const warnings: string[] = [];
  let docs: SearchIndexDoc[] | null = null;
  if (indexRes.ok) {
    try {
      docs = parseSearchIndex(JSON.parse(indexRes.text));
    } catch {
      docs = null;
    }
  } else if (indexRes.status !== 404) {
    warnings.push(`검색 색인(search/search_index.json)을 읽지 못했습니다. ${indexRes.error}`);
  }
  const sitemap = sitemapRes.ok ? parseSitemap(sitemapRes.text) : [];

  const rootDoc = docs?.find((d) => {
    try {
      return new URL(d.location, baseUrl).toString() === baseUrl;
    } catch {
      return false;
    }
  });
  const hostTitle = new URL(baseUrl).hostname;
  const title = cleanRemoteText(rootDoc?.title ?? "", BOOK_TITLE_MAX) || meta.title || hostTitle;

  let toc: BookTocItem[] = [];
  let source: WebbookPreview["source"] = "page";
  if (docs && docs.length > 0) {
    toc = finalizeToc(tocFromSearchIndex(docs, baseUrl), baseUrl);
    if (toc.length > 0) source = "search_index";
  }
  if (toc.length === 0 && sitemap.length > 0) {
    toc = finalizeToc(tocFromSitemap(sitemap, baseUrl, title), baseUrl);
    if (toc.length > 0) source = "sitemap";
  }
  if (toc.length === 0) toc = finalizeToc([{ title, href: baseUrl, depth: 0 }], baseUrl);
  if (toc.length === 0) return { ok: false, error: "목차를 만들 수 없는 주소입니다." };
  if (source === "page") warnings.push("sitemap.xml과 검색 색인이 없어 첫 페이지만 목차에 넣었습니다.");

  const lastmods = sitemap
    .filter((e) => e.lastmod && isWithinBook(e.loc, baseUrl))
    .map((e) => e.lastmod as string)
    .sort();
  if (page.frameBlocked) {
    warnings.push("이 사이트는 다른 사이트 안에 표시하는 것을 막아 두었습니다. 리더에서는 '새 창에서 열기'로 읽어야 합니다.");
  }

  const masked = maskFields({ title, summary: meta.description });
  return {
    ok: true,
    value: {
      baseUrl,
      title: masked.values.title,
      summary: masked.values.summary,
      toc,
      pageCount: toc.filter((i) => i.depth === 0).length,
      lastmod: lastmods.length ? lastmods[lastmods.length - 1] : null,
      source,
      frameBlocked: page.frameBlocked,
      coverUrl: coverFromPage(page.text, page.finalUrl, hub),
    },
    warnings,
  };
}

/* ---------- 등록·수정·삭제 ---------- */

export interface BookMetaInput {
  title: string;
  summary: string;
  authorName: string;
  schoolLevel: string;
  license: string;
  visibility: string;
  containsThirdPartyWorks: boolean;
  /**
   * 표지 이미지 주소(선택). undefined = 입력 칸이 없었음(등록: 웹북 og:image를 쓴다, 수정: 바꾸지 않는다),
   * 빈 문자열 = 표지 없음.
   */
  coverUrl?: string;
}

interface BookMeta {
  title: string;
  summary: string;
  authorName: string;
  schoolLevel: LevelOrAll;
  license: string;
  visibility: Book["visibility"];
  containsThirdPartyWorks: boolean;
  /** undefined = 입력하지 않음, null = 표지 없음 */
  coverUrl: string | null | undefined;
  warnings: string[];
  maskedCount: number;
}

function isLicense(v: string): boolean {
  return (BOOK_LICENSES as readonly string[]).includes(v);
}

/**
 * 입력 검증: 길이 확인 → 공백 정리 → 개인정보 마스킹(F-14) → 저작권 게이트(F-45). 제목이 비면 fallbackTitle.
 * hub는 표지 이미지 주소로 이 허브의 사이트 주소를 허용할 때 쓴다(없으면 https 공개 주소만).
 */
export function validateBookMeta(
  input: BookMetaInput,
  user: User,
  fallbackTitle = "",
  hub = "",
): { ok: true; value: BookMeta } | { ok: false; error: string } {
  const rawTitle = input.title.trim();
  const rawSummary = normalizeNewlines(input.summary).trim();
  const rawAuthor = input.authorName.trim();
  if (rawTitle.length > BOOK_TITLE_MAX) return { ok: false, error: `제목은 ${BOOK_TITLE_MAX}자 이하로 입력하십시오.` };
  if (rawSummary.length > BOOK_SUMMARY_MAX) return { ok: false, error: `소개는 ${BOOK_SUMMARY_MAX}자 이하로 입력하십시오.` };
  if (rawAuthor.length > BOOK_AUTHOR_MAX) return { ok: false, error: `저자는 ${BOOK_AUTHOR_MAX}자 이하로 입력하십시오.` };
  const title = rawTitle.replace(/\s+/g, " ") || cutAt(fallbackTitle.trim(), BOOK_TITLE_MAX);
  if (!title) return { ok: false, error: "제목을 입력하십시오." };
  if (!isLevelOrAll(input.schoolLevel)) return { ok: false, error: "학교급을 선택하십시오." };
  if (!isLicense(input.license)) return { ok: false, error: "이용 조건(라이선스)을 목록에서 선택하십시오." };
  if (input.visibility !== "public" && input.visibility !== "teachers") {
    return { ok: false, error: "공개 범위를 선택하십시오." };
  }
  let coverUrl: string | null | undefined;
  if (typeof input.coverUrl === "string") {
    const cover = checkCoverUrl(input.coverUrl, hub);
    if (!cover.ok) return cover;
    coverUrl = cover.value;
  }
  const masked = maskFields({
    title,
    summary: rawSummary,
    authorName: rawAuthor.replace(/\s+/g, " ") || displayName(user),
  });
  const gate = applyCopyrightGate({ containsThirdPartyWorks: input.containsThirdPartyWorks, visibility: input.visibility });
  const warnings: string[] = [];
  if (gate.forced) warnings.push("제3자 저작물이 포함되어 공개 범위를 교사 전용으로 바꾸었습니다.");
  if (masked.count) warnings.push(`개인정보로 보이는 내용 ${masked.count}건을 가려서 저장했습니다.`);
  return {
    ok: true,
    value: {
      title: masked.values.title,
      summary: masked.values.summary,
      authorName: masked.values.authorName,
      schoolLevel: input.schoolLevel,
      license: input.license,
      visibility: gate.visibility,
      containsThirdPartyWorks: input.containsThirdPartyWorks,
      coverUrl,
      warnings,
      maskedCount: masked.count,
    },
  };
}

function newBookRecord(
  meta: BookMeta,
  user: User,
  extra: Pick<Book, "kind" | "baseUrl" | "fileId" | "toc"> & { defaultCoverUrl?: string | null },
): Book {
  const now = nowIso();
  return {
    id: newId("book"),
    title: meta.title,
    summary: meta.summary,
    authorName: meta.authorName,
    ownerUserId: user.id,
    kind: extra.kind,
    baseUrl: extra.baseUrl,
    fileId: extra.fileId,
    coverUrl: meta.coverUrl !== undefined ? meta.coverUrl : (extra.defaultCoverUrl ?? null),
    schoolLevel: meta.schoolLevel,
    license: meta.license,
    visibility: meta.visibility,
    containsThirdPartyWorks: meta.containsThirdPartyWorks,
    toc: extra.toc,
    viewCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function storeNewBook(book: Book, user: User, detail: string): Promise<void> {
  await mutate((db) => {
    ensureUser(db, user);
    db.books.push(book);
    writeAudit(db, user, "book.create", book.id, detail);
  });
}

/** 웹북 등록(F-43). 서버가 목차를 다시 가져와 저장한다(미리보기 결과를 브라우저에서 받지 않는다). */
export async function createWebbook(input: BookMetaInput & { url: string }, user: User, hub: string, options: FetchOptions = {}): Promise<BookResult<Book>> {
  if (!isTeacher(user)) return { ok: false, error: "교사 로그인이 필요합니다." };
  // 네트워크 요청 전에 입력부터 확인한다(제목은 가져온 제목으로 채울 수 있으므로 임시 값으로 검사).
  const pre = validateBookMeta(input, user, "제목", hub);
  if (!pre.ok) return pre;
  const imported = await importWebbook(input.url, hub, options);
  if (!imported.ok) return imported;
  const meta = validateBookMeta(input, user, imported.value.title, hub);
  if (!meta.ok) return meta;
  // 표지 칸을 보내지 않았으면(API 등) 첫 페이지 og:image를 쓴다. 칸을 비워 보냈으면 표지 없음.
  const book = newBookRecord(meta.value, user, {
    kind: "webbook",
    baseUrl: imported.value.baseUrl,
    fileId: null,
    toc: imported.value.toc,
    defaultCoverUrl: imported.value.coverUrl,
  });
  await storeNewBook(book, user, `webbook ${imported.value.baseUrl} 목차 ${book.toc.length}항목`);
  return { ok: true, value: book, warnings: [...meta.value.warnings, ...imported.warnings] };
}

/** 자료실 PDF로 책 만들기(F-44). 파일을 올린 교사 본인 또는 관리자만. */
export async function createPdfBookFromFile(
  input: BookMetaInput & { fileId: string },
  user: User,
  hub = "",
): Promise<BookResult<Book>> {
  if (!isTeacher(user)) return { ok: false, error: "교사 로그인이 필요합니다." };
  const db = await readDb();
  const file = db.files.find((f) => f.id === input.fileId);
  if (!file) return { ok: false, error: "자료실 파일을 찾을 수 없습니다." };
  if (file.authorId !== user.id && user.role !== "admin") {
    return { ok: false, error: "본인이 올린 자료실 파일만 서가에 올릴 수 있습니다." };
  }
  if (!(await storedFileIsPdf(file))) return { ok: false, error: "PDF 파일만 서가에 올릴 수 있습니다." };
  const meta = validateBookMeta(input, user, file.title, hub);
  if (!meta.ok) return meta;
  const book = newBookRecord(meta.value, user, { kind: "pdf", baseUrl: null, fileId: file.id, toc: [] });
  await storeNewBook(book, user, `pdf ${file.id}`);
  return { ok: true, value: book, warnings: meta.value.warnings };
}

/** 새 PDF를 올려 책 만들기(F-44). 파일은 자료실(saveUpload)에 함께 등록된다. */
export async function createPdfBookFromUpload(
  input: BookMetaInput & { file: File },
  user: User,
  hub = "",
): Promise<BookResult<Book>> {
  if (!isTeacher(user)) return { ok: false, error: "교사 로그인이 필요합니다." };
  const { file } = input;
  if (!file || file.size === 0) return { ok: false, error: "올릴 PDF 파일을 선택하십시오." };
  if (!/\.pdf$/i.test(file.name)) return { ok: false, error: "PDF 파일(.pdf)만 올릴 수 있습니다." };
  const fallback = file.name.replace(/\.pdf$/i, "");
  const meta = validateBookMeta(input, user, fallback, hub);
  if (!meta.ok) return meta;
  if (!looksLikePdf(new Uint8Array(await file.slice(0, 1024).arrayBuffer()))) {
    return { ok: false, error: "PDF 형식이 아닌 파일입니다. 실제 PDF 파일을 올리십시오." };
  }
  const saved = await saveUpload(
    { file, title: meta.value.title, description: meta.value.summary, schoolLevel: meta.value.schoolLevel },
    user,
  );
  if (!saved.ok) return { ok: false, error: saved.error };
  const book = newBookRecord(meta.value, user, { kind: "pdf", baseUrl: null, fileId: saved.value.id, toc: [] });
  await storeNewBook(book, user, `pdf ${saved.value.id} (새 업로드)`);
  return { ok: true, value: book, warnings: meta.value.warnings };
}

/** 책 정보 수정. 저작권 게이트를 다시 적용한다. 표지 칸(coverUrl)을 보내지 않으면 표지는 그대로 둔다. */
export async function updateBook(id: string, input: BookMetaInput, user: User, hub = ""): Promise<BookResult<Book>> {
  const meta = validateBookMeta(input, user, "", hub);
  if (!meta.ok) return meta;
  return mutate((db): BookResult<Book> => {
    const book = db.books.find((b) => b.id === id);
    if (!book) return { ok: false, error: "책을 찾을 수 없습니다." };
    if (!canManageBook(book, user)) return { ok: false, error: "책을 등록한 교사나 관리자만 수정할 수 있습니다." };
    book.title = meta.value.title;
    book.summary = meta.value.summary;
    book.authorName = meta.value.authorName;
    book.schoolLevel = meta.value.schoolLevel;
    book.license = meta.value.license;
    book.visibility = meta.value.visibility;
    book.containsThirdPartyWorks = meta.value.containsThirdPartyWorks;
    if (meta.value.coverUrl !== undefined) book.coverUrl = meta.value.coverUrl;
    book.updatedAt = nowIso();
    writeAudit(db, user, "book.update", book.id, meta.value.maskedCount ? `개인정보 ${meta.value.maskedCount}건 마스킹` : "");
    return { ok: true, value: book, warnings: meta.value.warnings };
  });
}

/** 웹북 목차 다시 가져오기. */
export async function refreshWebbookToc(id: string, user: User, hub: string, options: FetchOptions = {}): Promise<BookResult<Book>> {
  const current = await getBook(id);
  if (!current) return { ok: false, error: "책을 찾을 수 없습니다." };
  if (!canManageBook(current, user)) return { ok: false, error: "책을 등록한 교사나 관리자만 목차를 다시 가져올 수 있습니다." };
  if (current.kind !== "webbook" || !current.baseUrl) return { ok: false, error: "웹북만 목차를 다시 가져올 수 있습니다." };
  const imported = await importWebbook(current.baseUrl, hub, options);
  if (!imported.ok) return imported;
  return mutate((db): BookResult<Book> => {
    const book = db.books.find((b) => b.id === id);
    if (!book || !canManageBook(book, user)) return { ok: false, error: "책을 찾을 수 없습니다." };
    book.toc = imported.value.toc;
    book.baseUrl = imported.value.baseUrl;
    book.updatedAt = nowIso();
    writeAudit(db, user, "book.toc.refresh", book.id, `목차 ${book.toc.length}항목`);
    return { ok: true, value: book, warnings: imported.warnings };
  });
}

/** 책 삭제. 자료실 파일은 지우지 않는다(자료실에서 따로 관리). */
export async function deleteBook(id: string, user: User): Promise<BookResult<null>> {
  return mutate((db): BookResult<null> => {
    const idx = db.books.findIndex((b) => b.id === id);
    if (idx < 0) return { ok: false, error: "책을 찾을 수 없습니다." };
    const book = db.books[idx];
    if (!canManageBook(book, user)) return { ok: false, error: "책을 등록한 교사나 관리자만 삭제할 수 있습니다." };
    db.books.splice(idx, 1);
    writeAudit(db, user, "book.delete", id, book.title);
    return { ok: true, value: null, warnings: [] };
  });
}

/** 화면에 iframe·링크로 쓸 주소인지 다시 확인한다(저장값 오염 대비). */
export function safeHttpUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
