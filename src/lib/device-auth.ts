import "server-only";
import { randomInt } from "node:crypto";
import { mutate, newId, nowIso, readDb } from "./db";
import { maskFields } from "./pii";
import { ensureUser, isTeacher, writeAudit } from "./session";
import { generateSecret, hashSecret } from "./tokens";
import type { CliToken, DB, DeviceAuth, Role, SchoolLevel, User } from "./types";

// CLI 브라우저 승인 로그인(F-53, RFC 8628 device authorization grant).
// 1) CLI가 start를 호출하면 device_code(비밀값, 해시만 저장)와 user_code(화면 대조용 8자)를 만든다.
// 2) 교사는 허브의 /device 화면에서 코드가 같은지 확인하고 [승인]/[거부]한다(교사 세션 필수).
// 3) CLI는 token을 폴링하다가 승인되면 dd_cli_ 토큰을 한 번만 받는다. 이후 device_code는 consumed.

/** 사람이 읽고 입력하기 쉬운 자음 20자(RFC 8628 6.1 권장). 모음이 없어 단어가 만들어지지 않는다. */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const DEVICE_CODE_TTL_SECONDS = 600;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
/** 같은 IP(믿을 수 있는 프록시가 알려 준 실제 IP)에서 1분 동안 시작할 수 있는 로그인 요청 수 */
const START_PER_IP_PER_MINUTE = 10;
/**
 * 요청 IP를 알 수 없을 때("local": 믿을 수 있는 프록시 없음, "unknown") 모두가 함께 쓰는 1분 한도.
 * 헤더를 바꿔 IP별 한도를 피할 수 없게 하되, 연수장처럼 교사 수십 명이 한꺼번에 로그인해도 막히지 않게 넉넉하게 둔다.
 */
const START_SHARED_PER_MINUTE = 120;
/**
 * IP를 알 수 없을 때 같은 도구·컴퓨터 이름(client + hostname)에서 1분 동안 시작할 수 있는 로그인 요청 수.
 * 한 클라이언트가 공용 한도를 혼자 다 쓰지 못하게 한다(이름을 바꿔 가며 보내도 공용 한도 120은 넘지 못한다).
 */
const START_PER_CLIENT_PER_MINUTE = 10;
/** 한 교사가 1시간 동안 틀릴 수 있는 코드 입력 수(GitHub 기준) */
const FAILED_LOOKUPS_PER_HOUR = 50;
/** 끝난 요청을 감사·표시용으로 남겨 두는 기간 */
const KEEP_FINISHED_MS = 24 * 60 * 60 * 1000;

const TEXT_LIMITS = { client: 64, hostname: 128, os: 64 } as const;

export type DeviceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string; hint?: string };

export interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** 화면에 내보내는 요청 정보. device_code 해시와 폴링 시각은 내보내지 않는다. */
export type DeviceView = Omit<DeviceAuth, "deviceCodeHash" | "lastPolledAt">;

export type DeviceTokenResult =
  | { ok: true; token: string; user: { name: string | null; role: Role; schoolLevel: SchoolLevel | null } }
  | {
      ok: false;
      error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_grant";
      description: string;
    };

function fail(status: number, code: string, message: string, hint?: string): { ok: false; status: number; code: string; message: string; hint?: string } {
  return { ok: false, status, code, message, ...(hint ? { hint } : {}) };
}

/** 무작위 user_code("WDJB-MJHT" 형식). */
export function generateUserCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/**
 * 사람이 입력한 코드를 저장 형식으로 바꾼다. 대소문자·하이픈·공백은 무시한다.
 * 허용 문자 8자가 아니면 null.
 */
export function normalizeUserCode(input: string | null | undefined): string | null {
  if (!input || input.length > 32) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== 8) return null;
  for (const c of s) if (!USER_CODE_ALPHABET.includes(c)) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/**
 * 저장·표시할 요청 IP. origin.ts의 clientIp(믿을 수 있는 프록시가 붙인 가장 오른쪽 값, 프록시가 없으면 "local")를 받아
 * 주소 형식이 아니면 "unknown"으로 바꾼다. 요청 헤더의 첫 값(클라이언트가 마음대로 넣는 값)은 쓰지 않는다.
 */
export function normalizeDeviceIp(ip: string): string {
  if (ip === "local") return "local";
  return ip.length > 0 && ip.length <= 64 && /^[0-9A-Fa-f:.]+$/.test(ip) ? ip : "unknown";
}

/* ---------- 교사에게 보여 줄 이름 ---------- */

const CLIENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "gemini-cli": "Gemini CLI",
  terminal: "터미널",
  "non-interactive": "자동 실행(비대화형)",
  unknown: "알 수 없음",
};

