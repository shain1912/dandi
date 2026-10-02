import "server-only";
import { DEFAULT_MONTHLY_QUOTA } from "./constants";
import { mutate, newId, nowIso, readDb } from "./db";
import { clientIp as requestClientIp } from "./origin";
import { maskFields } from "./pii";
import { normalizeNewlines } from "./text";
import { AuthError, displayName, ensureUser, isTeacher, writeAudit } from "./session";
import { bearerToken, generateSecret, hashSecret } from "./tokens";
import type {
  AiModel,
  ApprovalStatus,
  DB,
  MiniApp,
  Project,
  ProjectApiKey,
  ProjectKeyRole,
  UsageRecord,
  User,
} from "./types";

// 프로젝트와 프로젝트 API 키(F-31 ~ F-35, Edge Impulse 방식). F-20 교사별 키를 대체한다.
// - 한도(월 예산)와 모델 정책은 프로젝트에 두고, 키는 인증 수단으로만 쓴다.
// - 키 원문은 발급 응답에서 한 번만 돌려주고 해시·앞부분·뒷4자리만 저장한다.
// - 교사 전체 상한(TEACHER_MONTHLY_CAP)은 모든 프로젝트 합계에 걸어, 프로젝트를 늘려 한도를 우회하지 못하게 한다.
// 게이트웨이 호출 자체는 ai.ts의 gatewayCall이 맡는다(이 파일은 ai.ts를 import하지 않는다).

/* ---------- 상수 ---------- */

/** 교사 1명당 활성 프로젝트 수 상한(F-31). 보관한 프로젝트는 세지 않는다. */
export const PROJECT_LIMIT = 10;
/** 프로젝트 1개당 삭제하지 않은 키 수 상한 */
export const KEY_LIMIT = 20;
/** 교사 전체 월 상한(F-28, F-33): 한 교사의 모든 프로젝트 사용량 합계 */
export const TEACHER_MONTHLY_CAP = 300_000;
export const DEFAULT_PROJECT_BUDGET = DEFAULT_MONTHLY_QUOTA;
export const MIN_PROJECT_BUDGET = 1_000;
export const MAX_PROJECT_BUDGET = TEACHER_MONTHLY_CAP;
/** 예산 알림 기준(F-33): 80%에서 알림, 100%에서 차단 */
export const BUDGET_ALERT_PCT = 80;
/** 만료 배지를 띄우는 기간(일) */
export const EXPIRY_WARN_DAYS = 7;
export const DEFAULT_PROJECT_NAME = "기본 프로젝트";
export const PROJECT_NAME_MAX = 40;
export const PROJECT_DESC_MAX = 300;
export const KEY_NAME_MAX = 40;

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/* ---------- 키 역할·만료 ---------- */

export const KEY_ROLES: { id: ProjectKeyRole; label: string; desc: string }[] = [
  {
    id: "inference",
    label: "inference (호출)",
    desc: "AI 게이트웨이 호출만 할 수 있습니다. 미니앱 서버 함수에 넣는 키로 권장합니다.",
  },
  {
    id: "admin",
    label: "admin (관리)",
    desc: "게이트웨이 호출과 함께 API로 이 프로젝트의 키 발급과 사용량 조회를 할 수 있습니다. CI·자동화용입니다.",
  },
  {
    id: "readonly",
    label: "readonly (조회)",
    desc: "API로 사용량과 설정을 조회만 할 수 있습니다. 게이트웨이는 호출할 수 없습니다.",
  },
];

export function isKeyRole(value: unknown): value is ProjectKeyRole {
  return KEY_ROLES.some((r) => r.id === value);
}

export function keyRoleLabel(role: ProjectKeyRole): string {
  return KEY_ROLES.find((r) => r.id === role)?.label ?? role;
}

export type ExpiryPreset = "3h" | "1d" | "7d" | "30d" | "semester" | "none";

export const EXPIRY_PRESETS: { id: ExpiryPreset; label: string }[] = [
  { id: "3h", label: "3시간 (수업 1회)" },
  { id: "1d", label: "1일" },
  { id: "7d", label: "7일" },
  { id: "30d", label: "30일" },
  { id: "semester", label: "학기 말" },
  { id: "none", label: "만료 없음" },
];

export const DEFAULT_EXPIRY: ExpiryPreset = "30d";

export function isExpiryPreset(value: unknown): value is ExpiryPreset {
  return EXPIRY_PRESETS.some((p) => p.id === value);
}

/**
 * 이번 학기 말(한국 시각). 초·중등교육법 시행령 제44조: 학년도는 3월 1일 ~ 다음 해 2월 말일.
 * 1학기 종료일은 학교마다 다르므로 8월 31일로 잡는다.
 * 3~8월이면 8월 31일 23:59:59, 9~12월이면 다음 해 2월 말일 23:59:59, 1~2월이면 올해 2월 말일 23:59:59.
 */
export function semesterEnd(now: Date = new Date()): Date {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth() + 1;
  // 다음 학기 시작 시각(KST 자정)에서 1초를 뺀다.
  const nextStart =
    m >= 3 && m <= 8 ? Date.UTC(y, 8, 1) : m >= 9 ? Date.UTC(y + 1, 2, 1) : Date.UTC(y, 2, 1);
  return new Date(nextStart - KST_OFFSET_MS - 1000);
}

/** 만료 프리셋 → 만료 시각(ISO). "none"이면 null. */
export function expiresAtFor(preset: ExpiryPreset, now: Date = new Date()): string | null {
  const t = now.getTime();
  switch (preset) {
    case "3h":
      return new Date(t + 3 * 60 * 60 * 1000).toISOString();
    case "1d":
      return new Date(t + DAY_MS).toISOString();
    case "7d":
      return new Date(t + 7 * DAY_MS).toISOString();
    case "30d":
      return new Date(t + 30 * DAY_MS).toISOString();
    case "semester":
      return semesterEnd(now).toISOString();
    case "none":
      return null;
  }
}

/* ---------- 키 상태·힌트 ---------- */

export type KeyStatus = "active" | "disabled" | "expired" | "deleted";

export const KEY_STATUS_LABEL: Record<KeyStatus, string> = {
  active: "사용 중",
  disabled: "비활성화",
  expired: "만료됨",
  deleted: "삭제됨",
};

export function keyStatus(key: ProjectApiKey, now: number = Date.now()): KeyStatus {
  if (key.deletedAt) return "deleted";
  if (key.disabledAt) return "disabled";
  if (key.expiresAt && Date.parse(key.expiresAt) <= now) return "expired";
  return "active";
}

/** 만료 7일 전부터 띄우는 경고 문구. 만료됐거나 만료가 없으면 null. */
export function expiryWarning(key: Pick<ProjectApiKey, "expiresAt">, now: number = Date.now()): string | null {
  if (!key.expiresAt) return null;
  const left = Date.parse(key.expiresAt) - now;
  if (left <= 0) return null;
  if (left <= DAY_MS) return "1일 안에 만료";
  if (left <= EXPIRY_WARN_DAYS * DAY_MS) return `${Math.ceil(left / DAY_MS)}일 후 만료`;
  return null;
}

