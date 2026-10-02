import "server-only";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createApp, validateNewApp } from "./apps";
import {
  clearUploadReceipts,
  hasBlob,
  hasUploadReceipt,
  isSha256,
  putBlob,
  readBlob,
  recordUploadReceipt,
  sha256Hex,
} from "./blobs";
import {
  SECRET_DETECTED_MESSAGE,
  SITE_TEXT_EXT,
  hasSecret,
  isSiteTextPath,
  listPathsHint,
  secretDetectedHint,
  siteSecretGuidance,
} from "../app/studio/sites/secret-scan";
import { DATA_DIR, mutate, newId, nowIso, readDb } from "./db";
import { siteOrigin } from "./origin";
import { maskFields, maskPII, scanPII } from "./pii";
import { ensureDefaultProjectIn } from "./projects";
import { ensureUser, isTeacher, writeAudit } from "./session";
import { normalizeNewlines, urlHasPII } from "./text";
import type {
  ApprovalStatus,
  DB,
  MiniApp,
  NewAppInput,
  PrivacyCheck,
  Project,
  Site,
  SiteDeploy,
  SiteFile,
  User,
} from "./types";

// 허브 정적 호스팅(F-51, F-52). 계약: docs/v0.2-contracts.md 2장.
// - deploy: 파일 목록 → 파일 전송 → 확정(3단계). 확정된 배포는 불변이고, 비공개 미리보기 주소로만 보인다.
// - publish: 셀프점검(F-16)을 거쳐 미니앱(F-04)으로 등록하고 공개 주소가 이 배포를 가리키게 한다.
//   이미 공개한 앱의 새 버전이 학교 내부 승인을 다시 기다려야 하면, 승인될 때까지 공개 주소는 이전 버전을 계속
//   보여 주고 새 버전은 site.pendingDeployId에 둔다(apps.ts approveApp이 승인 때 liveDeployId로 옮긴다).
// - 파일 본문은 blobs.ts(내용 주소 저장소)에, 배포 기록은 db.siteDeploys에 둔다. 저장소는 전역이지만
//   "이미 있으니 안 올려도 된다"는 판단은 그 교사가 전에 올린 적이 있는 내용에만 한다(다른 교사 파일 열람 방지).
// HTTP API(/api/sites/**), 웹 폴더 올리기(/studio/sites), 원격 MCP 도구가 모두 이 파일의 함수를 쓴다.

export const SITE_LIMITS = { totalBytes: 20 * 1024 * 1024, fileCount: 1000, fileBytes: 5 * 1024 * 1024 };
export const SITE_ALLOWED_EXT = ["html","htm","css","js","mjs","json","txt","md","svg","png","jpg","jpeg","gif","webp","ico","avif","woff","woff2","ttf","mp3","mp4","webm","wasm","xml","csv","pdf"];
/** 비밀값·개인정보를 검사하는 텍스트 파일 확장자(secret-scan.ts에서 정의) */
export { SITE_TEXT_EXT };
/** 교사당 사이트 수, 시간당 배포 횟수(벤치마크 1부 3(c)) */
export const SITE_QUOTA = { sitesPerUser: 20, deploysPerHour: 30 };
export const SITE_PATH_MAX = 512;
export const SITE_TITLE_MAX = 80;
const DESCRIPTION_MAX = 2000;
const PRIVACY_TEXT_MAX = 200;
const WARNINGS_MAX = 100;

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
  wasm: "application/wasm",
  xml: "application/xml; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  pdf: "application/pdf",
};

/* ---------- 결과 형식 ---------- */

export type SiteResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string; hint?: string };

export type SiteWarning = { path: string; kind: string; message: string };

export interface SiteSummary {
  id: string;
  slug: string;
  title: string;
  projectId: string;
  liveUrl: string | null;
  previewUrl: string | null;
  appId: string | null;
  approvalStatus: ApprovalStatus | null;
  /**
   * 이미 공개한 앱의 새 버전이 학교 내부 승인을 기다리는 동안 그 새 버전의 미리보기 주소.
   * 이때 공개 주소(liveUrl)는 이전에 공개한 버전을 계속 보여 준다. 그런 버전이 없으면 null.
   */
  pendingPreviewUrl: string | null;
  updatedAt: string;
}

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface DeployManifestInput {
  siteId?: string;
  slug?: string;
  title?: string;
  /**
   * 새 사이트(siteId 없음)를 연결할 프로젝트. 기존 사이트에서는 moveToProject가 true일 때만 쓴다
   * (dandi.json의 projectId는 만들 때의 기본값일 뿐이라, 허브 화면에서 옮긴 프로젝트를 되돌리지 않게).
   */
  projectId?: string;
  /** true면 기존 사이트(와 연결된 미니앱)를 projectId로 옮긴다(CLI --project, 명시적 요청만). */
  moveToProject?: boolean;
  files: ManifestFile[];
}

export type PublishInput = Omit<NewAppInput, "url"> & { deployId?: string };

function fail(status: number, code: string, message: string, hint?: string): { ok: false; status: number; code: string; message: string; hint?: string } {
  return hint ? { ok: false, status, code, message, hint } : { ok: false, status, code, message };
}

/* ---------- 주소 ---------- */

/**
 * 사이트 주소(끝에 / 포함). 허브를 127.0.0.1로 열었어도 사이트는 <label>.localhost로 만든다
 * (<label>.127.0.0.1은 주소가 되지 않는다).
 */
export function siteUrl(hub: string, label: string): string {
  let base = hub;
  try {
    const u = new URL(hub);
    if (u.hostname === "127.0.0.1" || u.hostname === "[::1]") {
      u.hostname = "localhost";
      base = u.origin;
    }
  } catch {
    // 잘못된 허브 주소는 siteOrigin이 그대로 처리한다.
  }
  return `${siteOrigin(base, label)}/`;
}

function previewLabel(site: Site, deploy: SiteDeploy): string {
  return `${site.slug}--${deploy.previewToken}`;
}

/* ---------- 검증 ---------- */

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const RESERVED_SLUGS = new Set([
  "www", "api", "admin", "hub", "mcp", "static", "app", "apps", "assets", "cdn", "mail", "smtp", "ftp",
  "auth", "login", "logout", "oauth", "sso", "account", "dandi", "dandi", "site", "sites", "preview",
  "status", "cli", "device", "connect", "studio", "skills", "books", "files", "localhost", "root", "system",
  "support", "help", "security", "abuse", "postmaster", "webmaster", "hostmaster", "ns1", "ns2", "site-serve",
]);

/** slug 검사. 통과하면 null, 아니면 한국어 오류 문장. 길이를 먼저 본다. */
export function validateSlug(slug: string): string | null {
  if (slug.length < 3 || slug.length > 30 || !SLUG_RE.test(slug)) {
    return "사이트 이름(slug)은 영문 소문자·숫자·하이픈 3~30자이고, 처음과 끝은 영문 소문자나 숫자여야 합니다.";
  }
  if (slug.includes("--")) return "사이트 이름(slug)에 하이픈 두 개(--)를 연달아 쓸 수 없습니다.";
  if (RESERVED_SLUGS.has(slug)) return `예약된 이름이라 쓸 수 없습니다: ${slug}. 다른 이름을 고르십시오.`;
  if (urlHasPII(slug)) return "사이트 이름(slug)에 전화번호 등 개인정보로 보이는 값이 있습니다. 다른 이름을 고르십시오.";
  return null;
}

function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function contentTypeFor(p: string): string | null {
  return CONTENT_TYPES[extOf(p)] ?? null;
}

// 제어 문자(C0, DEL, C1)
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** 사이트 파일 경로를 저장 형식(NFC)으로 바꾼다. 대소문자는 바꾸지 않는다. */
export function normalizeSitePath(p: string): string {
  return p.normalize("NFC");
}

/** 경로 모양 검사(확장자 제외). 통과하면 null. */
function pathShapeError(p: string): string | null {
  if (typeof p !== "string" || p.length === 0) return "파일 경로가 비어 있습니다.";
  if (p.length > SITE_PATH_MAX) return `파일 경로는 ${SITE_PATH_MAX}자 이하여야 합니다.`;
  if (CONTROL_RE.test(p)) return "파일 경로에 제어 문자가 있습니다.";
  if (p.includes("\\")) return "파일 경로에는 역슬래시(\\) 대신 슬래시(/)를 쓰십시오.";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "파일 경로는 사이트 폴더 기준 상대 경로여야 합니다.";
  for (const seg of p.split("/")) {
    if (seg === "") return "파일 경로에 빈 폴더 이름(//)이 있습니다.";
    if (seg === "." || seg === "..") return "파일 경로에 . 이나 .. 을 쓸 수 없습니다.";
    if (seg.startsWith(".")) return "점(.)으로 시작하는 파일·폴더(.env, .git 등)는 올릴 수 없습니다.";
  }
  return null;
}