/** 요청 도구 이름(예: "claude-code" → "Claude Code", "mcp:cursor" → "MCP 연결 (cursor)"). */
export function clientLabel(client: string): string {
  if (client.startsWith("mcp:")) return `MCP 연결 (${client.slice(4) || "알 수 없음"})`;
  return CLIENT_LABELS[client] ?? client;
}

/** CLI가 보낸 운영체제 문자열(os.platform() os.release())을 사람이 읽는 이름으로 바꾼다. 예: "win32 10.0.26200" → "Windows 11". */
export function friendlyOs(os: string): string {
  const s = os.trim();
  if (!s || s === "unknown") return "알 수 없음";
  const win = /^win32\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(s);
  if (win) {
    const [major, minor, build] = [Number(win[1]), Number(win[2]), Number(win[3] ?? 0)];
    if (major === 10) return build >= 22000 ? "Windows 11" : "Windows 10";
    if (major === 6 && minor === 3) return "Windows 8.1";
    if (major === 6 && minor === 2) return "Windows 8";
    if (major === 6 && minor === 1) return "Windows 7";
    return "Windows";
  }
  if (/^win32\b/i.test(s)) return "Windows";
  const mac = /^darwin\s+(\d+)/i.exec(s);
  if (mac) {
    const darwin = Number(mac[1]);
    if (darwin >= 20 && darwin <= 24) return `macOS ${darwin - 9}`;
    if (darwin === 25) return "macOS 26";
    return "macOS";
  }
  if (/^darwin\b/i.test(s)) return "macOS";
  if (/^linux\b/i.test(s)) return /microsoft|wsl/i.test(s) ? "Linux (WSL)" : "Linux";
  if (/^android\b/i.test(s)) return "Android";
  if (/^(freebsd|openbsd)\b/i.test(s)) return s.split(/\s+/)[0];
  return s;
}

/**
 * 요청한 곳 표시. 믿을 수 있는 프록시가 알려 준 루프백 주소면 "이 컴퓨터", 실제 IP면 그 IP.
 * 프록시가 없어 IP를 알 수 없으면("local", "unknown") 언제나 "확인할 수 없음"이다.
 * 허브는 0.0.0.0에서 듣기 때문에, 허브를 localhost로 열었더라도 요청이 다른 컴퓨터에서 왔을 수 있다(QA R12).
 */
export function friendlyIp(ip: string): string {
  if (!ip || ip === "local" || ip === "unknown") return "확인할 수 없음";
  const loopback = ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.");
  return loopback ? "이 컴퓨터" : ip;
}

/** IP를 알 수 없어 모두가 함께 쓰는 한도 묶음인가("local": 믿을 수 있는 프록시 없음, "unknown") */
function isSharedIp(ip: string): boolean {
  return ip === "local" || ip === "unknown";
}

/**
 * 로그인 시작 속도 제한. 실제 IP를 알면 IP별 1분 10회.
 * IP를 모르면 공용 1분 120회와, 같은 client+hostname 1분 10회를 함께 적용한다.
 * 한도를 넘었으면 true.
 */
export function startRateLimited(
  recent: Pick<DeviceAuth, "ip" | "client" | "hostname" | "createdAt">[],
  input: { ip: string; client: string; hostname: string },
  now: number,
): boolean {
  const lastMinute = recent.filter((d) => now - Date.parse(d.createdAt) < 60_000);
  if (!isSharedIp(input.ip)) return lastMinute.filter((d) => d.ip === input.ip).length >= START_PER_IP_PER_MINUTE;
  const shared = lastMinute.filter((d) => isSharedIp(d.ip));
  if (shared.length >= START_SHARED_PER_MINUTE) return true;
  const sameClient = shared.filter((d) => d.client === input.client && d.hostname === input.hostname).length;
  return sameClient >= START_PER_CLIENT_PER_MINUTE;
}

/** 로그인된 기기 이름: "<도구> · <컴퓨터 이름> · <운영체제>" (CliToken.label, 120자 이하). */
export function deviceLabel(d: { client: string; hostname: string; os: string }): string {
  const host = d.hostname && d.hostname !== "unknown" ? d.hostname : "이름 없는 컴퓨터";
  return `${clientLabel(d.client)} · ${host} · ${friendlyOs(d.os)}`.slice(0, 120);
}

function cleanText(value: unknown, max: number, fallback: string): string | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") return null;
  // 길이를 먼저 확인한 뒤 제어 문자 제거·개인정보 검사를 한다.
  if (value.length > max) return null;
  const s = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s || fallback;
}