/** 화면 힌트: dd_sk_ab12…9f3c (원문 대신 보여 주는 앞·뒷부분) */
export function keyHint(key: Pick<ProjectApiKey, "prefix" | "last4">): string {
  return key.last4 ? `${key.prefix}…${key.last4}` : `${key.prefix}…`;
}

/* ---------- 월·사용량 계산 ---------- */

// 월 한도는 학교 기준 시간대(KST)의 달력 월로 센다.
const MONTH_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
});

/** "2026-09" 형태의 월 키 (KST 기준) */
export function monthKey(date: Date | string = new Date()): string {
  return MONTH_FMT.format(typeof date === "string" ? new Date(date) : date);
}

/** 화면 표시용 한국 시각 */
export function formatKst(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

/** 순수 함수: 해당 월(기본: 이번 달, KST)의 토큰 합계. userId·projectId·keyId를 주면 그것만 센다. */
export function sumUsage(
  records: UsageRecord[],
  opts: { userId?: string; projectId?: string; keyId?: string; month?: string } = {},
): number {
  const month = opts.month ?? monthKey();
  let sum = 0;
  for (const r of records) {
    if (opts.userId && r.userId !== opts.userId) continue;
    if (opts.projectId && r.projectId !== opts.projectId) continue;
    if (opts.keyId && r.keyId !== opts.keyId) continue;
    if (monthKey(r.createdAt) !== month) continue;
    sum += r.tokens;
  }
  return sum;
}

function pct(used: number, total: number): number {
  if (total <= 0) return 100;
  return Math.floor((used / total) * 100);
}

/* ---------- 모델 정책 (F-34) ---------- */

/** 실제 호출 가능 모델 = 교육청 허용(allowed) ∩ 프로젝트 허용 목록(null이면 교육청 허용 전체). */
export function effectiveModels(project: Pick<Project, "modelIds">, models: AiModel[]): AiModel[] {
  return models.filter(
    (m) => m.status === "allowed" && (project.modelIds === null || project.modelIds.includes(m.id)),
  );
}

/* ---------- 결과 형식 ---------- */

export type ProjectErrorCode = "forbidden" | "not_found" | "invalid_input" | "limit_reached" | "archived";

export type ProjectResult<T> = { ok: true; value: T } | { ok: false; code: ProjectErrorCode; error: string };

/** JSON API용 HTTP 상태 */
export const PROJECT_ERROR_STATUS: Record<ProjectErrorCode, number> = {
  forbidden: 403,
  not_found: 404,
  invalid_input: 422,
  limit_reached: 409,
  archived: 409,
};

function fail(code: ProjectErrorCode, error: string): { ok: false; code: ProjectErrorCode; error: string } {
  return { ok: false, code, error };
}

const NOT_FOUND = "프로젝트를 찾을 수 없습니다.";
const n = (v: number) => v.toLocaleString("ko-KR");

/* ---------- 기존 교사별 키 이전 (F-20 → F-32) ---------- */

/** v0.1 저장소의 교사별 키(db.apiKeys). 타입에서는 빠졌지만 기존 db.json에는 남아 있을 수 있다. */
type LegacyApiKey = {
  id: string;
  userId: string;
  keyHash: string;
  keyPrefix: string;
  monthlyQuota?: number;
  createdAt: string;
  revokedAt: string | null;
};

type LegacyDb = DB & { apiKeys?: LegacyApiKey[] };

function hasLegacyKeys(db: DB): boolean {
  return Array.isArray((db as LegacyDb).apiKeys);
}

function newProjectRecord(owner: User, fields: Pick<Project, "name" | "description" | "monthlyTokenBudget" | "modelIds">): Project {
  return {
    id: newId("prj"),
    name: fields.name,
    description: fields.description,
    ownerUserId: owner.id,
    modelIds: fields.modelIds,
    monthlyTokenBudget: fields.monthlyTokenBudget,
    status: "active",
    createdAt: nowIso(),
  };
}

function activeProjectsOf(db: DB, userId: string): Project[] {
  // 만든 순서(오래된 것 먼저). 같은 시각이면 저장 순서를 따른다(안정 정렬).
  return db.projects
    .filter((p) => p.ownerUserId === userId && p.status === "active")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * 교사마다 "기본 프로젝트"를 만들어 기존 교사별 키를 옮긴다(PRD 15장 ⑪). 해시가 같으므로 기존 키는 계속 동작한다.
 * 폐기된 옛 키는 삭제된 키로 옮겨 사용 기록의 keyId만 이어지게 한다. 과거 사용 기록에는 projectId를 채운다.
 * 옮긴 뒤 db.apiKeys를 지운다. mutate 안에서만 호출한다. 옮긴 키 개수를 돌려준다.
 */
export function migrateLegacyKeys(db: DB): number {
  const legacyDb = db as LegacyDb;
  const legacy = legacyDb.apiKeys;
  if (!Array.isArray(legacy)) return 0;
  let moved = 0;
  const defaults = new Map<string, Project>();
  const defaultFor = (owner: User, quota: number | undefined): Project => {
    const cached = defaults.get(owner.id);
    if (cached) return cached;
    const existing = activeProjectsOf(db, owner.id)[0];
    const project =
      existing ??
      newProjectRecord(owner, {
        name: DEFAULT_PROJECT_NAME,
        description: "기존 개인 API 키를 옮긴 프로젝트입니다.",
        monthlyTokenBudget: Math.min(MAX_PROJECT_BUDGET, Math.max(MIN_PROJECT_BUDGET, quota ?? DEFAULT_PROJECT_BUDGET)),
        modelIds: null,
      });
    if (!existing) db.projects.push(project);
    defaults.set(owner.id, project);
    return project;
  };

  for (const old of legacy) {
    if (!old || typeof old.keyHash !== "string") continue;
    if (db.projectKeys.some((k) => k.id === old.id || k.keyHash === old.keyHash)) continue;
    const owner = db.users.find((u) => u.id === old.userId);
    if (!owner || !isTeacher(owner)) continue;
    const project = defaultFor(owner, old.monthlyQuota);
    db.projectKeys.push({
      id: old.id,
      projectId: project.id,
      name: "기존 개인 키",
      role: "inference",
      keyHash: old.revokedAt ? "" : old.keyHash,
      prefix: String(old.keyPrefix ?? "dd_sk_").slice(0, 10),
      last4: "", // 원문을 저장하지 않았으므로 뒷자리는 알 수 없다
      createdByUserId: owner.id,
      createdAt: old.createdAt,
      expiresAt: null,
      lastUsedAt: null,
      lastUsedIp: null,
      disabledAt: null,
      deletedAt: old.revokedAt ?? null,
    });
    moved += 1;
  }

  for (const r of db.usage) {
    if (r.projectId) continue;
    const key = db.projectKeys.find((k) => k.id === r.keyId);
    if (key) r.projectId = key.projectId;
  }
  delete legacyDb.apiKeys;
  return moved;
}

/** 읽기 전용 스냅샷. 옛 교사별 키가 남아 있으면 먼저 옮기고 저장한다. */
async function loadDb(): Promise<DB> {
  const db = await readDb();
  if (!hasLegacyKeys(db)) return db;
  return mutate((d) => {
    migrateLegacyKeys(d);
    return d;
  });
}

/* ---------- 입력 검증 ---------- */

type CleanText = { name: string; description: string };

/** 이름·설명: 길이 확인 → 마스킹(F-14). 이름은 한 줄로 만든다. */
function cleanProjectText(nameRaw: unknown, descRaw: unknown): ProjectResult<CleanText> {
  const name = (typeof nameRaw === "string" ? nameRaw : "").replace(/\s+/g, " ").trim();
  const description = normalizeNewlines(typeof descRaw === "string" ? descRaw : "").trim();
  if (!name) return fail("invalid_input", "프로젝트 이름을 입력하십시오.");
  if (name.length > PROJECT_NAME_MAX) return fail("invalid_input", `프로젝트 이름은 ${PROJECT_NAME_MAX}자 이하로 입력하십시오.`);
  if (description.length > PROJECT_DESC_MAX) {
    return fail("invalid_input", `프로젝트 설명은 ${PROJECT_DESC_MAX}자 이하로 입력하십시오.`);
  }
  return { ok: true, value: maskFields({ name, description }).values };
}

/** 월 예산: 숫자 또는 "100,000" 같은 문자열. 정수, MIN~MAX. */
export function parseBudget(value: unknown): ProjectResult<number> {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.replace(/[,\s]/g, "") : "";
  if (!raw) return fail("invalid_input", "월 예산(토큰)을 입력하십시오. 월 예산은 필수입니다.");
  if (!/^\d{1,9}$/.test(raw)) return fail("invalid_input", "월 예산은 0보다 큰 정수(토큰 수)로 입력하십시오.");
  const budget = Number(raw);
  if (budget < MIN_PROJECT_BUDGET || budget > MAX_PROJECT_BUDGET) {
    return fail(
      "invalid_input",
      `월 예산은 ${n(MIN_PROJECT_BUDGET)} ~ ${n(MAX_PROJECT_BUDGET)}토큰 사이로 입력하십시오(교사 전체 상한 ${n(TEACHER_MONTHLY_CAP)}토큰).`,
    );
  }
  return { ok: true, value: budget };
}

/**
 * 프로젝트 허용 모델 목록. null = 교육청 허용 모델 전체.
 * 목록의 id는 교사에게 보이는 모델(허용·보류)이어야 한다. 차단 모델은 교사 화면에서 숨기므로 없는 모델과 같이 거절한다.
 */
function cleanModelIds(db: DB, value: unknown): ProjectResult<string[] | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    return fail("invalid_input", "modelIds는 모델 id 문자열 배열이거나 null이어야 합니다.");
  }
  const ids = [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))];
  if (ids.length === 0) return fail("invalid_input", "허용할 모델을 하나 이상 고르십시오. 모두 허용하려면 교육청 허용 모델 전체를 고르십시오.");
  if (ids.length > 50) return fail("invalid_input", "모델은 50개까지 고를 수 있습니다.");
  const visible = new Set(db.models.filter((m) => m.status !== "blocked").map((m) => m.id));
  const unknown = ids.find((id) => !visible.has(id));
  if (unknown) return fail("invalid_input", `'${unknown.slice(0, 40)}' 모델을 찾을 수 없습니다.`);
  return { ok: true, value: ids };
}