export function isAllowedSiteExt(p: string): boolean {
  return SITE_ALLOWED_EXT.includes(extOf(p));
}

/**
 * 업로드 경로 검사(계약 2-2). 슬래시로 나눈 상대 경로만 허용한다.
 * `..`·절대경로·역슬래시·제어 문자·빈 세그먼트·점으로 시작하는 세그먼트(.env, .git 등)·허용 목록 밖 확장자는 거부한다.
 */
export function validateSitePath(p: string): string | null {
  return pathShapeError(p) ?? (isAllowedSiteExt(p) ? null : "허용되지 않는 파일 형식입니다.");
}

/** 오류 hint의 경로 목록(웹 폴더 올리기의 사전 검사와 같은 형식) */
const listHint = listPathsHint;

type CheckedManifest = { files: ManifestFile[]; totalBytes: number };

/** 파일 목록 검사: 개수 → 경로·형식·크기·해시 → 중복 → 합계 → 루트 index.html 순서. */
function checkManifest(files: unknown): SiteResult<CheckedManifest> {
  if (!Array.isArray(files) || files.length === 0) {
    return fail(400, "invalid_request", "올릴 파일 목록(files)이 비어 있습니다.", "사이트 폴더에 index.html이 있는지 확인하십시오.");
  }
  if (files.length > SITE_LIMITS.fileCount) {
    return fail(413, "too_many_files", `파일은 한 번에 ${SITE_LIMITS.fileCount}개까지 올릴 수 있습니다(요청 ${files.length}개).`, "node_modules·원본 소스 폴더 대신 빌드 결과 폴더만 올리십시오.");
  }
  const out: ManifestFile[] = [];
  const seen = new Set<string>();
  const badType: string[] = [];
  let totalBytes = 0;
  for (const raw of files) {
    const f = raw as Partial<ManifestFile> | null;
    if (!f || typeof f !== "object" || typeof f.path !== "string") {
      return fail(400, "invalid_request", "파일 목록의 각 항목에는 path, size, sha256이 있어야 합니다.");
    }
    if (f.path.length > SITE_PATH_MAX) {
      return fail(422, "invalid_path", `파일 경로는 ${SITE_PATH_MAX}자 이하여야 합니다.`, listHint("문제 경로: ", [f.path]));
    }
    const p = normalizeSitePath(f.path);
    const pathError = pathShapeError(p);
    if (pathError) return fail(422, "invalid_path", pathError, listHint("문제 경로: ", [p]));
    if (!isAllowedSiteExt(p)) {
      badType.push(p);
      continue;
    }
    if (typeof f.size !== "number" || !Number.isInteger(f.size) || f.size < 0) {
      return fail(400, "invalid_request", "파일 크기(size)는 0 이상의 정수여야 합니다.", listHint("문제 경로: ", [p]));
    }
    if (f.size > SITE_LIMITS.fileBytes) {
      return fail(413, "file_too_large", `파일 하나는 ${SITE_LIMITS.fileBytes / 1024 / 1024}MB까지 올릴 수 있습니다.`, listHint("큰 파일: ", [p]));
    }
    const hash = typeof f.sha256 === "string" ? f.sha256.toLowerCase() : "";
    if (!isSha256(hash)) {
      return fail(400, "invalid_request", "sha256은 64자리 16진수여야 합니다.", listHint("문제 경로: ", [p]));
    }
    if (seen.has(p)) return fail(422, "duplicate_path", "같은 경로의 파일이 두 번 들어 있습니다.", listHint("중복 경로: ", [p]));
    seen.add(p);
    totalBytes += f.size;
    out.push({ path: p, size: f.size, sha256: hash });
  }
  if (badType.length > 0) {
    return fail(
      422,
      "file_type_not_allowed",
      "허용되지 않는 형식의 파일이 있습니다.",
      `${listHint("해당 파일: ", badType)}. 허용 확장자: ${SITE_ALLOWED_EXT.join(", ")}. 해당 파일을 빼고 다시 올리십시오.`,
    );
  }
  if (totalBytes > SITE_LIMITS.totalBytes) {
    return fail(413, "site_too_large", `사이트 전체 크기는 ${SITE_LIMITS.totalBytes / 1024 / 1024}MB까지입니다.`, "큰 동영상·이미지는 줄이거나 외부 저장소 링크로 바꾸십시오.");
  }
  if (!seen.has("index.html")) {
    return fail(422, "missing_index", "사이트 폴더 맨 위에 index.html이 있어야 합니다.", "빌드 결과 폴더(dist, build, out 등)를 올렸는지 확인하십시오.");
  }
  return { ok: true, value: { files: out, totalBytes } };
}

/* ---------- 비밀값·개인정보 검사 ---------- */

// 비밀값 규칙(계약 2-2 + sk-proj-/sk-ant- 새 형식)과 안내 문장은 웹 폴더 올리기와 함께 쓰는 secret-scan.ts에 있다.
export { hasSecret, siteSecretGuidance };

const decoder = new TextDecoder("utf-8", { fatal: false });

function piiWarnings(p: string, text: string, where: "content" | "path"): SiteWarning[] {
  const counts = new Map<string, { label: string; n: number }>();
  for (const m of scanPII(text)) {
    const c = counts.get(m.type) ?? { label: m.label, n: 0 };
    c.n += 1;
    counts.set(m.type, c);
  }
  return [...counts].map(([kind, c]) => ({
    path: p,
    kind,
    message:
      where === "path"
        ? `파일 이름에 ${c.label}로 보이는 값이 있습니다. 실제 개인정보라면 파일 이름을 바꿔 다시 올리십시오.`
        : `${c.label}로 보이는 값이 ${c.n}곳 있습니다. 실제 학생·교사의 개인정보라면 지운 뒤 다시 올리십시오.`,
  }));
}

/** 확정 전 검사: 비밀값이 있는 텍스트 파일 경로와 개인정보 경고. 같은 내용(해시)은 한 번만 읽는다. */
async function scanDeployFiles(files: SiteFile[]): Promise<{ secretPaths: string[]; warnings: SiteWarning[] }> {
  const secretPaths: string[] = [];
  const warnings: SiteWarning[] = [];
  const byHash = new Map<string, { secret: boolean; text: string | null }>();
  for (const f of files) {
    warnings.push(...piiWarnings(f.path, f.path, "path"));
    if (!isSiteTextPath(f.path)) continue;
    let scanned = byHash.get(f.sha256);
    if (!scanned) {
      const bytes = await readBlob(f.sha256);
      const text = bytes ? decoder.decode(bytes) : null;
      scanned = { secret: text !== null && hasSecret(text), text };
      byHash.set(f.sha256, scanned);
    }
    if (scanned.secret) secretPaths.push(f.path);
    else if (scanned.text && warnings.length < WARNINGS_MAX) warnings.push(...piiWarnings(f.path, scanned.text, "content"));
  }
  return { secretPaths, warnings: warnings.slice(0, WARNINGS_MAX) };
}

/* ---------- 배포 3단계 ---------- */

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 소문자·숫자 무작위 문자열. 36의 배수를 넘는 바이트는 버려 치우침이 없게 한다. */
function randomToken(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 252 && out.length < length) out += TOKEN_ALPHABET[b % 36];
    }
  }
  return out;
}

function ownSite(db: DB, user: User, siteId: string): Site | null {
  return db.sites.find((s) => s.id === siteId && s.ownerUserId === user.id) ?? null;
}