/** start 요청 본문 검사. 자유 입력(도구 이름·컴퓨터 이름·OS)은 길이 확인 뒤 개인정보를 가린다. */
export function parseStartInput(body: unknown): DeviceResult<{ client: string; hostname: string; os: string }> {
  const rec = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!rec) return fail(400, "invalid_request", "요청 본문은 JSON 객체여야 합니다.");
  const client = cleanText(rec.client, TEXT_LIMITS.client, "unknown");
  const hostname = cleanText(rec.hostname, TEXT_LIMITS.hostname, "unknown");
  const os = cleanText(rec.os, TEXT_LIMITS.os, "unknown");
  if (client === null) return fail(400, "invalid_request", `client는 ${TEXT_LIMITS.client}자 이하 문자열이어야 합니다.`);
  if (hostname === null) return fail(400, "invalid_request", `hostname은 ${TEXT_LIMITS.hostname}자 이하 문자열이어야 합니다.`);
  if (os === null) return fail(400, "invalid_request", `os는 ${TEXT_LIMITS.os}자 이하 문자열이어야 합니다.`);
  const masked = maskFields({ client, hostname, os });
  return { ok: true, value: masked.values };
}

function isExpired(d: DeviceAuth, now = Date.now()): boolean {
  return Date.parse(d.expiresAt) <= now;
}

function prune(db: DB, now: number): void {
  db.deviceAuths = db.deviceAuths.filter((d) => Date.parse(d.expiresAt) + KEEP_FINISHED_MS > now);
}

function toView(d: DeviceAuth): DeviceView {
  return {
    id: d.id,
    userCode: d.userCode,
    client: d.client,
    hostname: d.hostname,
    os: d.os,
    ip: d.ip,
    status: d.status,
    userId: d.userId,
    createdAt: d.createdAt,
    expiresAt: d.expiresAt,
  };
}

/** 로그인 요청을 만든다. device_code 원문은 이 응답으로 한 번만 CLI에 전달되고 해시만 저장한다. */
export async function startDeviceAuth(
  input: { client: string; hostname: string; os: string },
  requestIp: string,
  hub: string,
): Promise<DeviceResult<DeviceStartResponse>> {
  const ip = normalizeDeviceIp(requestIp);
  const { secret, hash } = generateSecret("dev");
  return mutate((db) => {
    const now = Date.now();
    prune(db, now);
    if (startRateLimited(db.deviceAuths, { ip, client: input.client, hostname: input.hostname }, now)) {
      return fail(429, "rate_limited", "로그인 요청이 너무 잦습니다.", "1분 뒤 다시 시도하십시오.");
    }
    // 살아 있는 요청끼리는 user_code가 겹치지 않게 한다.
    const live = new Set(db.deviceAuths.filter((d) => !isExpired(d, now)).map((d) => d.userCode));
    let userCode = generateUserCode();
    for (let i = 0; live.has(userCode) && i < 20; i++) userCode = generateUserCode();
    if (live.has(userCode)) return fail(503, "busy", "잠시 뒤 다시 시도하십시오.");

    const created = new Date(now).toISOString();
    db.deviceAuths.push({
      id: newId("dev"),
      deviceCodeHash: hash,
      userCode,
      client: input.client,
      hostname: input.hostname,
      os: input.os,
      ip,
      status: "pending",
      userId: null,
      createdAt: created,
      expiresAt: new Date(now + DEVICE_CODE_TTL_SECONDS * 1000).toISOString(),
      lastPolledAt: null,
    });
    const verification = `${hub}/device`;
    return {
      ok: true as const,
      value: {
        device_code: secret,
        user_code: userCode,
        verification_uri: verification,
        verification_uri_complete: `${verification}?code=${userCode}`,
        expires_in: DEVICE_CODE_TTL_SECONDS,
        interval: DEVICE_POLL_INTERVAL_SECONDS,
      },
    };
  });
}

/**
 * CLI 폴링. RFC 8628 3.5의 오류 이름을 그대로 쓴다.
 * 승인된 요청은 여기서 dd_cli_ 토큰을 발급하고 consumed로 바꾼다(성공은 한 번만).
 */