function ownProject(db: DB, user: User, projectId: string): Project | null {
  if (!isTeacher(user)) return null;
  return db.projects.find((p) => p.id === projectId && p.ownerUserId === user.id) ?? null;
}

/* ---------- 화면·API용 보기 ---------- */

export type ProjectKeyView = {
  id: string;
  projectId: string;
  name: string;
  role: ProjectKeyRole;
  hint: string;
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  disabledAt: string | null;
  status: KeyStatus;
  expiryWarning: string | null;
  monthTokens: number;
  monthCalls: number;
};

export type ProjectSummary = Project & {
  monthTokens: number;
  budgetPct: number;
  budgetAlert: boolean;
  activeKeys: number;
  totalKeys: number;
  effectiveModelIds: string[];
};

export type UsageSummary = {
  month: string;
  projectTokens: number;
  projectCalls: number;
  budget: number;
  budgetPct: number;
  budgetAlert: boolean; // 80% 이상
  budgetBlocked: boolean; // 100% 이상
  teacherTokens: number;
  teacherCap: number;
  teacherPct: number;
  piiMasked: number;
  byKey: { keyId: string; name: string; hint: string; status: KeyStatus; tokens: number; calls: number }[];
  byModel: { modelId: string; modelName: string; tokens: number; calls: number }[];
  recent: { id: string; createdAt: string; keyName: string; modelName: string; tokens: number; piiMasked: number }[];
};

export type ProjectDetail = {
  project: Project;
  owner: { id: string; name: string };
  keys: ProjectKeyView[];
  usage: UsageSummary;
  /** 교사에게 보이는 모델(허용·보류). 차단 모델은 뺀다(F-23). */
  visibleModels: AiModel[];
  effective: AiModel[];
  sites: { id: string; slug: string; title: string; appId: string | null; published: boolean }[];
  /** 이 프로젝트에 연결된 미니앱(F-31). 외부 주소 앱과 허브 호스팅 사이트 앱을 모두 담는다 */
  apps: ProjectAppView[];
};

/**
 * 앱이 이 프로젝트에 연결된 방식.
 * explicit: 앱에 projectId가 있음 · site: 허브 호스팅 사이트의 프로젝트 · default: projectId가 없어 교사의 기본 프로젝트로 봄
 */
export type AppProjectLink = "explicit" | "site" | "default";

export type ProjectAppView = {
  id: string;
  title: string;
  url: string;
  /** 허브 호스팅 사이트로 올린 앱이면 사이트 이름(slug), 외부 주소 앱이면 null */
  siteSlug: string | null;
  approvalStatus: ApprovalStatus;
  link: AppProjectLink;
  createdAt: string;
};

/**
 * 미니앱이 속한 프로젝트(F-31). 앱에 projectId가 있으면 그 프로젝트, 없으면 연결된 사이트의 프로젝트,
 * 둘 다 없으면 작성 교사의 기본 프로젝트(가장 먼저 만든 사용 중 프로젝트, ensureDefaultProjectIn과 같은 규칙).
 */
export function appProjectIn(
  db: DB,
  app: Pick<MiniApp, "id" | "projectId" | "authorId">,
): { projectId: string | null; link: AppProjectLink } {
  if (app.projectId) return { projectId: app.projectId, link: "explicit" };
  const site = db.sites.find((s) => s.appId === app.id);
  if (site) return { projectId: site.projectId, link: "site" };
  return { projectId: activeProjectsOf(db, app.authorId)[0]?.id ?? null, link: "default" };
}