function ownDeploy(db: DB, user: User, deployId: string): { site: Site; deploy: SiteDeploy } | null {
  const deploy = db.siteDeploys.find((d) => d.id === deployId);
  if (!deploy) return null;
  const site = ownSite(db, user, deploy.siteId);
  return site ? { site, deploy } : null;
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** 사이트를 연결할 수 있는 프로젝트: 본인 소유의 활성 프로젝트만. */
function activeOwnProject(db: DB, user: User, projectId: string): Project | null {
  return db.projects.find((p) => p.id === projectId && p.ownerUserId === user.id && p.status === "active") ?? null;
}

/** 사이트(와 연결된 미니앱)를 다른 프로젝트로 옮기고 감사 로그를 남긴다. mutate 안에서 부른다. */
function moveSiteIn(db: DB, user: User, site: Site, projectId: string): void {
  const from = site.projectId;
  site.projectId = projectId;
  site.updatedAt = nowIso();
  const app = site.appId ? db.apps.find((a) => a.id === site.appId) : undefined;
  if (app) app.projectId = projectId;
  writeAudit(db, user, "site.project.move", site.id, `${site.slug}: ${from} → ${projectId}`);
}

/**
 * 이 교사가 실제로 본문을 올린 적이 있는 내용(해시). 본인의 확정된(ready) 배포와 본인이 게시한 스킬 버전의 파일만 센다.
 * 확정되지 않은 배포는 목록만 보내고 본문은 안 보냈을 수 있으므로 넣지 않는다.
 * 전역 저장소에 같은 해시가 있어도 여기에 없으면 다시 올려야 한다(다른 교사의 비공개 파일 존재 확인·열람 방지).
 */
function provenHashes(db: DB, user: User): Set<string> {
  const out = new Set<string>();
  for (const d of db.siteDeploys) {
    if (d.createdByUserId !== user.id || d.status !== "ready") continue;
    for (const f of d.files) out.add(f.sha256);
  }
  for (const s of db.skills ?? []) {
    if (s.authorId !== user.id) continue;
    for (const v of s.versions ?? []) for (const f of v.files ?? []) out.add(f.sha256);
  }
  return out;
}

/**
 * 1단계: 파일 목록을 받아 배포(uploading)를 만들고, 올려야 할 파일 경로를 돌려준다.
 * 이 교사가 전에 올린 적이 없는 내용은 서버에 같은 내용이 있어도 모두 올려야 한다(upload에 넣는다).
 * siteId가 없으면 새 사이트를 만든다(slug 지정 가능, projectId가 없으면 교사의 기본 프로젝트).
 * moveToProject: true는 "교사가 이 프로젝트를 직접 골랐다"는 뜻이다(CLI --project, 웹 폴더 올리기의 프로젝트 선택).
 * - 기존 사이트: moveToProject가 true일 때만 옮긴다(본인 활성 프로젝트가 아니면 404 project_not_found). 그 밖에는
 *   요청의 projectId가 달라도(허브 화면에서 옮긴 뒤 남은 dandi.json 값 등) 무시하고 응답에 현재 projectId를 돌려준다.
 * - 새 사이트: projectId를 쓸 수 없으면 moveToProject일 때만 404, 아니면 기본 프로젝트에 연결하고 projectNotice를 준다.
 * 오래된 projectId 때문에 409로 막는 일은 없다(QA R6).
 */
export async function createDeploy(
  user: User,
  input: DeployManifestInput,
): Promise<
  SiteResult<{
    deployId: string;
    siteId: string;
    slug: string;
    /** 사이트의 현재 프로젝트(CLI가 dandi.json에 다시 적는다) */
    projectId: string;
    /** 이번 요청(moveToProject)으로 기존 사이트를 다른 프로젝트로 옮겼는가 */
    projectMoved: boolean;
    /** 새 사이트에 요청한 projectId를 쓸 수 없어 기본 프로젝트에 연결했을 때의 안내 */
    projectNotice?: string;
    upload: string[];
  }>
> {
  if (!isTeacher(user)) return fail(403, "forbidden", "교사·관리자 계정만 사이트를 올릴 수 있습니다.");
  const checked = checkManifest(input?.files);
  if (!checked.ok) return checked;
  const { files, totalBytes } = checked.value;

  const siteId = optionalString(input.siteId);
  const slugIn = optionalString(input.slug)?.toLowerCase();
  const projectIdIn = optionalString(input.projectId);
  const moveToProject = input.moveToProject === true;
  if (siteId && moveToProject && !projectIdIn) {
    return fail(400, "invalid_request", "moveToProject를 쓰려면 옮길 projectId를 함께 보내야 합니다.", "내 프로젝트 id는 허브의 /studio/projects에서 확인하십시오.");
  }
  let title: string | undefined;
  if (input.title !== undefined && input.title !== null) {
    if (typeof input.title !== "string") return fail(400, "invalid_request", "title은 문자열이어야 합니다.");
    const t = input.title.trim();
    if (t.length > SITE_TITLE_MAX) return fail(422, "invalid_title", `사이트 제목은 ${SITE_TITLE_MAX}자 이하로 입력하십시오.`);
    if (t) title = maskPII(t).text;
  }
  if (!siteId && slugIn !== undefined) {
    const slugError = validateSlug(slugIn);
    if (slugError) return fail(422, "invalid_slug", slugError);
  }

  const now = nowIso();
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const siteFiles: SiteFile[] = files.map((f) => ({
    path: f.path,
    size: f.size,
    sha256: f.sha256,
    contentType: contentTypeFor(f.path) ?? "application/octet-stream",
  }));

  const created = await mutate((
    db,
  ): SiteResult<{ site: Site; deploy: SiteDeploy; projectMoved: boolean; projectNotice?: string; upload: string[] }> => {
    const recent = db.siteDeploys.filter((d) => d.createdByUserId === user.id && d.createdAt > hourAgo).length;
    if (recent >= SITE_QUOTA.deploysPerHour) {
      return fail(429, "rate_limited", `배포는 한 시간에 ${SITE_QUOTA.deploysPerHour}번까지 할 수 있습니다.`, "잠시 뒤 다시 시도하십시오.");
    }
    let site: Site;
    let projectMoved = false;
    let projectNotice: string | undefined;
    if (siteId) {
      const found = ownSite(db, user, siteId);
      if (!found) return fail(404, "site_not_found", "사이트를 찾을 수 없습니다.", "siteId를 확인하거나, siteId 없이 올려 새 사이트를 만드십시오.");
      // F-31(QA R6): 기존 사이트는 명시적으로 요청했을 때(moveToProject)만 옮긴다. 요청의 projectId가 달라도
      // (허브 화면에서 옮긴 뒤 남은 dandi.json 값, 보관한 프로젝트 등) 무시하고 현재 프로젝트를 돌려준다.
      if (moveToProject && projectIdIn && projectIdIn !== found.projectId) {
        if (!activeOwnProject(db, user, projectIdIn)) {
          return fail(
            404,
            "project_not_found",
            "옮길 프로젝트를 찾을 수 없습니다. 내 활성 프로젝트만 고를 수 있습니다.",
            `이 사이트는 지금 프로젝트 ${found.projectId}에 연결되어 있습니다. 내 활성 프로젝트 id는 허브의 /studio/projects에서 확인하십시오.`,
          );
        }
        moveSiteIn(db, user, found, projectIdIn);
        projectMoved = true;
      }
      site = found;
      if (title) site.title = title;
    } else {
      if (db.sites.filter((s) => s.ownerUserId === user.id).length >= SITE_QUOTA.sitesPerUser) {
        return fail(429, "site_limit", `사이트는 교사 한 명당 ${SITE_QUOTA.sitesPerUser}개까지 만들 수 있습니다.`, "기존 사이트에 새 버전을 올리십시오(--site <siteId>). 쓰지 않는 사이트는 허브의 /studio/sites에서 지울 수 있습니다.");
      }
      // 새 사이트의 projectId는 기본값이다. 교사가 직접 고른 값(moveToProject: CLI --project, 웹 선택)이 내 활성 프로젝트가
      // 아니면 404로 알리고, dandi.json에 남은 값(보관한 프로젝트, 다른 계정의 프로젝트 등)이면 기본 프로젝트에 연결한다.
      const requestedOk = projectIdIn ? Boolean(activeOwnProject(db, user, projectIdIn)) : false;
      if (projectIdIn && !requestedOk && moveToProject) {
        return fail(404, "project_not_found", "프로젝트를 찾을 수 없습니다.", "내 프로젝트 id를 확인하거나 projectId를 빼고 다시 올리십시오.");
      }
      let slug = slugIn;
      if (slug) {
        if (db.sites.some((s) => s.slug === slug)) {
          return fail(409, "slug_taken", "이미 쓰고 있는 사이트 이름(slug)입니다.", "다른 slug를 고르거나 slug를 빼고 올리면 무작위 이름을 붙입니다.");
        }
      } else {
        do slug = `site-${randomToken(6)}`;
        while (db.sites.some((s) => s.slug === slug));
      }
      // projectId가 없거나 쓸 수 없으면 교사의 기본 프로젝트(없으면 이 저장에서 함께 만든다).
      const projectId = projectIdIn && requestedOk ? projectIdIn : ensureDefaultProjectIn(db, user).id;
      if (projectIdIn && !requestedOk) {
        projectNotice =
          "요청한 projectId는 내 활성 프로젝트가 아니어서 기본 프로젝트에 연결했습니다. 응답의 projectId가 이 사이트의 프로젝트입니다.";
      }
      ensureUser(db, user);
      site = {
        id: newId("site"),
        slug,
        projectId,
        ownerUserId: user.id,
        title: title ?? slug,
        liveDeployId: null,
        pendingDeployId: null,
        appId: null,
        createdAt: now,
        updatedAt: now,
      };
      db.sites.push(site);
      writeAudit(db, user, "site.create", site.id, slug);
    }
    const deploy: SiteDeploy = {
      id: newId("dep"),
      siteId: site.id,
      previewToken: randomToken(10),
      status: "uploading",
      files: siteFiles,
      totalBytes,
      createdByUserId: user.id,
      createdAt: now,
      finalizedAt: null,
    };
    db.siteDeploys.push(deploy);
    site.updatedAt = now;

    // 이 교사가 전에 올린 적이 있는 내용만 건너뛴다. 전역 저장소에 있는지는 보지 않는다(존재 여부를 알려 주지 않으려고).
    // 같은 내용이 여러 경로에 있으면 경로 하나만 알려 준다.
    const proven = provenHashes(db, user);
    const asked = new Set<string>();
    const upload: string[] = [];
    for (const f of files) {
      if (proven.has(f.sha256) || asked.has(f.sha256)) continue;
      asked.add(f.sha256);
      upload.push(f.path);
    }
    return { ok: true, value: { site, deploy, projectMoved, projectNotice, upload } };
  });
  if (!created.ok) return created;
  invalidateSiteServeCache();
  const { site, deploy, projectMoved, projectNotice, upload } = created.value;
  return {
    ok: true,
    value: {
      deployId: deploy.id,
      siteId: site.id,
      slug: site.slug,
      projectId: site.projectId,
      projectMoved,
      ...(projectNotice ? { projectNotice } : {}),
      upload,
    },
  };
}

/**
 * 2단계: 파일 본문 하나를 받는다. 크기와 sha256이 목록과 같아야 저장하고, 이 배포가 그 내용을 받았다고 영수증을 남긴다.
 * 저장소에 같은 내용이 이미 있었는지는 돌려주지 않는다.
 */
export async function uploadDeployFile(
  user: User,
  deployId: string,
  filePath: string,
  bytes: Uint8Array,
): Promise<SiteResult<{ path: string }>> {
  const db = await readDb();
  const owned = ownDeploy(db, user, deployId);
  if (!owned) return fail(404, "deploy_not_found", "배포를 찾을 수 없습니다.");
  if (owned.deploy.status !== "uploading") {
    return fail(409, "deploy_finalized", "이미 확정된 배포입니다.", "새 배포를 만들어 다시 올리십시오.");
  }
  const p = normalizeSitePath(filePath);
  const file = owned.deploy.files.find((f) => f.path === p);
  if (!file) return fail(400, "unknown_path", "배포 파일 목록에 없는 경로입니다.", listHint("요청 경로: ", [p]));
  if (bytes.byteLength !== file.size) {
    return fail(400, "hash_mismatch", "파일 크기가 목록과 다릅니다.", listHint("다시 계산해 올리십시오: ", [p]));
  }
  const put = await putBlob(bytes, { sha256: file.sha256, size: file.size });
  if (!put.ok) return fail(400, "hash_mismatch", "파일 내용의 sha256이 목록과 다릅니다.", listHint("다시 계산해 올리십시오: ", [p]));
  await recordUploadReceipt(owned.deploy.id, file.sha256);
  return { ok: true, value: { path: p } };
}

type FinalizeValue = {
  siteId: string;
  deployId: string;
  slug: string;
  projectId: string;
  previewUrl: string;
  status: "preview";
  warnings: SiteWarning[];
};

/**
 * 3단계: 빠진 파일·비밀값을 검사하고 배포를 확정(ready)한다. 이미 확정된 배포는 같은 결과를 다시 돌려준다.
 * 파일은 이 배포로 본문을 받았거나(영수증) 이 교사가 전에 올린 적이 있는 내용일 때만 있는 것으로 본다.
 */
export async function finalizeDeploy(user: User, deployId: string, hub: string): Promise<SiteResult<FinalizeValue>> {
  const db = await readDb();
  const owned = ownDeploy(db, user, deployId);
  if (!owned) return fail(404, "deploy_not_found", "배포를 찾을 수 없습니다.");
  const { deploy } = owned;

  const proven = provenHashes(db, user);
  const hashes = [...new Set(deploy.files.map((f) => f.sha256))];
  const held = await Promise.all(
    hashes.map(async (h) => (proven.has(h) || (await hasUploadReceipt(deploy.id, h))) && (await hasBlob(h))),
  );
  const missingHashes = new Set(hashes.filter((_, i) => !held[i]));
  const missing = deploy.files.filter((f) => missingHashes.has(f.sha256)).map((f) => f.path);
  if (missing.length > 0) {
    return fail(409, "missing_files", `아직 올리지 않은 파일이 ${missing.length}개 있습니다.`, listHint("빠진 파일: ", missing, 20));
  }

  const { secretPaths, warnings } = await scanDeployFiles(deploy.files);
  if (secretPaths.length > 0) {
    // QA R8: hint는 경로 목록과 공통 안내(정적 호스팅이라 키를 둘 곳이 없다)를 함께 담는다. CLI는 덧붙이지 않는다.
    return fail(422, "secret_detected", SECRET_DETECTED_MESSAGE, secretDetectedHint(secretPaths, hub));
  }

  const done = await mutate((db2): SiteResult<{ site: Site; deploy: SiteDeploy }> => {
    const again = ownDeploy(db2, user, deployId);
    if (!again) return fail(404, "deploy_not_found", "배포를 찾을 수 없습니다.");
    if (again.deploy.status === "uploading") {
      const now = nowIso();
      again.deploy.status = "ready";
      again.deploy.finalizedAt = now;
      again.site.updatedAt = now;
      writeAudit(db2, user, "site.deploy", again.deploy.id, `${again.site.slug} · 파일 ${again.deploy.files.length}개`);
    }
    return { ok: true, value: again };
  });
  if (!done.ok) return done;
  invalidateSiteServeCache();
  // 확정된 배포의 내용은 이제 이 교사가 올린 내용으로 센다(provenHashes). 영수증은 더 필요 없다.
  await clearUploadReceipts(deploy.id).catch(() => undefined);
  const { site } = done.value;
  return {
    ok: true,
    value: {
      siteId: site.id,
      deployId: done.value.deploy.id,
      slug: site.slug,
      projectId: site.projectId,
      previewUrl: siteUrl(hub, previewLabel(site, done.value.deploy)),
      status: "preview",
      warnings,
    },
  };
}

/**
 * 세 단계를 한 번에 실행한다(원격 MCP 도구, 웹 화면용). 파일 본문을 직접 받는다.
 */
export async function deploySiteFiles(
  user: User,
  input: {
    siteId?: string;
    slug?: string;
    title?: string;
    /** 새 사이트를 연결할 프로젝트. 기존 사이트는 moveToProject가 true일 때만 옮긴다(createDeploy와 같다). */
    projectId?: string;
    moveToProject?: boolean;
    files: { path: string; bytes: Uint8Array }[];
  },
  hub: string,
): Promise<
  SiteResult<{ siteId: string; deployId: string; slug: string; projectId: string; previewUrl: string; warnings: SiteWarning[] }>
> {
  if (!Array.isArray(input?.files)) return fail(400, "invalid_request", "올릴 파일 목록(files)이 없습니다.");
  // 해시를 계산하기 전에 개수·합계부터 본다(아주 큰 입력으로 서버를 붙잡지 못하게).
  if (input.files.length > SITE_LIMITS.fileCount) {
    return fail(413, "too_many_files", `파일은 한 번에 ${SITE_LIMITS.fileCount}개까지 올릴 수 있습니다(요청 ${input.files.length}개).`);
  }
  let sum = 0;
  for (const f of input.files) {
    if (!f || typeof f.path !== "string" || !(f.bytes instanceof Uint8Array)) {
      return fail(400, "invalid_request", "파일 목록의 각 항목에는 path와 bytes가 있어야 합니다.");
    }
    sum += f.bytes.byteLength;
  }
  if (sum > SITE_LIMITS.totalBytes) {
    return fail(413, "site_too_large", `사이트 전체 크기는 ${SITE_LIMITS.totalBytes / 1024 / 1024}MB까지입니다.`);
  }

  const byPath = new Map<string, Uint8Array>();
  const manifest: ManifestFile[] = input.files.map((f) => {
    const p = normalizeSitePath(f.path);
    byPath.set(p, f.bytes);
    return { path: p, size: f.bytes.byteLength, sha256: sha256Hex(f.bytes) };
  });
  const created = await createDeploy(user, {
    siteId: input.siteId,
    slug: input.slug,
    title: input.title,
    projectId: input.projectId,
    moveToProject: input.moveToProject === true,
    files: manifest,
  });
  if (!created.ok) return created;
  for (const p of created.value.upload) {
    const bytes = byPath.get(p);
    if (!bytes) return fail(500, "internal_error", "파일을 찾지 못했습니다.");
    const up = await uploadDeployFile(user, created.value.deployId, p, bytes);
    if (!up.ok) return up;
  }
  const fin = await finalizeDeploy(user, created.value.deployId, hub);
  if (!fin.ok) return fin;
  const { siteId, deployId, slug, projectId, previewUrl, warnings } = fin.value;
  return { ok: true, value: { siteId, deployId, slug, projectId, previewUrl, warnings } };
}

/* ---------- publish ---------- */

const g = globalThis as unknown as { __dandiSitePublishLocks?: Map<string, Promise<unknown>> };

/** 같은 사이트의 publish를 차례로 실행한다(동시에 두 번 눌러 미니앱이 두 개 생기지 않게). */
function withSiteLock<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
  const locks = (g.__dandiSitePublishLocks ??= new Map());
  const prev = locks.get(siteId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  locks.set(siteId, tail);
  void tail.then(() => {
    if (locks.get(siteId) === tail) locks.delete(siteId);
  });
  return next;
}

/** publish 입력을 실행 시점에 검사한다(HTTP·MCP에서 형식이 틀린 값이 올 수 있다). 길이를 먼저 본다. */
function checkPublishInput(input: unknown, liveUrl: string): SiteResult<NewAppInput> {
  const bad = (message: string) =>
    fail(422, "invalid_publish", message, "셀프점검 5문항은 교사에게 직접 물어 답을 받은 뒤 다시 요청하십시오.");
  if (!input || typeof input !== "object") return bad("publish 입력이 없습니다.");
  const i = input as Record<string, unknown>;
  const pc = (i.privacyCheck && typeof i.privacyCheck === "object" ? i.privacyCheck : {}) as Record<string, unknown>;
  const title = typeof i.title === "string" ? i.title : "";
  const description = typeof i.description === "string" ? normalizeNewlines(i.description) : "";
  const storageLocation = typeof pc.storageLocation === "string" ? pc.storageLocation : "";
  const retention = typeof pc.retention === "string" ? pc.retention : "";
  if (title.length > SITE_TITLE_MAX) return bad(`앱 이름은 ${SITE_TITLE_MAX}자 이하로 입력하십시오.`);
  if (description.length > DESCRIPTION_MAX) return bad(`설명은 ${DESCRIPTION_MAX}자 이하로 입력하십시오.`);
  if (storageLocation.length > PRIVACY_TEXT_MAX || retention.length > PRIVACY_TEXT_MAX) {
    return bad(`셀프점검: 저장 위치와 보관 기간은 ${PRIVACY_TEXT_MAX}자 이하로 입력하십시오.`);
  }
  if (typeof pc.collectsStudentData !== "boolean") return bad("셀프점검: 학생 개인정보 수집·처리 여부를 선택하십시오.");
  if (typeof pc.externalTransfer !== "boolean") return bad("셀프점검: 외부 전송 여부를 선택하십시오.");
  if (typeof pc.needsSchoolApproval !== "boolean") return bad("셀프점검: 학교 내부 승인 필요 여부를 선택하십시오.");
  if (!Array.isArray(i.schoolLevels) || !i.schoolLevels.every((l) => typeof l === "string")) {
    return bad("학교급을 하나 이상 선택하십시오.");
  }
  const app: NewAppInput = {
    title,
    description,
    url: liveUrl,
    schoolLevels: i.schoolLevels as NewAppInput["schoolLevels"],
    category: (typeof i.category === "string" ? i.category : "") as NewAppInput["category"],
    privacyCheck: {
      collectsStudentData: pc.collectsStudentData,
      storageLocation,
      retention,
      externalTransfer: pc.externalTransfer,
      needsSchoolApproval: pc.needsSchoolApproval,
    },
  };
  const error = validateNewApp(app);
  if (error) return bad(error);
  return { ok: true, value: app };
}

type PrivacyAnswers = Omit<PrivacyCheck, "checkedAt">;

function samePrivacyAnswers(a: PrivacyAnswers, b: PrivacyAnswers): boolean {
  return (
    a.collectsStudentData === b.collectsStudentData &&
    a.storageLocation === b.storageLocation &&
    a.retention === b.retention &&
    a.externalTransfer === b.externalTransfer &&
    a.needsSchoolApproval === b.needsSchoolApproval
  );
}

/**
 * 이미 등록된 미니앱의 소개·셀프점검 내용을 새 입력으로 바꾼다(createApp과 같은 마스킹·정규화).
 * 승인 상태는 바꾸지 않는다(publishSite가 정한다). 마스킹한 개수를 돌려준다.
 */
function applyAppInput(app: MiniApp, input: NewAppInput): number {
  const masked = maskFields({
    title: input.title.trim(),
    description: normalizeNewlines(input.description).trim(),
    storageLocation: input.privacyCheck.storageLocation.trim(),
    retention: input.privacyCheck.retention.trim(),
  });
  app.title = masked.values.title;
  app.description = masked.values.description;
  app.url = input.url.trim();
  app.schoolLevels = [...new Set(input.schoolLevels)];
  app.category = input.category;
  app.handlesPersonalData = input.privacyCheck.collectsStudentData;
  app.privacyCheck = {
    collectsStudentData: input.privacyCheck.collectsStudentData,
    storageLocation: masked.values.storageLocation,
    retention: masked.values.retention,
    externalTransfer: input.privacyCheck.externalTransfer,
    needsSchoolApproval: input.privacyCheck.needsSchoolApproval,
    checkedAt: nowIso(),
  };
  return masked.count;
}

/**
 * publish 결과 공개 주소가 어떻게 되는지.
 * - public: 승인이 필요 없어 공개 주소가 바로 이 버전을 보여 준다.
 * - approval_kept: 승인받은 셀프점검 답과 같아 승인 완료를 유지하고 공개 주소가 바로 이 버전을 보여 준다.
 * - kept_previous: 새 버전이 승인 대기. 승인될 때까지 공개 주소는 이전에 공개한 버전을 계속 보여 준다.
 * - awaiting_approval: 공개된 적 없는 앱이 승인 대기. 승인될 때까지 공개 주소는 승인 대기 안내를 보여 준다.
 */
type PublishOutcome = "public" | "approval_kept" | "kept_previous" | "awaiting_approval";

export type SiteLiveVersion = "updated" | "kept_until_approval";

export type PublishValue = {
  appId: string;
  appUrl: string;
  liveUrl: string;
  /** 이번에 등록한 버전의 미리보기 주소(승인 대기 중에도 작성자가 볼 수 있다) */
  previewUrl: string;
  /**
   * 미니앱의 승인 상태(/api/sites의 approvalStatus와 같다).
   * not_required: 승인이 필요 없다 / pending: 학교 내부 승인 대기 /
   * approved: 이미 승인받은 앱을 같은 셀프점검 답으로 다시 등록해 승인 완료를 유지했다(다시 승인받지 않았다).
   */
  approvalStatus: "approved" | "not_required" | "pending";
  /**
   * updated: 공개 주소가 지금 이 버전을 보여 준다 / kept_until_approval: 학교 내부 승인 뒤에야 이 버전이 공개된다
   * (이미 공개한 앱이면 그동안 공개 주소는 이전에 공개한 버전을, 처음 등록한 앱이면 승인 대기 안내를 보여 준다).
   */
  liveVersion: SiteLiveVersion;
  /** 교사에게 그대로 보여 줄 한국어 안내 */
  message: string;
};

const APPROVE_WHERE = "승인을 받은 뒤 허브의 /studio/apps 또는 사이트 관리 화면에서 내부 승인 완료를 표시하십시오.";

function publishMessage(outcome: PublishOutcome, republish: boolean, previouslyApproved: boolean): string {
  switch (outcome) {
    case "public":
      return republish
        ? "허브 등록 정보를 고치고 공개 주소를 새 버전으로 바꿨습니다."
        : "허브에 미니앱으로 등록했습니다. 공개 주소가 이 버전을 보여 줍니다.";
    case "approval_kept":
      return (
        "셀프점검 답이 학교 내부 승인을 받을 때와 같아 다시 승인받지 않고 승인 완료 상태를 유지했습니다. " +
        "공개 주소를 새 버전으로 바꿨으므로 새 버전이 바로 공개됩니다. " +
        "새 버전의 내용이 승인받을 때와 크게 달라졌다면 학교 절차에 따라 다시 확인받으십시오."
      );
    case "kept_previous":
      return (
        (previouslyApproved
          ? "셀프점검 답이 승인받을 때와 달라져 새 버전은 학교 내부 승인을 다시 받아야 합니다. "
          : "학교 내부 승인이 필요하다고 답했으므로 새 버전은 승인 대기 상태입니다. ") +
        "승인 완료를 표시할 때까지 공개 주소는 이전에 공개한 버전을 계속 보여 주고, 표시하면 새 버전으로 바뀝니다. " +
        "승인 대기 동안 이 앱은 허브 목록에서 빠지고, 허브 앱 화면은 작성자와 관리자만 볼 수 있습니다. " +
        "새 버전은 미리보기 주소로 확인하십시오. " +
        APPROVE_WHERE
      );
    case "awaiting_approval":
      return (
        "학교 내부 승인이 필요하다고 답했으므로 승인 대기 상태로 등록했습니다. " +
        "승인 완료를 표시하기 전까지 공개 주소는 '학교 내부 승인 대기 중' 안내를 보여 주고, 허브 목록에서도 빠지며, " +
        "허브 앱 화면은 작성자와 관리자만 볼 수 있습니다. " +
        "그동안 미리보기 주소로 확인하십시오. " +
        APPROVE_WHERE
      );
  }
}

/**
 * 사이트를 허브에 미니앱으로 등록(셀프점검 필수)하고 공개 주소가 배포를 가리키게 한다.
 * 이미 등록된 사이트면 새 미니앱을 만들지 않고 기존 미니앱 정보와 공개 배포를 바꾼다.
 * 공개 중인 앱의 새 버전이 학교 내부 승인을 기다려야 하면 이전 공개 버전을 계속 서빙하고 새 버전은 pendingDeployId에 둔다.
 * 이미 승인된 앱을 같은 셀프점검 답으로 다시 등록하면 승인 완료를 유지하고 바로 새 버전으로 바꾼다.
 */
export async function publishSite(
  user: User,
  siteId: string,
  input: PublishInput,
  hub: string,
): Promise<SiteResult<PublishValue>> {
  if (!isTeacher(user)) return fail(403, "forbidden", "교사·관리자 계정만 사이트를 등록할 수 있습니다.");
  const snapshot = await readDb();
  const site = ownSite(snapshot, user, siteId);
  if (!site) return fail(404, "site_not_found", "사이트를 찾을 수 없습니다.");
  const liveUrl = siteUrl(hub, site.slug);
  const checked = checkPublishInput(input, liveUrl);
  if (!checked.ok) return checked;
  const appInput = checked.value;
  const deployIdIn = optionalString((input as { deployId?: unknown }).deployId);

  type Step = {
    deploy: SiteDeploy;
    slug: string;
    app: MiniApp | null;
    outcome: PublishOutcome | null;
    previouslyApproved: boolean;
    projectIdForApp: string | null;
  };

  const result = await withSiteLock(site.id, async (): Promise<SiteResult<PublishValue>> => {
    // 1) 배포를 고르고, 이미 등록된 미니앱이 있으면 같은 저장 안에서 고친다.
    const step = await mutate((db): SiteResult<Step> => {
      const s = ownSite(db, user, siteId);
      if (!s) return fail(404, "site_not_found", "사이트를 찾을 수 없습니다.");
      let deploy: SiteDeploy | undefined;
      if (deployIdIn) {
        deploy = db.siteDeploys.find((d) => d.id === deployIdIn && d.siteId === s.id);
        if (!deploy) return fail(404, "deploy_not_found", "이 사이트의 배포가 아닙니다.");
        if (deploy.status !== "ready") return fail(409, "deploy_not_ready", "아직 확정되지 않은 배포입니다.", "finalize를 먼저 실행하십시오.");
      } else {
        deploy = latestReady(db, s.id) ?? undefined;
        if (!deploy) return fail(409, "no_ready_deploy", "미리보기까지 끝난 배포가 없습니다.", "먼저 deploy로 사이트를 올려 미리보기를 확인하십시오.");
      }
      // F-31: 미니앱도 사이트와 같은 프로젝트에 연결한다(보관한 프로젝트면 연결하지 않는다).
      const projectIdForApp = activeOwnProject(db, user, s.projectId) ? s.projectId : null;
      const app = s.appId ? db.apps.find((a) => a.id === s.appId) ?? null : null;
      if (!app) {
        return { ok: true, value: { deploy, slug: s.slug, app: null, outcome: null, previouslyApproved: false, projectIdForApp } };
      }

      const prevStatus = app.approvalStatus;
      const prevAnswers: PrivacyAnswers = { ...app.privacyCheck };
      const maskedCount = applyAppInput(app, appInput);
      if (projectIdForApp) app.projectId = projectIdForApp;

      let outcome: PublishOutcome;
      if (!app.privacyCheck.needsSchoolApproval) {
        outcome = "public";
      } else if (prevStatus === "approved" && samePrivacyAnswers(prevAnswers, app.privacyCheck)) {
        outcome = "approval_kept";
      } else {
        // 공개 주소가 지금 실제로 보여 주는 버전(승인 필요 없음·승인 완료, 또는 이미 이전 버전을 붙잡아 둔 승인 대기)이 있으면 그대로 둔다.
        const liveReady = Boolean(
          s.liveDeployId && db.siteDeploys.some((d) => d.id === s.liveDeployId && d.siteId === s.id && d.status === "ready"),
        );
        const servingPublicly = liveReady && (prevStatus !== "pending" || Boolean(s.pendingDeployId));
        outcome = servingPublicly ? "kept_previous" : "awaiting_approval";
      }

      if (outcome === "public") {
        app.approvalStatus = "not_required";
        app.approvedAt = null;
        app.approvedByName = null;
      } else if (outcome !== "approval_kept") {
        app.approvalStatus = "pending";
        app.approvedAt = null;
        app.approvedByName = null;
      }
      if (outcome === "kept_previous") {
        s.pendingDeployId = deploy.id;
      } else {
        s.liveDeployId = deploy.id;
        s.pendingDeployId = null;
      }
      s.title = app.title;
      s.updatedAt = nowIso();
      const where = outcome === "kept_previous" ? `${deploy.id} 승인 대기(공개 주소는 ${s.liveDeployId} 유지)` : deploy.id;
      writeAudit(db, user, "site.publish", s.id, `${s.slug} → ${where}${maskedCount ? ` · 개인정보 ${maskedCount}건 마스킹` : ""}`);
      return {
        ok: true,
        value: { deploy, slug: s.slug, app, outcome, previouslyApproved: prevStatus === "approved", projectIdForApp },
      };
    });
    if (!step.ok) return step;

    let app = step.value.app;
    let outcome = step.value.outcome;
    const republish = Boolean(app);
    if (!app) {
      // 2) 처음 등록: 웹 폼·CLI와 같은 createApp으로 만든 뒤 사이트에 연결한다.
      const created = await createApp({ ...appInput, projectId: step.value.projectIdForApp }, user);
      if (!created.ok) return fail(422, "invalid_publish", created.error);
      app = created.value;
      const newApp = app;
      const deployId = step.value.deploy.id;
      const linked = await mutate((db): SiteResult<null> => {
        const s = ownSite(db, user, siteId);
        if (!s) return fail(404, "site_not_found", "사이트를 찾을 수 없습니다.");
        s.appId = newApp.id;
        s.liveDeployId = deployId;
        s.pendingDeployId = null;
        s.title = newApp.title;
        s.updatedAt = nowIso();
        writeAudit(db, user, "site.publish", s.id, `${s.slug} → ${deployId} · 미니앱 ${newApp.id}`);
        return { ok: true, value: null };
      });
      if (!linked.ok) return linked;
      outcome = newApp.approvalStatus === "pending" ? "awaiting_approval" : "public";
    }
    const finalOutcome: PublishOutcome = outcome ?? "public";
    return {
      ok: true,
      value: {
        appId: app.id,
        appUrl: `${hub.replace(/\/+$/, "")}/apps/${app.id}`,
        liveUrl,
        previewUrl: siteUrl(hub, `${step.value.slug}--${step.value.deploy.previewToken}`),
        // QA R7: 승인 유지(approval_kept)면 "approved"를 그대로 돌려준다(/api/sites와 같은 값).
        approvalStatus: app.approvalStatus,
        liveVersion: finalOutcome === "public" || finalOutcome === "approval_kept" ? "updated" : "kept_until_approval",
        message: publishMessage(finalOutcome, republish, step.value.previouslyApproved),
      },
    };
  });
  invalidateSiteServeCache();
  return result;
}

/* ---------- 목록·상세 ---------- */

function latestReady(db: DB, siteId: string): SiteDeploy | null {
  return (
    db.siteDeploys
      .filter((d) => d.siteId === siteId && d.status === "ready")
      .sort((a, b) => (b.finalizedAt ?? b.createdAt).localeCompare(a.finalizedAt ?? a.createdAt))[0] ?? null
  );
}

function readyDeploy(db: DB, site: Site, deployId: string | null | undefined): SiteDeploy | null {
  if (!deployId) return null;
  return db.siteDeploys.find((d) => d.id === deployId && d.siteId === site.id && d.status === "ready") ?? null;
}

/** 공개 주소가 이전 버전을 붙잡아 둔 채 승인을 기다리는 새 버전(없으면 null) */
function pendingDeployOf(db: DB, site: Site, app: MiniApp | null): SiteDeploy | null {
  if (!app || app.approvalStatus !== "pending") return null;
  return readyDeploy(db, site, site.pendingDeployId);
}

function summarize(db: DB, site: Site, hub: string): SiteSummary {
  const app = site.appId ? db.apps.find((a) => a.id === site.appId) ?? null : null;
  const published = Boolean(app && site.liveDeployId);
  const preview = latestReady(db, site.id);
  const pending = pendingDeployOf(db, site, app);
  return {
    id: site.id,
    slug: site.slug,
    title: site.title,
    projectId: site.projectId,
    liveUrl: published ? siteUrl(hub, site.slug) : null,
    previewUrl: preview ? siteUrl(hub, previewLabel(site, preview)) : null,
    appId: app ? app.id : null,
    approvalStatus: app ? app.approvalStatus : null,
    pendingPreviewUrl: pending ? siteUrl(hub, previewLabel(site, pending)) : null,
    updatedAt: site.updatedAt,
  };
}

/** 내 사이트 목록(최근 수정 순) */
export async function listMySites(user: User, hub: string): Promise<SiteSummary[]> {
  const db = await readDb();
  return db.sites
    .filter((s) => s.ownerUserId === user.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((s) => summarize(db, s, hub));
}

export interface SiteDeployView {
  id: string;
  status: SiteDeploy["status"];
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  finalizedAt: string | null;
  previewUrl: string | null;
  /** 공개 주소가 가리키는 배포(허브에 등록된 경우) */
  isLive: boolean;
  /** 학교 내부 승인을 기다리는 새 버전(승인되면 공개 주소로 바뀐다) */
  isPending: boolean;
}

export interface SiteDetail {
  summary: SiteSummary;
  app: MiniApp | null;
  deploys: SiteDeployView[];
}

/** 스튜디오 상세 화면용. 내 사이트가 아니면 null. */
export async function getMySite(user: User, siteId: string, hub: string): Promise<SiteDetail | null> {
  const db = await readDb();
  const site = ownSite(db, user, siteId);
  if (!site) return null;
  const app = site.appId ? db.apps.find((a) => a.id === site.appId) ?? null : null;
  const pending = pendingDeployOf(db, site, app);
  const deploys = db.siteDeploys
    .filter((d) => d.siteId === site.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((d) => ({
      id: d.id,
      status: d.status,
      fileCount: d.files.length,
      totalBytes: d.totalBytes,
      createdAt: d.createdAt,
      finalizedAt: d.finalizedAt,
      previewUrl: d.status === "ready" ? siteUrl(hub, previewLabel(site, d)) : null,
      isLive: Boolean(app) && site.liveDeployId === d.id,
      isPending: pending !== null && pending.id === d.id,
    }));
  return { summary: summarize(db, site, hub), app, deploys };
}

/**
 * 허브 앱 화면(/apps/[id])에서 승인 대기 앱의 작성자·관리자에게 보여 줄 미리보기 주소(F-51, QA F13).
 * 순서: 승인을 기다리는 새 버전(pendingDeployId) → 공개 주소에 연결된 버전(liveDeployId, 처음 등록한 앱이
 * 승인 대기 중이면 이것이 승인을 기다리는 버전) → 가장 최근에 확정된 버전. 허브 호스팅 사이트가 아니면 null.
 * 미리보기 주소는 비공개 링크이므로 호출하는 쪽이 작성자·관리자인지 먼저 확인해야 한다.
 */
export async function previewUrlForApp(appId: string, hub: string): Promise<string | null> {
  const db = await readDb();
  const site = db.sites.find((s) => s.appId === appId);
  if (!site) return null;
  const deploy =
    readyDeploy(db, site, site.pendingDeployId) ?? readyDeploy(db, site, site.liveDeployId) ?? latestReady(db, site.id);
  return deploy ? siteUrl(hub, previewLabel(site, deploy)) : null;
}

/* ---------- 관리: 프로젝트 옮기기·삭제 ---------- */

/** 사이트(와 연결된 미니앱)를 내 다른 활성 프로젝트로 옮긴다(F-31). 감사 로그 site.project.move. */
export async function moveSiteProject(
  user: User,
  siteId: string,
  projectId: string,
): Promise<SiteResult<{ siteId: string; projectId: string; moved: boolean }>> {
  if (!isTeacher(user)) return fail(403, "forbidden", "교사·관리자 계정만 사이트를 관리할 수 있습니다.");
  const target = optionalString(projectId);
  if (!target) return fail(400, "invalid_request", "옮길 프로젝트를 고르십시오.");
  const result = await mutate((db): SiteResult<{ siteId: string; projectId: string; moved: boolean }> => {
    const site = ownSite(db, user, siteId);
    if (!site) return fail(404, "site_not_found", "사이트를 찾을 수 없습니다.");
    if (site.projectId === target) return { ok: true, value: { siteId: site.id, projectId: target, moved: false } };
    if (!activeOwnProject(db, user, target)) {
      return fail(404, "project_not_found", "프로젝트를 찾을 수 없습니다.", "내 활성 프로젝트 중에서 고르십시오.");
    }
    moveSiteIn(db, user, site, target);
    return { ok: true, value: { siteId: site.id, projectId: target, moved: true } };
  });
  if (result.ok && result.value.moved) invalidateSiteServeCache();
  return result;
}

/**
 * 허브에 등록하지 않은 사이트를 지운다(QA UX-15: 업로드가 끝나지 않은 사이트·미리보기만 있는 사이트 정리).
 * 허브 미니앱이 연결된 사이트는 지우지 않는다(409 site_published). 파일 본문(blobs)은 다른 배포와 함께 쓰므로 남긴다.
 */
export async function deleteSite(user: User, siteId: string): Promise<SiteResult<{ siteId: string; deletedDeploys: number }>> {
  if (!isTeacher(user)) return fail(403, "forbidden", "교사·관리자 계정만 사이트를 관리할 수 있습니다.");
  const result = await mutate((db): SiteResult<{ siteId: string; deployIds: string[] }> => {
    const site = ownSite(db, user, siteId);
    if (!site) return fail(404, "site_not_found", "사이트를 찾을 수 없습니다.");
    if (site.appId && db.apps.some((a) => a.id === site.appId)) {
      return fail(
        409,
        "site_published",
        "허브에 등록된 사이트는 여기서 지울 수 없습니다.",
        "먼저 허브의 내 미니앱 화면(/studio/apps)에서 연결된 앱을 삭제하십시오.",
      );
    }
    const deployIds = db.siteDeploys.filter((d) => d.siteId === site.id).map((d) => d.id);
    db.siteDeploys = db.siteDeploys.filter((d) => d.siteId !== site.id);
    db.sites = db.sites.filter((s) => s.id !== site.id);
    writeAudit(db, user, "site.delete", site.id, `${site.slug} · 배포 ${deployIds.length}개`);
    return { ok: true, value: { siteId: site.id, deployIds } };
  });
  if (!result.ok) return result;
  invalidateSiteServeCache();
  await Promise.all(result.value.deployIds.map((id) => clearUploadReceipts(id).catch(() => undefined)));
  return { ok: true, value: { siteId: result.value.siteId, deletedDeploys: result.value.deployIds.length } };
}

/* ---------- 서빙 ---------- */

export type SiteServeResult =
  | { kind: "file"; file: SiteFile; status: 200 | 404; preview: boolean; baseHref: string | null }
  | { kind: "pending"; preview: false }
  | { kind: "not_found"; preview: boolean; reason: "no_site" | "not_published" | "no_file" };

const PREVIEW_LABEL_RE = /^([a-z0-9-]{3,30})--([a-z0-9]{10})$/;
const LIVE_LABEL_RE = /^[a-z0-9-]{3,30}$/;

/**
 * 요청 경로(퍼센트 인코딩 그대로)를 사이트 파일 경로 조각으로 바꾼다. 해석할 수 없으면 null.
 * `..`, 점으로 시작하는 세그먼트, 인코딩된 슬래시·역슬래시는 거부한다.
 */
export function decodeSitePath(pathname: string): { segments: string[]; trailingSlash: boolean } | null {
  const segments: string[] = [];
  for (const raw of pathname.split("/")) {
    if (raw === "") continue;
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    seg = seg.normalize("NFC");
    if (seg.includes("/") || seg.includes("\\") || CONTROL_RE.test(seg) || seg.startsWith(".")) return null;
    segments.push(seg);
  }
  return { segments, trailingSlash: pathname.endsWith("/") };
}

/** 사이트 이름(label)을 서빙할 배포의 파일 목록으로 해석한 결과. 캐시에 그대로 둔다. */
type LabelResolution =
  | { kind: "deploy"; files: Map<string, SiteFile>; preview: boolean }
  | Exclude<SiteServeResult, { kind: "file" }>;

function resolveLabelIn(db: DB, label: string): LabelResolution {
  const served = (deploy: SiteDeploy, preview: boolean): LabelResolution => ({
    kind: "deploy",
    files: new Map(deploy.files.map((f) => [f.path, f])),
    preview,
  });
  const pm = PREVIEW_LABEL_RE.exec(label);
  if (pm) {
    const site = db.sites.find((s) => s.slug === pm[1]);
    const deploy = site && db.siteDeploys.find((d) => d.siteId === site.id && d.previewToken === pm[2] && d.status === "ready");
    return deploy ? served(deploy, true) : { kind: "not_found", preview: true, reason: "no_site" };
  }
  if (!LIVE_LABEL_RE.test(label)) return { kind: "not_found", preview: false, reason: "no_site" };
  const site = db.sites.find((s) => s.slug === label);
  if (!site) return { kind: "not_found", preview: false, reason: "no_site" };
  const app = site.appId ? db.apps.find((a) => a.id === site.appId) : undefined;
  if (!app || !site.liveDeployId) return { kind: "not_found", preview: false, reason: "not_published" };
  // F-16: 학교 내부 승인 대기 중인 앱은 공개 주소로 열리지 않는다.
  // 단, 이미 공개한 앱의 새 버전만 승인을 기다리는 중(pendingDeployId)이면 이전에 공개한 버전을 계속 보여 준다.
  if (app.approvalStatus === "pending" && !site.pendingDeployId) return { kind: "pending", preview: false };
  const deploy = readyDeploy(db, site, site.liveDeployId);
  return deploy ? served(deploy, false) : { kind: "not_found", preview: false, reason: "not_published" };
}

/*
 * 사이트 서빙 캐시(QA global-lock-per-request-full-db). 파일 하나를 줄 때마다 db.json 전체를 잠그고 읽지 않도록
 * label → 배포 파일 목록을 메모리에 둔다. 다음 중 하나라도 바뀌면 다시 읽는다.
 * - 이 파일의 변경 함수(확정·publish·프로젝트 이동·삭제)가 올리는 버전 번호
 * - db.json의 수정 시각·크기(apps.ts의 승인·삭제처럼 다른 파일에서 바꾼 것도 바로 반영)
 * - 5초 TTL(파일 시각 해상도가 낮은 환경 대비 상한)
 * 라우트마다 번들이 따로 만들어져도 같은 캐시를 쓰도록 globalThis에 둔다.
 */
const SERVE_CACHE_TTL_MS = 5_000;
const SERVE_CACHE_MAX = 256;
const DB_FILE = path.join(DATA_DIR, "db.json");

type ServeCacheEntry = { at: number; version: number; stamp: string; value: LabelResolution };
type ServeCache = { version: number; entries: Map<string, ServeCacheEntry> };
const sg = globalThis as unknown as { __dandiSiteServeCache?: ServeCache };

function serveCache(): ServeCache {
  return (sg.__dandiSiteServeCache ??= { version: 0, entries: new Map() });
}

/** 사이트 서빙 캐시를 비운다. 사이트·배포·연결된 미니앱을 바꾼 뒤 부른다(다른 lib에서 불러도 된다). */
export function invalidateSiteServeCache(): void {
  const cache = serveCache();
  cache.version += 1;
  cache.entries.clear();
}

async function dbStamp(): Promise<string | null> {
  try {
    const st = await fs.stat(DB_FILE);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

async function resolveLabel(label: string): Promise<LabelResolution> {
  const cache = serveCache();
  const version = cache.version;
  const stamp = await dbStamp();
  const now = Date.now();
  const hit = cache.entries.get(label);
  if (hit && stamp !== null && hit.stamp === stamp && hit.version === version && now - hit.at < SERVE_CACHE_TTL_MS) {
    return hit.value;
  }
  const value = resolveLabelIn(await readDb(), label);
  // 읽는 동안 무효화됐으면(version이 바뀌었으면) 이 값은 저장해도 다음 조회에서 버려진다.
  if (stamp !== null) {
    cache.entries.delete(label);
    if (cache.entries.size >= SERVE_CACHE_MAX) {
      const oldest = cache.entries.keys().next().value;
      if (oldest !== undefined) cache.entries.delete(oldest);
    }
    cache.entries.set(label, { at: now, version, stamp, value });
  }
  return value;
}

/**
 * 사이트 요청을 파일로 해석한다. label은 호스트의 사이트 이름 부분, pathname은 원래 요청 경로.
 * 디렉터리 요청은 index.html, 확장자 없는 경로는 <경로>.html도 찾는다. 없으면 사이트의 404.html.
 * 허브가 끝 슬래시를 떼는 리다이렉트를 하므로(/docs/ → /docs), 하위 폴더 index.html을 슬래시 없이 열면
 * 상대 경로가 맞도록 baseHref(<base href>)를 함께 돌려준다.
 */
export async function resolveSiteRequest(label: string, pathname: string): Promise<SiteServeResult> {
  const found = await resolveLabel(label);
  if (found.kind !== "deploy") return found;
  const { files, preview } = found;
  const decoded = decodeSitePath(pathname);
  const notFound = (): SiteServeResult => {
    const page = files.get("404.html");
    return page
      ? { kind: "file", file: page, status: 404, preview, baseHref: null }
      : { kind: "not_found", preview, reason: "no_file" };
  };
  if (!decoded) return notFound();
  const rel = decoded.segments.join("/");
  const hit = (p: string, baseHref: string | null = null): SiteServeResult | null => {
    const f = files.get(p);
    return f ? { kind: "file", file: f, status: 200, preview, baseHref } : null;
  };
  if (rel === "") return hit("index.html") ?? notFound();
  if (decoded.trailingSlash) return hit(`${rel}/index.html`) ?? notFound();
  const base = `/${decoded.segments.map(encodeURIComponent).join("/")}/`;
  return hit(rel) ?? hit(`${rel}.html`) ?? hit(`${rel}/index.html`, base) ?? notFound();
}