export async function pollDeviceToken(deviceCode: string): Promise<DeviceTokenResult> {
  const invalid: DeviceTokenResult = {
    ok: false,
    error: "invalid_grant",
    description: "알 수 없거나 이미 사용한 device_code입니다. 로그인을 처음부터 다시 하십시오.",
  };
  if (!deviceCode.startsWith("dd_dev_") || deviceCode.length > 128) return invalid;
  const hash = hashSecret(deviceCode);
  return mutate((db): DeviceTokenResult => {
    const now = Date.now();
    const d = db.deviceAuths.find((x) => x.deviceCodeHash === hash);
    if (!d || d.status === "consumed") return invalid;
    if (isExpired(d, now)) {
      return { ok: false, error: "expired_token", description: "승인 코드가 만료되었습니다. 로그인을 다시 시작하십시오." };
    }
    if (d.status === "denied") {
      return { ok: false, error: "access_denied", description: "교사가 브라우저에서 연결을 거부했습니다." };
    }
    const last = d.lastPolledAt ? Date.parse(d.lastPolledAt) : 0;
    d.lastPolledAt = new Date(now).toISOString();
    // 간격보다 1초 이상 빨리 다시 물으면 slow_down(네트워크 지연은 허용).
    if (last && now - last < (DEVICE_POLL_INTERVAL_SECONDS - 1) * 1000) {
      return { ok: false, error: "slow_down", description: `${DEVICE_POLL_INTERVAL_SECONDS}초 이상 간격을 두고 다시 확인하십시오.` };
    }
    if (d.status === "pending") {
      return { ok: false, error: "authorization_pending", description: "교사의 브라우저 승인을 기다리는 중입니다." };
    }

    // approved
    const user = db.users.find((u) => u.id === d.userId);
    if (!user || !isTeacher(user)) {
      d.status = "denied";
      return { ok: false, error: "access_denied", description: "승인한 계정이 교사 계정이 아닙니다." };
    }
    const { secret, hash: tokenHash, prefix } = generateSecret("cli");
    const token: CliToken = {
      id: newId("cli"),
      userId: user.id,
      tokenHash,
      tokenPrefix: prefix,
      label: deviceLabel(d),
      createdAt: nowIso(),
      lastUsedAt: null,
      revokedAt: null,
    };
    db.cliTokens.push(token);
    d.status = "consumed";
    writeAudit(db, user, "cli.token.issue", token.id, `${prefix} · 브라우저 승인 · ${token.label}`);
    return { ok: true, token: secret, user: { name: user.name, role: user.role, schoolLevel: user.schoolLevel } };
  });
}

/** user_code로 가장 최근 요청을 찾는다(만료된 코드는 다시 쓰일 수 있으므로 최신 것). */
function findByUserCode(db: DB, userCode: string): DeviceAuth | undefined {
  let found: DeviceAuth | undefined;
  for (const d of db.deviceAuths) {
    if (d.userCode === userCode && (!found || d.createdAt > found.createdAt)) found = d;
  }
  return found;
}

export async function getDeviceAuthByUserCode(userCode: string): Promise<DeviceView | null> {
  const code = normalizeUserCode(userCode);
  if (!code) return null;
  const d = findByUserCode(await readDb(), code);
  return d ? toView(d) : null;
}

/** 교사의 [승인]/[거부]. 서버 액션이 세션을 다시 확인한 뒤 호출한다. */
export async function decideDeviceAuth(
  user: User,
  userCode: string,
  decision: "approve" | "deny",
): Promise<DeviceResult<DeviceView>> {
  if (!isTeacher(user)) return fail(403, "forbidden", "교사 로그인이 필요합니다.");
  const code = normalizeUserCode(userCode);
  if (!code) return fail(400, "invalid_code", "코드 형식이 올바르지 않습니다.");
  return mutate((db) => {
    const d = findByUserCode(db, code);
    if (!d) return fail(404, "not_found", "코드를 찾을 수 없습니다.");
    if (d.status !== "pending") return fail(409, "already_decided", "이미 처리된 코드입니다.");
    if (isExpired(d)) return fail(410, "expired", "코드가 만료되었습니다.");
    d.status = decision === "approve" ? "approved" : "denied";
    d.userId = user.id;
    ensureUser(db, user);
    writeAudit(db, user, decision === "approve" ? "cli.device.approve" : "cli.device.deny", d.id, `${d.client} · ${d.hostname} · ${d.os}`);
    return { ok: true as const, value: toView(d) };
  });
}

/* ---------- 코드 입력 횟수 제한 (서버 메모리, 프로토타입) ---------- */

const g = globalThis as unknown as { __dandiDeviceLookups?: Map<string, number[]> };

function lookupLog(): Map<string, number[]> {
  g.__dandiDeviceLookups ??= new Map();
  return g.__dandiDeviceLookups;
}

function recentFailures(userId: string, now: number): number[] {
  const list = (lookupLog().get(userId) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  lookupLog().set(userId, list);
  return list;
}

/** 이 교사가 한 시간 안에 코드를 너무 많이 틀렸는가. */
export function codeLookupBlocked(userId: string): boolean {
  return recentFailures(userId, Date.now()).length >= FAILED_LOOKUPS_PER_HOUR;
}

/** 틀린 코드 입력을 기록한다. */
export function noteFailedCodeLookup(userId: string): void {
  const now = Date.now();
  recentFailures(userId, now).push(now);
}