/** appProjectIn과 같은 규칙으로 이 프로젝트에 속한 앱(최근 것 먼저). 기본 프로젝트는 한 번만 계산한다. */
function projectAppsIn(db: DB, project: Project): ProjectAppView[] {
  const siteByApp = new Map(db.sites.filter((s) => s.appId).map((s) => [s.appId as string, s]));
  const isOwnersDefault = activeProjectsOf(db, project.ownerUserId)[0]?.id === project.id;
  const out: ProjectAppView[] = [];
  for (const app of db.apps) {
    const site = siteByApp.get(app.id);
    let link: AppProjectLink | null = null;
    if (app.projectId) link = app.projectId === project.id ? "explicit" : null;
    else if (site) link = site.projectId === project.id ? "site" : null;
    else if (isOwnersDefault && app.authorId === project.ownerUserId) link = "default";
    if (!link) continue;
    out.push({
      id: app.id,
      title: app.title,
      url: app.url,
      siteSlug: site?.slug ?? null,
      approvalStatus: app.approvalStatus,
      link,
      createdAt: app.createdAt,
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function keyViewIn(db: DB, key: ProjectApiKey, month: string, now: number): ProjectKeyView {
  const creator = db.users.find((u) => u.id === key.createdByUserId);
  let monthTokens = 0;
  let monthCalls = 0;
  for (const r of db.usage) {
    if (r.keyId !== key.id || monthKey(r.createdAt) !== month) continue;
    monthTokens += r.tokens;
    monthCalls += 1;
  }
  return {
    id: key.id,
    projectId: key.projectId,
    name: key.name,
    role: key.role,
    hint: keyHint(key),
    createdByUserId: key.createdByUserId,
    createdByName: creator ? displayName(creator) : "-",
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    lastUsedIp: key.lastUsedIp,
    disabledAt: key.disabledAt,
    status: keyStatus(key, now),
    expiryWarning: key.deletedAt || key.disabledAt ? null : expiryWarning(key, now),
    monthTokens,
    monthCalls,
  };
}

/** 삭제하지 않은 키 목록(최근 것 먼저). 해시는 밖으로 내보내지 않는다. */
function keyViewsIn(db: DB, projectId: string, month: string, now: number): ProjectKeyView[] {
  return db.projectKeys
    .filter((k) => k.projectId === projectId && !k.deletedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((k) => keyViewIn(db, k, month, now));
}

function projectSummaryIn(db: DB, project: Project, month: string, now: number): ProjectSummary {
  const monthTokens = sumUsage(db.usage, { projectId: project.id, month });
  const keys = db.projectKeys.filter((k) => k.projectId === project.id && !k.deletedAt);
  const budgetPct = pct(monthTokens, project.monthlyTokenBudget);
  return {
    ...project,
    monthTokens,
    budgetPct,
    budgetAlert: budgetPct >= BUDGET_ALERT_PCT,
    activeKeys: keys.filter((k) => keyStatus(k, now) === "active").length,
    totalKeys: keys.length,
    effectiveModelIds: effectiveModels(project, db.models).map((m) => m.id),
  };
}

/** 사용량 요약(F-33): 이번 달(KST) 프로젝트·키·모델별, 교사 전체 상한 대비. */
export function projectUsageIn(db: DB, project: Project, month: string = monthKey(), now: number = Date.now()): UsageSummary {
  const records = db.usage.filter((r) => r.projectId === project.id && monthKey(r.createdAt) === month);
  const projectTokens = records.reduce((s, r) => s + r.tokens, 0);
  const teacherTokens = sumUsage(db.usage, { userId: project.ownerUserId, month });
  // 차단 모델은 교사 화면에서 이름을 드러내지 않는다(F-23).
  const modelName = new Map(db.models.filter((m) => m.status !== "blocked").map((m) => [m.id, m.name]));
  const nameOfModel = (id: string) => modelName.get(id) ?? "사용 중지된 모델";
  const keysById = new Map(db.projectKeys.filter((k) => k.projectId === project.id).map((k) => [k.id, k]));

  const byKeyMap = new Map<string, { tokens: number; calls: number }>();
  const byModelMap = new Map<string, { modelName: string; tokens: number; calls: number }>();
  for (const r of records) {
    const k = byKeyMap.get(r.keyId) ?? { tokens: 0, calls: 0 };
    k.tokens += r.tokens;
    k.calls += 1;
    byKeyMap.set(r.keyId, k);
    const label = nameOfModel(r.modelId);
    // 차단 모델끼리는 한 줄로 묶는다(모델 id를 노출하지 않기 위해).
    const mk = modelName.has(r.modelId) ? r.modelId : "(hidden)";
    const mm = byModelMap.get(mk) ?? { modelName: label, tokens: 0, calls: 0 };
    mm.tokens += r.tokens;
    mm.calls += 1;
    byModelMap.set(mk, mm);
  }

  const budgetPct = pct(projectTokens, project.monthlyTokenBudget);
  return {
    month,
    projectTokens,
    projectCalls: records.length,
    budget: project.monthlyTokenBudget,
    budgetPct,
    budgetAlert: budgetPct >= BUDGET_ALERT_PCT,
    budgetBlocked: projectTokens >= project.monthlyTokenBudget,
    teacherTokens,
    teacherCap: TEACHER_MONTHLY_CAP,
    teacherPct: pct(teacherTokens, TEACHER_MONTHLY_CAP),
    piiMasked: records.reduce((s, r) => s + r.piiMasked, 0),
    byKey: [...byKeyMap.entries()]
      .map(([keyId, v]) => {
        const key = keysById.get(keyId);
        return {
          keyId,
          name: key ? (key.deletedAt ? `${key.name} (삭제됨)` : key.name) : "(알 수 없는 키)",
          hint: key ? keyHint(key) : "-",
          status: key ? keyStatus(key, now) : ("deleted" as KeyStatus),
          ...v,
        };
      })
      .sort((a, b) => b.tokens - a.tokens),
    byModel: [...byModelMap.entries()]
      .map(([modelId, v]) => ({ modelId: modelId === "(hidden)" ? "" : modelId, ...v }))
      .sort((a, b) => b.tokens - a.tokens),
    recent: [...records]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20)
      .map((r) => {
        const key = keysById.get(r.keyId);
        return {
          id: r.id,
          createdAt: r.createdAt,
          keyName: key ? `${key.name} (${keyHint(key)})` : "(알 수 없는 키)",
          modelName: nameOfModel(r.modelId),
          tokens: r.tokens,
          piiMasked: r.piiMasked,
        };
      }),
  };
}

/* ---------- 프로젝트 조회 ---------- */

/** 내 프로젝트(활성 먼저, 만든 순서). */
export async function listMyProjects(user: User): Promise<ProjectSummary[]> {
  if (!isTeacher(user)) return [];
  const db = await loadDb();
  const month = monthKey();
  const now = Date.now();
  return db.projects
    .filter((p) => p.ownerUserId === user.id)
    .sort(
      (a, b) =>
        Number(a.status === "archived") - Number(b.status === "archived") || a.createdAt.localeCompare(b.createdAt),
    )
    .map((p) => projectSummaryIn(db, p, month, now));
}

/** 내 활성 프로젝트와 각 프로젝트의 키(힌트만). 교사 화면 게이트웨이 테스트용. 한 스냅샷에서 계산한다. */
export async function listMyProjectsWithKeys(user: User): Promise<{ project: ProjectSummary; keys: ProjectKeyView[] }[]> {
  if (!isTeacher(user)) return [];
  const db = await loadDb();
  const month = monthKey();
  const now = Date.now();
  return activeProjectsOf(db, user.id).map((p) => ({
    project: projectSummaryIn(db, p, month, now),
    keys: keyViewsIn(db, p.id, month, now),
  }));
}

/** 소유한 프로젝트 하나(없거나 남의 것이면 null). 사이트 배포 등에서 projectId 검증에 쓴다. */
export async function getProjectForUser(user: User, projectId: string): Promise<Project | null> {
  const db = await loadDb();
  const p = ownProject(db, user, projectId);
  return p ? { ...p } : null;
}

/** 이번 달 교사 전체 사용량(모든 프로젝트 합계). */
export async function teacherMonthUsage(userId: string): Promise<number> {
  const db = await loadDb();
  return sumUsage(db.usage, { userId });
}

/** 상세 화면·API용 묶음. 한 스냅샷에서 모두 계산한다. */
export async function getProjectDetail(user: User, projectId: string): Promise<ProjectDetail | null> {
  const db = await loadDb();
  const project = ownProject(db, user, projectId);
  if (!project) return null;
  return projectDetailIn(db, project);
}

export function projectDetailIn(db: DB, project: Project): ProjectDetail {
  const month = monthKey();
  const now = Date.now();
  const owner = db.users.find((u) => u.id === project.ownerUserId);
  return {
    project: { ...project },
    owner: { id: project.ownerUserId, name: owner ? displayName(owner) : "-" },
    keys: keyViewsIn(db, project.id, month, now),
    usage: projectUsageIn(db, project, month, now),
    visibleModels: db.models.filter((m) => m.status !== "blocked"),
    effective: effectiveModels(project, db.models),
    sites: db.sites
      .filter((s) => s.projectId === project.id)
      .map((s) => ({ id: s.id, slug: s.slug, title: s.title, appId: s.appId, published: Boolean(s.liveDeployId) })),
    apps: projectAppsIn(db, project),
  };
}

/** 프로젝트 키 목록(힌트만). 남의 프로젝트면 null. */
export async function listProjectKeys(user: User, projectId: string): Promise<ProjectKeyView[] | null> {
  const db = await loadDb();
  const project = ownProject(db, user, projectId);
  if (!project) return null;
  return keyViewsIn(db, project.id, monthKey(), Date.now());
}

/* ---------- 프로젝트 만들기·바꾸기 ---------- */

export type NewProjectInput = {
  name: unknown;
  description?: unknown;
  monthlyTokenBudget?: unknown;
  modelIds?: unknown;
};

/** 새 프로젝트(F-31). 활성 프로젝트는 교사당 PROJECT_LIMIT개까지. 월 예산은 필수(없으면 기본값). */
export async function createProject(user: User, input: NewProjectInput): Promise<ProjectResult<Project>> {
  if (!isTeacher(user)) return fail("forbidden", "교사 로그인이 필요합니다.");
  const text = cleanProjectText(input.name, input.description);
  if (!text.ok) return text;
  const budget =
    input.monthlyTokenBudget === undefined || input.monthlyTokenBudget === ""
      ? ({ ok: true, value: DEFAULT_PROJECT_BUDGET } as const)
      : parseBudget(input.monthlyTokenBudget);
  if (!budget.ok) return budget;

  return mutate((db): ProjectResult<Project> => {
    migrateLegacyKeys(db);
    const models = cleanModelIds(db, input.modelIds);
    if (!models.ok) return models;
    if (activeProjectsOf(db, user.id).length >= PROJECT_LIMIT) {
      return fail(
        "limit_reached",
        `프로젝트는 교사 1명당 ${PROJECT_LIMIT}개까지 만들 수 있습니다(보관한 프로젝트 제외). 쓰지 않는 프로젝트를 보관하십시오.`,
      );
    }
    ensureUser(db, user);
    const project = newProjectRecord(user, {
      name: text.value.name,
      description: text.value.description,
      monthlyTokenBudget: budget.value,
      modelIds: models.value,
    });
    db.projects.push(project);
    writeAudit(db, user, "project.create", project.id, `${project.name} (월 예산 ${n(project.monthlyTokenBudget)}토큰)`);
    return { ok: true, value: { ...project } };
  });
}

/**
 * mutate 안에서 쓰는 기본 프로젝트 확보. 교사의 가장 오래된 활성 프로젝트를 돌려주고, 없으면 "기본 프로젝트"를 만든다.
 * 사이트 배포(F-51)처럼 projectId 없이 들어온 요청을 교사 프로젝트에 연결할 때 쓴다.
 * 주의: mutate 안에서 비동기 ensureDefaultProject를 부르면 잠금이 겹쳐 멈추므로 이 함수를 쓴다.
 */
export function ensureDefaultProjectIn(db: DB, user: User): Project {
  migrateLegacyKeys(db);
  const existing = activeProjectsOf(db, user.id)[0];
  if (existing) return existing;
  ensureUser(db, user);
  const project = newProjectRecord(user, {
    name: DEFAULT_PROJECT_NAME,
    description: "",
    monthlyTokenBudget: DEFAULT_PROJECT_BUDGET,
    modelIds: null,
  });
  db.projects.push(project);
  writeAudit(db, user, "project.create", project.id, `${DEFAULT_PROJECT_NAME} 자동 생성`);
  return project;
}

/** 교사의 기본 프로젝트(없으면 만든다). 교사·관리자만. */
export async function ensureDefaultProject(user: User): Promise<Project> {
  if (!isTeacher(user)) throw new AuthError("교사 로그인이 필요합니다.");
  return mutate((db) => ({ ...ensureDefaultProjectIn(db, user) }));
}

export type ProjectPatch = {
  name?: unknown;
  description?: unknown;
  monthlyTokenBudget?: unknown;
  /** null = 교육청 허용 모델 전체. undefined면 바꾸지 않는다 */
  modelIds?: unknown;
};

/** 이름·설명·월 예산·허용 모델 수정. 보관한 프로젝트는 바꿀 수 없다. 넘긴 항목만 바꾼다. */
export async function updateProject(user: User, projectId: string, patch: ProjectPatch): Promise<ProjectResult<Project>> {
  if (!isTeacher(user)) return fail("forbidden", "교사 로그인이 필요합니다.");
  const wantsText = patch.name !== undefined || patch.description !== undefined;
  const wantsBudget = patch.monthlyTokenBudget !== undefined;
  const wantsModels = patch.modelIds !== undefined;
  if (!wantsText && !wantsBudget && !wantsModels) return fail("invalid_input", "바꿀 항목이 없습니다.");
  const budget = wantsBudget ? parseBudget(patch.monthlyTokenBudget) : null;
  if (budget && !budget.ok) return budget;

  return mutate((db): ProjectResult<Project> => {
    migrateLegacyKeys(db);
    const project = ownProject(db, user, projectId);
    if (!project) return fail("not_found", NOT_FOUND);
    if (project.status === "archived") return fail("archived", "보관한 프로젝트는 바꿀 수 없습니다.");

    const next = { name: project.name, description: project.description };
    if (wantsText) {
      const text = cleanProjectText(patch.name ?? project.name, patch.description ?? project.description);
      if (!text.ok) return text;
      Object.assign(next, text.value);
    }
    let modelIds = project.modelIds;
    if (wantsModels) {
      const models = cleanModelIds(db, patch.modelIds);
      if (!models.ok) return models;
      modelIds = models.value;
    }

    const changed: string[] = [];
    if (next.name !== project.name || next.description !== project.description) {
      const fields = [next.name !== project.name && "이름", next.description !== project.description && "설명"].filter(Boolean);
      project.name = next.name;
      project.description = next.description;
      writeAudit(db, user, "project.update", project.id, `${fields.join("·")} 수정`);
      changed.push("text");
    }
    if (budget && budget.ok && budget.value !== project.monthlyTokenBudget) {
      writeAudit(
        db,
        user,
        "project.budget.update",
        project.id,
        `월 예산 ${n(project.monthlyTokenBudget)} -> ${n(budget.value)}토큰`,
      );
      project.monthlyTokenBudget = budget.value;
      changed.push("budget");
    }
    if (JSON.stringify(modelIds) !== JSON.stringify(project.modelIds)) {
      writeAudit(
        db,
        user,
        "project.models.update",
        project.id,
        modelIds === null ? "교육청 허용 모델 전체" : `허용 모델: ${modelIds.join(", ")}`,
      );
      project.modelIds = modelIds;
      changed.push("models");
    }
    if (changed.length === 0) return fail("invalid_input", "바뀐 내용이 없습니다.");
    ensureUser(db, user);
    return { ok: true, value: { ...project } };
  });
}

/** 프로젝트 보관(F-31). 모든 키를 비활성화하고, 되돌릴 수 없다. */
export async function archiveProject(user: User, projectId: string): Promise<ProjectResult<{ disabledKeys: number }>> {
  if (!isTeacher(user)) return fail("forbidden", "교사 로그인이 필요합니다.");
  return mutate((db): ProjectResult<{ disabledKeys: number }> => {
    migrateLegacyKeys(db);
    const project = ownProject(db, user, projectId);
    if (!project) return fail("not_found", NOT_FOUND);
    if (project.status === "archived") return fail("archived", "이미 보관한 프로젝트입니다.");
    const now = nowIso();
    let disabledKeys = 0;
    for (const k of db.projectKeys) {
      if (k.projectId === project.id && !k.deletedAt && !k.disabledAt) {
        k.disabledAt = now;
        disabledKeys += 1;
      }
    }
    project.status = "archived";
    ensureUser(db, user);
    writeAudit(db, user, "project.archive", project.id, `${project.name} 보관 (키 ${disabledKeys}개 비활성화)`);
    return { ok: true, value: { disabledKeys } };
  });
}

/* ---------- 키 발급·관리 (F-32) ---------- */

export type NewKeyInput = { name: unknown; role?: unknown; expiresPreset?: unknown };

/**
 * 프로젝트 키 발급. 원문(secret)은 이 반환값에서 한 번만 나오고, 저장소에는 해시·앞부분·뒷4자리만 남는다.
 * via: API에서 admin 키로 발급할 때 감사 로그에 남길 키 힌트.
 */
export async function createProjectKey(
  user: User,
  projectId: string,
  input: NewKeyInput,
  via?: { keyHint: string },
): Promise<ProjectResult<{ secret: string; key: ProjectKeyView }>> {
  if (!isTeacher(user)) return fail("forbidden", "교사 로그인이 필요합니다.");
  const rawName = (typeof input.name === "string" ? input.name : "").replace(/\s+/g, " ").trim();
  if (!rawName) return fail("invalid_input", "키 이름을 입력하십시오(예: 3반 퀴즈앱 서버).");
  if (rawName.length > KEY_NAME_MAX) return fail("invalid_input", `키 이름은 ${KEY_NAME_MAX}자 이하로 입력하십시오.`);
  const name = maskFields({ name: rawName }).values.name;
  const role = input.role === undefined || input.role === "" ? "inference" : input.role;
  if (!isKeyRole(role)) return fail("invalid_input", "역할은 admin, inference, readonly 중 하나여야 합니다.");
  const preset = input.expiresPreset === undefined || input.expiresPreset === "" ? DEFAULT_EXPIRY : input.expiresPreset;
  if (!isExpiryPreset(preset)) {
    return fail("invalid_input", "만료는 3h, 1d, 7d, 30d, semester, none 중 하나여야 합니다.");
  }

  const { secret, hash } = generateSecret("sk");
  const result = await mutate((db): ProjectResult<ProjectKeyView> => {
    migrateLegacyKeys(db);
    const project = ownProject(db, user, projectId);
    if (!project) return fail("not_found", NOT_FOUND);
    if (project.status === "archived") return fail("archived", "보관한 프로젝트에는 키를 만들 수 없습니다.");
    const live = db.projectKeys.filter((k) => k.projectId === project.id && !k.deletedAt).length;
    if (live >= KEY_LIMIT) {
      return fail("limit_reached", `키는 프로젝트마다 ${KEY_LIMIT}개까지 만들 수 있습니다. 쓰지 않는 키를 삭제하십시오.`);
    }
    const now = new Date();
    const key: ProjectApiKey = {
      id: newId("key"),
      projectId: project.id,
      name,
      role,
      keyHash: hash,
      prefix: secret.slice(0, 10),
      last4: secret.slice(-4),
      createdByUserId: user.id,
      createdAt: now.toISOString(),
      expiresAt: expiresAtFor(preset, now),
      lastUsedAt: null,
      lastUsedIp: null,
      disabledAt: null,
      deletedAt: null,
    };
    db.projectKeys.push(key);
    ensureUser(db, user);
    const expiry = key.expiresAt ? `만료 ${formatKst(key.expiresAt)}` : "만료 없음";
    writeAudit(
      db,
      user,
      "apikey.create",
      key.id,
      `${project.name} · ${key.name} · ${key.role} · ${keyHint(key)} · ${expiry}${via ? ` · API(admin 키 ${via.keyHint})` : ""}`,
    );
    return { ok: true, value: keyViewIn(db, key, monthKey(), now.getTime()) };
  });
  if (!result.ok) return result;
  return { ok: true, value: { secret, key: result.value } };
}

type KeyOp = "disable" | "enable" | "delete";

async function changeKey(user: User, projectId: string, keyId: string, op: KeyOp): Promise<ProjectResult<ProjectKeyView>> {
  if (!isTeacher(user)) return fail("forbidden", "교사 로그인이 필요합니다.");
  return mutate((db): ProjectResult<ProjectKeyView> => {
    migrateLegacyKeys(db);
    const project = ownProject(db, user, projectId);
    if (!project) return fail("not_found", NOT_FOUND);
    const key = db.projectKeys.find((k) => k.id === keyId && k.projectId === project.id && !k.deletedAt);
    if (!key) return fail("not_found", "키를 찾을 수 없습니다.");
    const now = nowIso();
    const hint = keyHint(key);
    if (op === "disable") {
      if (key.disabledAt) return fail("invalid_input", "이미 비활성화한 키입니다.");
      key.disabledAt = now;
      writeAudit(db, user, "apikey.disable", key.id, `${project.name} · ${key.name} · ${hint}`);
    } else if (op === "enable") {
      if (project.status === "archived") return fail("archived", "보관한 프로젝트의 키는 다시 켤 수 없습니다.");
      if (!key.disabledAt) return fail("invalid_input", "이미 사용 중인 키입니다.");
      if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) {
        return fail("invalid_input", "만료된 키는 다시 켤 수 없습니다. 새 키를 만드십시오.");
      }
      key.disabledAt = null;
      writeAudit(db, user, "apikey.enable", key.id, `${project.name} · ${key.name} · ${hint}`);
    } else {
      // 영구 삭제: 해시를 지워 다시 인증될 수 없게 하고, 사용 기록의 keyId를 위해 레코드는 남긴다.
      key.deletedAt = now;
      key.keyHash = "";
      writeAudit(db, user, "apikey.delete", key.id, `${project.name} · ${key.name} · ${hint}`);
    }
    ensureUser(db, user);
    return { ok: true, value: keyViewIn(db, key, monthKey(), Date.now()) };
  });
}

/** 비활성화(복구 가능) */
export function disableKey(user: User, projectId: string, keyId: string): Promise<ProjectResult<ProjectKeyView>> {
  return changeKey(user, projectId, keyId, "disable");
}

/** 비활성화한 키를 다시 켠다. 만료된 키와 보관한 프로젝트의 키는 켤 수 없다. */
export function enableKey(user: User, projectId: string, keyId: string): Promise<ProjectResult<ProjectKeyView>> {
  return changeKey(user, projectId, keyId, "enable");
}

/** 삭제(영구). 목록에서 사라지고 되돌릴 수 없다. */
export function deleteKey(user: User, projectId: string, keyId: string): Promise<ProjectResult<ProjectKeyView>> {
  return changeKey(user, projectId, keyId, "delete");
}

/* ---------- 키 인증 (게이트웨이·프로젝트 API 공통) ---------- */

export type KeyAuthFailure = {
  ok: false;
  status: 401 | 403;
  code: string;
  message: string;
  hint?: string;
  /** 키를 가진 쪽에 알려도 되는 경우에만 채운다(응답 헤더 x-dandi-project-id) */
  projectId?: string;
};

export type KeyAuth = { ok: true; key: ProjectApiKey; project: Project; owner: User } | KeyAuthFailure;

function authFail(
  status: 401 | 403,
  code: string,
  message: string,
  hint?: string,
  projectId?: string,
): KeyAuthFailure {
  return { ok: false, status, code, message, ...(hint ? { hint } : {}), ...(projectId ? { projectId } : {}) };
}

/** Authorization: Bearer 또는 x-api-key 헤더의 키. dd_sk_로 시작하는 쪽을 먼저 쓴다. */
export function apiKeyFromRequest(req: Request): string | null {
  const bearer = bearerToken(req);
  const header = req.headers.get("x-api-key")?.trim() || null;
  if (bearer && bearer.startsWith("dd_sk_")) return bearer;
  if (header) return header;
  return bearer;
}

/**
 * 브라우저에서 온 요청인지(F-35). 찾은 헤더 이름을 돌려준다.
 * - Origin: 브라우저는 POST 등 교차·동일 출처 요청에 늘 붙인다(file://에서 연 HTML은 "null").
 * - Sec-Fetch-Site·Sec-Fetch-Dest: 브라우저만 붙이는 Fetch Metadata.
 * - Sec-Fetch-Mode: Node.js 18+ fetch(undici)는 서버에서도 "Sec-Fetch-Mode: cors"를 단독으로 붙이므로,
 *   이 값 하나만으로는 거부하지 않는다(서버 프록시가 막히지 않게). 그 밖의 값(navigate, no-cors 등)은 브라우저로 본다.
 */
export function browserSignal(req: Request): string | null {
  const h = req.headers;
  if (h.has("origin")) return "Origin";
  if (h.has("sec-fetch-site")) return "Sec-Fetch-Site";
  if (h.has("sec-fetch-dest")) return "Sec-Fetch-Dest";
  const mode = h.get("sec-fetch-mode");
  if (mode && mode.trim().toLowerCase() !== "cors") return "Sec-Fetch-Mode";
  return null;
}

/** clientIp가 프록시 설정 없이 IP를 알 수 없을 때 돌려주는 값(origin.ts clientIp와 같음). */
export const LOCAL_CLIENT_IP = "local";

type HeaderGetter = { get(name: string): string | null };
type HeaderSource = Request | HeaderGetter;

/**
 * 요청한 쪽 IP(키의 마지막 사용 IP 표시용). origin.ts의 clientIp를 따른다:
 * TRUST_PROXY일 때만 X-Forwarded-For의 가장 오른쪽 값(프록시가 덧붙인 값)을 쓰고, 아니면 "local".
 * 맨 앞 값은 클라이언트가 마음대로 넣을 수 있어 쓰지 않는다. 형식이 이상하면 null.
 */
export function clientIp(source: HeaderSource): string | null {
  // Headers·next/headers의 ReadonlyHeaders는 get이 있고, Request는 headers 속성에 있다.
  const h = typeof (source as Partial<HeaderGetter>).get === "function" ? (source as HeaderGetter) : (source as Request).headers;
  const ip = requestClientIp(h).trim().replace(/^::ffff:/i, "");
  if (ip === LOCAL_CLIENT_IP) return ip;
  return /^[0-9A-Fa-f:.]{2,45}$/.test(ip) ? ip : null;
}

/**
 * 화면 표시용 IP. "local"은 프록시 설정(TRUST_PROXY) 없이 IP를 알 수 없었다는 뜻일 뿐, 요청이 이 컴퓨터에서
 * 왔다는 뜻이 아니다(허브는 0.0.0.0에서 받으므로 다른 컴퓨터의 요청도 "local"이 된다). 그래서 "확인할 수 없음"으로 보여 준다.
 */
export function formatKeyIp(ip: string | null | undefined): string {
  if (!ip) return "IP 알 수 없음";
  return ip === LOCAL_CLIENT_IP ? "확인할 수 없음" : ip;
}

export const BROWSER_KEY_HINT =
  "비밀 키(dd_sk_)를 HTML·JavaScript에 넣지 말고, 미니앱의 서버 함수(프록시)에서 환경변수 DANDI_PROJECT_KEY로 읽어 호출하십시오. " +
  "예시: /downloads/ai-proxy-example.md . 키가 이미 공개된 코드에 들어갔다면 /studio/projects 에서 그 키를 비활성화하고 새 키를 만드십시오.";

/**
 * 키가 지금 쓸 수 있는지(순서: 없음·삭제 401 → 프로젝트 보관 403 → 비활성화 401 → 만료 401 → 소유 교사 없음 401).
 * 스냅샷과 mutate 잠금 안에서 모두 쓴다.
 */
export function checkKeyIn(db: DB, key: ProjectApiKey | undefined, now: number = Date.now()): KeyAuth {
  if (!key || key.deletedAt || !key.keyHash) {
    return authFail(401, "invalid_key", "API 키가 없거나 삭제되었습니다.", "/studio/projects 의 키 탭에서 새 키를 만드십시오.");
  }
  const project = db.projects.find((p) => p.id === key.projectId);
  if (!project) return authFail(401, "invalid_key", "API 키가 없거나 삭제되었습니다.");
  const keysTab = `/studio/projects/${project.id}?tab=keys`;
  if (project.status === "archived") {
    return authFail(403, "project_archived", "보관한 프로젝트의 키입니다. 이 프로젝트로는 호출할 수 없습니다.", "활성 프로젝트의 키를 쓰십시오.", project.id);
  }
  if (key.disabledAt) {
    return authFail(401, "key_disabled", "비활성화한 키입니다.", `${keysTab} 에서 다시 켜거나 새 키를 만드십시오.`, project.id);
  }
  if (key.expiresAt && Date.parse(key.expiresAt) <= now) {
    return authFail(401, "key_expired", `만료된 키입니다(만료 ${formatKst(key.expiresAt)}).`, `${keysTab} 에서 새 키를 만드십시오.`, project.id);
  }
  const owner = db.users.find((u) => u.id === project.ownerUserId);
  if (!owner || !isTeacher(owner)) return authFail(401, "invalid_key", "API 키가 없거나 삭제되었습니다.");
  return { ok: true, key, project, owner };
}

/**
 * 요청 헤더의 프로젝트 키로 인증한다(F-32). 해시로만 비교한다.
 * 브라우저 신호가 있는 dd_sk_ 요청은 키를 확인하기 전에 401 browser_key_forbidden으로 거부한다(F-35).
 * 통과하면 키의 마지막 사용 시각·IP를 기록한다.
 */
export async function authenticateProjectKey(req: Request): Promise<KeyAuth> {
  const token = apiKeyFromRequest(req);
  if (!token) {
    return authFail(
      401,
      "missing_key",
      "프로젝트 API 키가 필요합니다.",
      "Authorization: Bearer dd_sk_... 또는 x-api-key: dd_sk_... 헤더로 보내십시오. 키는 /studio/projects 의 키 탭에서 만듭니다.",
    );
  }
  if (token.startsWith("dd_sk_")) {
    const signal = browserSignal(req);
    if (signal) {
      return authFail(
        401,
        "browser_key_forbidden",
        `브라우저에서 보낸 요청(${signal} 헤더)은 비밀 키(dd_sk_)로 호출할 수 없습니다.`,
        BROWSER_KEY_HINT,
      );
    }
  }
  if (!token.startsWith("dd_sk_") || token.length > 200) {
    return authFail(401, "invalid_key", "프로젝트 API 키(dd_sk_...) 형식이 아닙니다.", "/studio/projects 의 키 탭에서 만든 키를 쓰십시오.");
  }
  const hash = hashSecret(token);
  const ip = clientIp(req);
  return mutate((db): KeyAuth => {
    migrateLegacyKeys(db);
    const auth = checkKeyIn(db, db.projectKeys.find((k) => k.keyHash === hash));
    if (!auth.ok) return auth;
    auth.key.lastUsedAt = nowIso();
    auth.key.lastUsedIp = ip;
    return { ok: true, key: { ...auth.key }, project: { ...auth.project }, owner: auth.owner };
  });
}

/** 교사 화면 테스트 호출(서버 액션)에서 키를 쓸 때 마지막 사용 기록을 남긴다. mutate 안에서 호출한다. */
export function touchKeyIn(key: ProjectApiKey, ip: string | null): void {
  key.lastUsedAt = nowIso();
  key.lastUsedIp = ip;
}

/* ---------- 관리자 요약 ---------- */

export type ProjectStats = {
  projects: number;
  activeProjects: number;
  archivedProjects: number;
  owners: number;
  keysTotal: number;
  keysActive: number;
  keysDisabled: number;
  keysExpired: number;
  keysExpiringSoon: number;
  monthTokens: number;
  alertProjects: number;
  teachersAtCap: number;
};

/** 관리자 운영 요약용 통계(순수 함수). 키 total은 삭제된 키를 포함한 누적 발급 수. */
export function projectStatsIn(db: DB, month: string = monthKey(), now: number = Date.now()): ProjectStats {
  const activeIds = new Set(db.projects.filter((p) => p.status === "active").map((p) => p.id));
  let keysActive = 0;
  let keysDisabled = 0;
  let keysExpired = 0;
  let keysExpiringSoon = 0;
  for (const k of db.projectKeys) {
    const s = keyStatus(k, now);
    if (s === "active" && activeIds.has(k.projectId)) {
      keysActive += 1;
      if (expiryWarning(k, now)) keysExpiringSoon += 1;
    } else if (s === "disabled") keysDisabled += 1;
    else if (s === "expired") keysExpired += 1;
  }
  const teacherTotals = new Map<string, number>();
  for (const r of db.usage) {
    if (monthKey(r.createdAt) !== month) continue;
    teacherTotals.set(r.userId, (teacherTotals.get(r.userId) ?? 0) + r.tokens);
  }
  return {
    projects: db.projects.length,
    activeProjects: activeIds.size,
    archivedProjects: db.projects.length - activeIds.size,
    owners: new Set(db.projects.map((p) => p.ownerUserId)).size,
    keysTotal: db.projectKeys.length,
    keysActive,
    keysDisabled,
    keysExpired,
    keysExpiringSoon,
    monthTokens: sumUsage(db.usage, { month }),
    alertProjects: db.projects.filter(
      (p) => p.status === "active" && pct(sumUsage(db.usage, { projectId: p.id, month }), p.monthlyTokenBudget) >= BUDGET_ALERT_PCT,
    ).length,
    teachersAtCap: [...teacherTotals.values()].filter((t) => t >= TEACHER_MONTHLY_CAP).length,
  };
}
