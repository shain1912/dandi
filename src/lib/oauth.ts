import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, mutate, nowIso, readDb } from "./db";
import { maskPII } from "./pii";
import { isTeacher, writeAudit } from "./session";
import { generateSecret, hashSecret } from "./tokens";
import type { DB, OAuthClient, OAuthToken, User } from "./types";

// 원격 MCP(F-57)용 OAuth 2.1 인가 서버.
// - 동적 클라이언트 등록(RFC 7591, 공개 클라이언트만), PKCE S256 필수, 코드 10분·1회용
// - 접근 토큰 dd_mat_(1시간), 갱신 토큰 dd_mrt_(30일). 갱신할 때마다 새 갱신 토큰으로 바꾸고,
//   이미 바꾼(폐기된) 갱신 토큰이 다시 오면 탈취로 보고 그 연결(클라이언트 × 교사)의 토큰을 모두 폐기한다.
//   단, 바꾼 지 REFRESH_REUSE_GRACE_SEC(60초) 안에 같은 클라이언트가 같은 갱신 토큰을 다시 보내면(동시 갱신,
//   응답을 받지 못한 재시도) 연결을 끊지 않고 그때 발급한 후속 토큰 한 쌍을 그대로 다시 준다(아래 "갱신 유예").
//   공개 클라이언트는 갱신 요청에 client_id를 빼도 되므로(RFC 6749 3.2.1), client_id가 없으면 토큰을 받은 클라이언트로 본다.
// - 토큰·코드는 해시만 저장한다. 원문은 발급 응답에서 한 번만 돌려준다.
// - RFC 6749에 따라 error_description은 ASCII 영어로 쓴다. 교사가 보는 화면 문구는 한국어다.

export const OAUTH_SCOPE = "dandi";
export const ACCESS_TOKEN_TTL_SEC = 60 * 60;
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;
export const CODE_TTL_SEC = 10 * 60;
/** 방금 바꾼 갱신 토큰을 같은 클라이언트가 다시 보냈을 때 후속 토큰을 다시 주는 시간(초). 이 뒤의 재사용은 탈취로 본다. */
export const REFRESH_REUSE_GRACE_SEC = 60;

const CLIENT_NAME_MAX = 100;
const REDIRECT_URI_MAX = 2000;
const REDIRECT_URIS_MAX = 10;
const STATE_MAX = 1024;
/** 한 번도 쓰이지 않은 채 이 기간이 지난 클라이언트 등록은 지운다. */
const UNUSED_CLIENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 쓰이지 않은 클라이언트 등록 상한. 넘으면 새 등록을 잠시 받지 않는다(익명 등록으로 저장소를 채우지 못하게). */
const UNUSED_CLIENT_CAP = 2000;
/** 만료된 지 이만큼 지난 토큰·코드는 지운다. 폐기됐지만 아직 유효기간 안인 갱신 토큰은 재사용 감지를 위해 남긴다. */
const PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;

const CODE_CHALLENGE_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_target"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "temporarily_unavailable"
  | "access_denied"
  | "unsupported_response_type"
  | "server_error";

export type OAuthFailure = { ok: false; status: number; error: OAuthErrorCode; description: string };

function fail(status: number, error: OAuthErrorCode, description: string): OAuthFailure {
  return { ok: false, status, error, description };
}

/* ---------- 메타데이터 (RFC 9728, RFC 8414) ---------- */

export function mcpResourceUrl(hub: string): string {
  return `${hub}/mcp`;
}

export function protectedResourceMetadata(hub: string) {
  return {
    resource: mcpResourceUrl(hub),
    authorization_servers: [hub],
    bearer_methods_supported: ["header"],
    scopes_supported: [OAUTH_SCOPE],
    resource_name: "Dandi",
  };
}

export function authorizationServerMetadata(hub: string) {
  return {
    issuer: hub,
    authorization_endpoint: `${hub}/oauth/authorize`,
    token_endpoint: `${hub}/oauth/token`,
    registration_endpoint: `${hub}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

/** OAuth 메타데이터·등록·토큰 엔드포인트 공통 CORS 헤더. 쿠키를 쓰지 않으므로 모든 origin을 허용해도 안전하다. */
export const OAUTH_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

/**
 * 메타데이터 문서 응답. HUB_ORIGIN이 없으면 허브 주소를 요청의 Host로 만들므로(origin.ts), 공유 캐시·CDN이
 * 어떤 요청으로 만든 문서를 다른 사람에게 돌려주지 않도록 저장하지 못하게 한다(캐시 오염 방지).
 */
export function metadataResponse(body: object): Response {
  return Response.json(body, { headers: { ...OAUTH_CORS_HEADERS, "Cache-Control": "no-store" } });
}

/** 브라우저에서 동작하는 MCP 클라이언트(MCP Inspector 등)의 CORS 사전 요청 응답 */
export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}

/**
 * RFC 6749 형식 오류 응답. 토큰 엔드포인트 응답은 캐시하지 않는다.
 * 공개 클라이언트만 받아 Authorization 헤더 인증이 없으므로, invalid_client(401)에도 Basic 인증 요구 헤더를 붙이지 않는다.
 */
export function oauthErrorResponse(f: OAuthFailure): Response {
  const headers = { ...OAUTH_CORS_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache" };
  return Response.json({ error: f.error, error_description: f.description }, { status: f.status, headers });
}

/* ---------- 리다이렉트 URI 규칙 ---------- */

/** 등록할 수 있는 redirect_uri인가. 루프백(http://localhost:*, http://127.0.0.1:*) 또는 https만 허용한다. */
export function redirectUriProblem(uri: string): string | null {
  if (uri.length > REDIRECT_URI_MAX) return `redirect_uri must be at most ${REDIRECT_URI_MAX} characters`;
  if (/[\u0000-\u0020\u007f\\]/.test(uri)) return "redirect_uri must not contain spaces, control characters or backslashes";
  if (uri.includes("#")) return "redirect_uri must not contain a fragment";
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return "redirect_uri must be an absolute URL";
  }
  if (u.username || u.password) return "redirect_uri must not contain user credentials";
  if (u.protocol === "https:") return u.hostname ? null : "redirect_uri must have a host";
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return null;
  return "redirect_uri must use https, or http with localhost or 127.0.0.1";
}

function isLoopback(u: URL): boolean {
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

/**
 * 요청의 redirect_uri가 등록된 것과 같은가. 루프백 주소는 RFC 8252 7.3에 따라 포트만 달라도 허용한다
 * (Claude Code·Codex 같은 CLI는 실행할 때마다 빈 포트를 고른다).
 */
export function redirectUriMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(req) || requested.includes("#")) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return (
        isLoopback(reg) &&
        reg.hostname === req.hostname &&
        reg.pathname === req.pathname &&
        reg.search === req.search
      );
    } catch {
      return false;
    }
  });
}

/** 동의 화면·연결 목록에 보여 줄 돌아갈 주소(호스트). */
export function describeRedirect(uri: string): { host: string; local: boolean } {
  try {
    const u = new URL(uri);
    return { host: u.host, local: isLoopback(u) };
  } catch {
    return { host: uri.slice(0, 80), local: false };
  }
}

/** 응답 URL에 쿼리 값을 붙인다. 등록된 redirect_uri의 기존 쿼리는 그대로 둔다. */
function withParams(uri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

/* ---------- 동적 클라이언트 등록 (RFC 7591) ---------- */

export interface ClientRegistration {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
}

const DEFAULT_CLIENT_NAME = "이름을 밝히지 않은 AI 도구";

/** 도구가 스스로 밝힌 이름. 제어 문자를 지우고 길이를 먼저 자른 뒤 개인정보를 가린다. */
function cleanClientName(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_CLIENT_NAME;
  const trimmed = raw.slice(0, CLIENT_NAME_MAX * 2).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ");
  const short = trimmed.replace(/\s+/g, " ").trim().slice(0, CLIENT_NAME_MAX);
  if (!short) return DEFAULT_CLIENT_NAME;
  return maskPII(short).text;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return null;
  return value as string[];
}

function clientHasUse(db: DB, clientId: string): boolean {
  return db.oauthCodes.some((c) => c.clientId === clientId) || db.oauthTokens.some((t) => t.clientId === clientId);
}

/** 한 번도 쓰이지 않고 오래된 등록, 만료된 지 오래된 코드·토큰을 지운다. */
function prune(db: DB, now: number): void {
  const cutoff = new Date(now - PRUNE_GRACE_MS).toISOString();
  db.oauthCodes = db.oauthCodes.filter((c) => c.expiresAt > cutoff);
  db.oauthTokens = db.oauthTokens.filter((t) => t.expiresAt > cutoff);
  const clientCutoff = new Date(now - UNUSED_CLIENT_TTL_MS).toISOString();
  db.oauthClients = db.oauthClients.filter((c) => c.createdAt > clientCutoff || clientHasUse(db, c.clientId));
}

export async function registerClient(
  body: unknown,
): Promise<{ ok: true; value: ClientRegistration } | OAuthFailure> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail(400, "invalid_client_metadata", "request body must be a JSON object");
  }
  const input = body as Record<string, unknown>;

  const redirectUris = stringArray(input.redirect_uris);
  if (!redirectUris || redirectUris.length === 0) {
    return fail(400, "invalid_redirect_uri", "redirect_uris must be a non-empty array of strings");
  }
  if (redirectUris.length > REDIRECT_URIS_MAX) {
    return fail(400, "invalid_redirect_uri", `at most ${REDIRECT_URIS_MAX} redirect_uris are allowed`);
  }
  for (const uri of redirectUris) {
    const problem = redirectUriProblem(uri);
    if (problem) return fail(400, "invalid_redirect_uri", problem);
  }

  if (input.grant_types !== undefined) {
    const grants = stringArray(input.grant_types);
    if (!grants || !grants.includes("authorization_code") || grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
      return fail(400, "invalid_client_metadata", "grant_types must include authorization_code and may include refresh_token only");
    }
  }
  if (input.response_types !== undefined) {
    const types = stringArray(input.response_types);
    if (!types || types.some((t) => t !== "code")) {
      return fail(400, "invalid_client_metadata", "response_types must be [\"code\"]");
    }
  }
  // 공개 클라이언트만 받는다. 다른 인증 방식을 요청해도 RFC 7591 2절에 따라 "none"으로 등록하고 응답에 밝힌다.

  const client: OAuthClient = {
    clientId: `oc_${randomBytes(16).toString("hex")}`,
    clientName: cleanClientName(input.client_name),
    redirectUris: [...new Set(redirectUris)],
    createdAt: nowIso(),
  };

  const saved = await mutate((db) => {
    const now = Date.now();
    prune(db, now);
    const unused = db.oauthClients.filter((c) => !clientHasUse(db, c.clientId)).length;
    if (unused >= UNUSED_CLIENT_CAP) return false;
    db.oauthClients.push(client);
    return true;
  });
  if (!saved) return fail(503, "temporarily_unavailable", "too many pending client registrations; try again later");

  return {
    ok: true,
    value: {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  };
}

/* ---------- 인가 요청 (동의 화면) ---------- */

export const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
] as const;
export type AuthorizeParams = Partial<Record<(typeof AUTHORIZE_PARAMS)[number], string>>;

export interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
  resource: string | null;
  /** 동의 화면의 hidden 필드로 다시 보낼 원래 값 */
  params: AuthorizeParams;
}

/**
 * 인가 요청 검사 결과.
 * - page: 클라이언트나 redirect_uri를 믿을 수 없어 되돌려 보내면 안 되는 오류(화면에 표시)
 * - redirect: 클라이언트에게 돌려보낼 오류(RFC 6749 4.1.2.1). 등록은 누구나 할 수 있으므로 허브가 임의 사이트로
 *   보내는 통로가 되지 않도록, 루프백(이 컴퓨터) 주소일 때만 바로 보내고 나머지는 화면에서 링크로 보여 준다(RFC 9700 4.11.2).
 */
export type AuthorizeCheck =
  | { ok: true; request: AuthorizeRequest }
  | { ok: false; kind: "page"; message: string }
  | { ok: false; kind: "redirect"; url: string; local: boolean; host: string; message: string; detail: string };

/** searchParams·FormData에서 인가 요청 값만 꺼낸다(배열이면 무시해 모호한 요청을 거절한다). */
export function pickAuthorizeParams(get: (key: string) => unknown): AuthorizeParams {
  const out: AuthorizeParams = {};
  for (const key of AUTHORIZE_PARAMS) {
    const v = get(key);
    if (typeof v === "string" && v !== "") out[key] = v;
  }
  return out;
}

/** 동의 화면 경로(로그인 뒤 돌아올 곳). 값은 URLSearchParams로 인코딩하므로 safeNextPath를 통과한다. */
export function authorizePagePath(params: AuthorizeParams): string {
  return `/oauth/authorize?${new URLSearchParams(authorizeFields(params)).toString()}`;
}

/** 동의 화면 hidden 필드와 경로에 쓸 [이름, 값] 목록 */
export function authorizeFields(params: AuthorizeParams): [string, string][] {
  return Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string");
}

/** resource 값(RFC 8707)이 이 허브의 MCP 주소인가. 끝의 슬래시 하나는 무시한다. */
export function isOurResource(resource: string, hub: string): boolean {
  return resource.replace(/\/$/, "") === mcpResourceUrl(hub);
}

export async function validateAuthorizeRequest(params: AuthorizeParams, hub: string): Promise<AuthorizeCheck> {
  const clientId = params.client_id;
  if (!clientId || clientId.length > 100) {
    return { ok: false, kind: "page", message: "연결을 요청한 AI 도구 정보(client_id)가 없습니다. AI 도구에서 연결을 처음부터 다시 시작하십시오." };
  }
  const db = await readDb();
  const client = db.oauthClients.find((c) => c.clientId === clientId);
  if (!client) {
    return {
      ok: false,
      kind: "page",
      message: "등록되지 않았거나 오래되어 지워진 AI 도구입니다. AI 도구에서 Dandi 연결을 지우고 다시 추가하십시오.",
    };
  }

  let redirectUri = params.redirect_uri;
  if (!redirectUri) {
    if (client.redirectUris.length !== 1) {
      return { ok: false, kind: "page", message: "돌아갈 주소(redirect_uri)가 없습니다. AI 도구에서 연결을 다시 시작하십시오." };
    }
    redirectUri = client.redirectUris[0];
  }
  if (redirectUri.length > REDIRECT_URI_MAX || !redirectUriMatches(client.redirectUris, redirectUri)) {
    return {
      ok: false,
      kind: "page",
      message: "돌아갈 주소가 이 AI 도구에 등록된 주소와 다릅니다. 안전을 위해 연결을 멈췄습니다. 다른 사람이 보낸 링크라면 닫으십시오.",
    };
  }
  const state = params.state ?? null;
  if (state && state.length > STATE_MAX) {
    return { ok: false, kind: "page", message: "요청 값(state)이 너무 깁니다. AI 도구에서 연결을 다시 시작하십시오." };
  }

  const target = describeRedirect(redirectUri);
  const back = (error: OAuthErrorCode, description: string): AuthorizeCheck => ({
    ok: false,
    kind: "redirect",
    url: withParams(redirectUri, { error, error_description: description, state, iss: hub }),
    local: target.local,
    host: target.host,
    message: "AI 도구가 보낸 연결 요청의 형식이 올바르지 않아 승인할 수 없습니다. AI 도구를 최신 버전으로 바꾼 뒤 다시 연결하십시오.",
    detail: `${error}: ${description}`,
  });
  if (params.response_type !== "code") return back("unsupported_response_type", "response_type must be code");
  if (!params.code_challenge) return back("invalid_request", "code_challenge is required (PKCE S256)");
  if (params.code_challenge_method !== "S256") return back("invalid_request", "code_challenge_method must be S256");
  if (!CODE_CHALLENGE_RE.test(params.code_challenge)) return back("invalid_request", "code_challenge is malformed");
  const resource = params.resource ?? null;
  if (resource && (resource.length > REDIRECT_URI_MAX || !isOurResource(resource, hub))) {
    return back("invalid_target", "resource must be this hub's MCP endpoint");
  }

  return {
    ok: true,
    request: {
      client,
      redirectUri,
      state,
      codeChallenge: params.code_challenge,
      // 권한은 "dandi" 하나뿐이다. 요청한 scope와 관계없이 이것만 주고 토큰 응답에 밝힌다(RFC 6749 3.3).
      scope: OAUTH_SCOPE,
      resource: resource ? mcpResourceUrl(hub) : null,
      params,
    },
  };
}

/** 교사가 [허용]을 눌렀다. 코드를 만들고 돌아갈 주소(code, state, iss 포함)를 돌려준다. */
export async function approveAuthorization(user: User, req: AuthorizeRequest, hub: string): Promise<string> {
  if (!isTeacher(user)) throw new Error("teacher session required");
  const code = randomBytes(32).toString("base64url");
  const now = Date.now();
  await mutate((db) => {
    prune(db, now);
    db.oauthCodes.push({
      codeHash: hashSecret(code),
      clientId: req.client.clientId,
      userId: user.id,
      redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge,
      scope: req.scope,
      resource: req.resource,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CODE_TTL_SEC * 1000).toISOString(),
      usedAt: null,
    });
    writeAudit(db, user, "oauth.authorize.approve", req.client.clientId, `${req.client.clientName} → ${describeRedirect(req.redirectUri).host}`);
  });
  return withParams(req.redirectUri, { code, state: req.state, iss: hub });
}

/** 교사가 [거부]를 눌렀다. access_denied로 돌려보낸다. */
export async function denyAuthorization(user: User, req: AuthorizeRequest, hub: string): Promise<string> {
  await mutate((db) => {
    writeAudit(db, user, "oauth.authorize.deny", req.client.clientId, `${req.client.clientName} → ${describeRedirect(req.redirectUri).host}`);
  });
  return withParams(req.redirectUri, {
    error: "access_denied",
    error_description: "the teacher denied the request",
    state: req.state,
    iss: hub,
  });
}

/* ---------- 토큰 엔드포인트 ---------- */

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

type TokenResult = { ok: true; value: TokenResponse } | OAuthFailure;

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** 연결(클라이언트 × 교사)의 모든 토큰을 폐기하고, 아직 쓰지 않은 코드도 못 쓰게 한다. 폐기한 토큰 수를 돌려준다. */
function revokeFamily(db: DB, clientId: string, userId: string, at: string): number {
  let count = 0;
  for (const t of db.oauthTokens) {
    if (t.clientId === clientId && t.userId === userId && !t.revokedAt) {
      t.revokedAt = at;
      count++;
    }
  }
  for (const c of db.oauthCodes) if (c.clientId === clientId && c.userId === userId && !c.usedAt) c.usedAt = at;
  return count;
}

/* ---------- 갱신 유예 ---------- */

/**
 * 회전한 갱신 토큰 행에 더 적는 값(db.json에 함께 저장된다).
 * rotatedAt: 새 토큰으로 바꾼 시각(연결 폐기로 막힌 토큰에는 없다), successorIds: 그때 발급한 접근·갱신 토큰 행 id.
 */
type RotatedRefreshRow = OAuthToken & {
  rotatedAt?: string | null;
  successorIds?: { access: string; refresh: string } | null;
};

let rotationKeyCache: Buffer | null = null;

/**
 * 후속 토큰을 만드는 서버 비밀 키. DANDI_OAUTH_SECRET(32자 이상)이 있으면 그 값을, 없으면
 * DATA_DIR/oauth-rotation.key(처음 쓸 때 무작위로 만들고 0600)를 쓴다. 여러 프로세스가 같은 DATA_DIR을 쓰면 같은 키를 읽는다.
 */
function rotationKey(): Buffer {
  if (rotationKeyCache) return rotationKeyCache;
  const env = process.env.DANDI_OAUTH_SECRET;
  if (env && env.length >= 32) {
    rotationKeyCache = createHash("sha256").update(`dandi-oauth-rotation\n${env}`).digest();
    return rotationKeyCache;
  }
  const file = path.join(DATA_DIR, "oauth-rotation.key");
  const readKey = (): Buffer | null => {
    try {
      const key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
      return key.length === 32 ? key : null;
    } catch {
      return null;
    }
  };
  let key = readKey();
  if (!key) {
    const fresh = randomBytes(32);
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(file, fresh.toString("hex"), { flag: "wx", mode: 0o600 });
      key = fresh;
    } catch {
      // 다른 프로세스가 먼저 만들었으면 그 키를 읽는다. 그래도 못 읽으면 이 프로세스에서만 쓰는 키로 둔다.
      key = readKey() ?? fresh;
    }
  }
  rotationKeyCache = key;
  return key;
}

/**
 * 회전할 때 발급하는 후속 토큰 원문. 이전 갱신 토큰 원문과 서버 키로 정해지므로 원문을 저장하지 않고도
 * 유예 시간 안에 같은 갱신 토큰이 다시 오면 같은 한 쌍을 다시 만들어 줄 수 있다.
 * 서버 키가 없으면 이전 갱신 토큰을 가진 사람도 후속 토큰을 미리 계산할 수 없다.
 */
function successorSecret(key: Buffer, previousRefresh: string, kind: "mat" | "mrt"): { secret: string; hash: string } {
  const mac = createHmac("sha256", key).update(`dandi-oauth-successor/v1/${kind}/${previousRefresh}`).digest();
  const secret = `dd_${kind}_${mac.subarray(0, 24).toString("base64url")}`;
  return { secret, hash: hashSecret(secret) };
}

function successorPair(previousRefresh: string): { access: { secret: string; hash: string }; refresh: { secret: string; hash: string } } {
  const key = rotationKey();
  return { access: successorSecret(key, previousRefresh, "mat"), refresh: successorSecret(key, previousRefresh, "mrt") };
}

/**
 * 유예 시간 안의 재요청이면 이미 발급한 후속 토큰 한 쌍을 돌려준다. 후속 토큰이 이미 폐기·회전되었거나
 * 만료되었거나 다시 만든 값이 저장된 해시와 다르면 null(호출한 쪽이 재사용으로 처리한다).
 */
function replaySuccessor(
  db: DB,
  row: RotatedRefreshRow,
  pair: ReturnType<typeof successorPair>,
  now: number,
): TokenResponse | null {
  const ids = row.successorIds;
  if (!ids || !row.rotatedAt) return null;
  const at = new Date(now).toISOString();
  const access = db.oauthTokens.find((t) => t.id === ids.access && t.kind === "access");
  const refresh = db.oauthTokens.find((t) => t.id === ids.refresh && t.kind === "refresh");
  if (!access || !refresh) return null;
  if (access.revokedAt || refresh.revokedAt || access.expiresAt <= at || refresh.expiresAt <= at) return null;
  if (access.tokenHash !== pair.access.hash || refresh.tokenHash !== pair.refresh.hash) return null;
  return {
    access_token: pair.access.secret,
    token_type: "Bearer",
    expires_in: Math.max(1, Math.floor((Date.parse(access.expiresAt) - now) / 1000)),
    refresh_token: pair.refresh.secret,
    scope: refresh.scope,
  };
}

function issueTokens(
  db: DB,
  clientId: string,
  userId: string,
  scope: string,
  now: number,
  secrets?: ReturnType<typeof successorPair>,
): TokenResponse & { ids: { access: string; refresh: string } } {
  const access = secrets?.access ?? generateSecret("mat");
  const refresh = secrets?.refresh ?? generateSecret("mrt");
  const created = new Date(now).toISOString();
  const base = { clientId, userId, scope, createdAt: created, revokedAt: null, lastUsedAt: null };
  const accessRow: OAuthToken = {
    ...base,
    id: `oat_${randomBytes(8).toString("hex")}`,
    kind: "access",
    tokenHash: access.hash,
    expiresAt: new Date(now + ACCESS_TOKEN_TTL_SEC * 1000).toISOString(),
  };
  const refreshRow: OAuthToken = {
    ...base,
    id: `ort_${randomBytes(8).toString("hex")}`,
    kind: "refresh",
    tokenHash: refresh.hash,
    expiresAt: new Date(now + REFRESH_TOKEN_TTL_SEC * 1000).toISOString(),
  };
  db.oauthTokens.push(accessRow, refreshRow);
  return {
    access_token: access.secret,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: refresh.secret,
    scope,
    ids: { access: accessRow.id, refresh: refreshRow.id },
  };
}

/** 응답 본문에는 행 id를 넣지 않는다. */
function tokenBody(t: TokenResponse): TokenResponse {
  return {
    access_token: t.access_token,
    token_type: t.token_type,
    expires_in: t.expires_in,
    refresh_token: t.refresh_token,
    scope: t.scope,
  };
}

function scopeProblem(requested: string | undefined, granted: string): boolean {
  if (!requested) return false;
  const allowed = new Set(granted.split(" "));
  return requested.split(/\s+/).filter(Boolean).some((s) => !allowed.has(s));
}

export interface TokenRequest {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  client_id?: string;
  code_verifier?: string;
  refresh_token?: string;
  scope?: string;
  resource?: string;
}

/** POST /oauth/token 본문(이미 파싱한 값)을 처리한다. */
export async function handleTokenRequest(input: TokenRequest, hub: string): Promise<TokenResult> {
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string" && v.length > 4096) return fail(400, "invalid_request", `${k} is too long`);
  }
  if (input.resource && !isOurResource(input.resource, hub)) {
    return fail(400, "invalid_target", "resource must be this hub's MCP endpoint");
  }
  if (input.grant_type === "authorization_code") return exchangeCode(input);
  if (input.grant_type === "refresh_token") return refreshTokens(input);
  if (!input.grant_type) return fail(400, "invalid_request", "grant_type is required");
  return fail(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

async function exchangeCode(input: TokenRequest): Promise<TokenResult> {
  const { code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier } = input;
  if (!code) return fail(400, "invalid_request", "code is required");
  if (!clientId) return fail(400, "invalid_request", "client_id is required");
  if (!redirectUri) return fail(400, "invalid_request", "redirect_uri is required");
  if (!verifier) return fail(400, "invalid_request", "code_verifier is required (PKCE)");
  if (!CODE_VERIFIER_RE.test(verifier)) return fail(400, "invalid_grant", "code_verifier is malformed");
  const codeHash = hashSecret(code);

  return mutate((db): TokenResult => {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const client = db.oauthClients.find((c) => c.clientId === clientId);
    if (!client) return fail(401, "invalid_client", "unknown client_id");
    const row = db.oauthCodes.find((c) => c.codeHash === codeHash);
    if (!row) return fail(400, "invalid_grant", "authorization code is invalid");
    if (row.usedAt) {
      // 이미 쓴 코드가 다시 왔다: 이 코드로 발급한 토큰이 새어 나갔을 수 있으므로 연결 전체를 폐기한다(RFC 6749 4.1.2).
      const revoked = revokeFamily(db, row.clientId, row.userId, at);
      const user = db.users.find((u) => u.id === row.userId);
      if (user && revoked > 0) writeAudit(db, user, "oauth.code.reuse", row.clientId, `토큰 ${revoked}개 폐기`);
      return fail(400, "invalid_grant", "authorization code was already used");
    }
    if (row.expiresAt <= at) return fail(400, "invalid_grant", "authorization code expired");
    if (row.clientId !== clientId) return fail(400, "invalid_grant", "authorization code was issued to another client");
    if (row.redirectUri !== redirectUri) return fail(400, "invalid_grant", "redirect_uri does not match the authorization request");
    if (!safeEqual(s256(verifier), row.codeChallenge)) return fail(400, "invalid_grant", "code_verifier does not match code_challenge");
    const user = db.users.find((u) => u.id === row.userId);
    row.usedAt = at;
    if (!user || !isTeacher(user)) return fail(400, "invalid_grant", "the approving account can no longer use Dandi");
    prune(db, now);
    const tokens = issueTokens(db, clientId, user.id, row.scope, now);
    writeAudit(db, user, "oauth.token.issue", clientId, client.clientName);
    return { ok: true, value: tokenBody(tokens) };
  });
}

async function refreshTokens(input: TokenRequest): Promise<TokenResult> {
  const { refresh_token: refreshToken, client_id: clientId } = input;
  if (!refreshToken) return fail(400, "invalid_request", "refresh_token is required");
  if (!refreshToken.startsWith("dd_mrt_")) return fail(400, "invalid_grant", "refresh_token is invalid");
  const hash = hashSecret(refreshToken);
  // 이 갱신 토큰으로 발급할(또는 이미 발급한) 후속 토큰 한 쌍
  const pair = successorPair(refreshToken);

  return mutate((db): TokenResult => {
    const now = Date.now();
    const at = new Date(now).toISOString();
    // 지워진 클라이언트면 invalid_client를 돌려준다. MCP 클라이언트는 이때 다시 등록하고 처음부터 인가를 받는다.
    if (clientId && !db.oauthClients.some((c) => c.clientId === clientId)) {
      return fail(401, "invalid_client", "unknown client_id");
    }
    const row: RotatedRefreshRow | undefined = db.oauthTokens.find((t) => t.kind === "refresh" && t.tokenHash === hash);
    if (!row) return fail(400, "invalid_grant", "refresh_token is invalid");
    if (clientId && clientId !== row.clientId) return fail(400, "invalid_grant", "refresh_token was issued to another client");
    // 공개 클라이언트는 갱신 요청에 client_id를 빼도 된다(RFC 6749 3.2.1, 6). 갱신 토큰은 발급받은 클라이언트에
    // 묶여 있으므로, client_id가 없으면 그 토큰의 클라이언트가 보낸 것으로 보고 유예 규칙을 똑같이 적용한다.
    const sameClient = (clientId || row.clientId) === row.clientId && db.oauthClients.some((c) => c.clientId === row.clientId);
    if (row.revokedAt && row.rotatedAt && sameClient) {
      // 갱신 유예: 방금(60초 안) 회전한 토큰을 같은 클라이언트가 다시 보냈다. 동시에 보낸 갱신 요청이거나
      // 응답을 받지 못해 다시 보낸 요청이므로, 연결을 끊지 않고 그때 발급한 후속 토큰을 그대로 다시 준다.
      const age = now - Date.parse(row.rotatedAt);
      if (age >= 0 && age <= REFRESH_REUSE_GRACE_SEC * 1000) {
        const replay = replaySuccessor(db, row, pair, now);
        if (replay) return { ok: true, value: replay };
      }
    }
    if (row.revokedAt) {
      // 이미 바꾼(또는 폐기한) 갱신 토큰의 재사용: 탈취 가능성이 있으므로 이 연결의 토큰을 모두 폐기한다.
      const revoked = revokeFamily(db, row.clientId, row.userId, at);
      const user = db.users.find((u) => u.id === row.userId);
      if (user && revoked > 0) writeAudit(db, user, "oauth.refresh.reuse", row.clientId, `토큰 ${revoked}개 폐기`);
      return fail(400, "invalid_grant", "refresh_token was already used or revoked");
    }
    if (row.expiresAt <= at) return fail(400, "invalid_grant", "refresh_token expired");
    if (scopeProblem(input.scope, row.scope)) return fail(400, "invalid_scope", "requested scope exceeds the original grant");
    const user = db.users.find((u) => u.id === row.userId);
    const client = db.oauthClients.find((c) => c.clientId === row.clientId);
    if (!user || !isTeacher(user) || !client) {
      revokeFamily(db, row.clientId, row.userId, at);
      return fail(400, "invalid_grant", "the connection is no longer valid");
    }
    // 후속 토큰이 이미 있으면(이론상 없음) 무작위 토큰으로 발급해 해시가 겹치지 않게 한다.
    const taken = db.oauthTokens.some((t) => t.tokenHash === pair.access.hash || t.tokenHash === pair.refresh.hash);
    const issued = issueTokens(db, row.clientId, row.userId, row.scope, now, taken ? undefined : pair);
    row.revokedAt = at;
    row.rotatedAt = taken ? null : at;
    row.successorIds = taken ? null : issued.ids;
    prune(db, now);
    return { ok: true, value: tokenBody(issued) };
  });
}

/* ---------- 연결 목록·폐기 (/oauth/connections) ---------- */

export interface OAuthConnection {
  clientId: string;
  clientName: string;
  redirectHosts: { host: string; local: boolean }[];
  firstSeenAt: string;
  lastUsedAt: string | null;
  status: "active" | "expired" | "revoked";
  revokedAt: string | null;
}

function uniqueHosts(uris: string[]): { host: string; local: boolean }[] {
  const seen = new Map<string, { host: string; local: boolean }>();
  for (const u of uris) {
    const d = describeRedirect(u);
    if (!seen.has(d.host)) seen.set(d.host, d);
  }
  return [...seen.values()];
}

function maxIso(values: (string | null)[]): string | null {
  return values.reduce<string | null>((m, v) => (v && (!m || v > m) ? v : m), null);
}

/** 교사 한 명의 연결(클라이언트별로 묶은 토큰) 목록. 사용 중인 연결이 먼저 온다. */
export async function listConnections(userId: string): Promise<OAuthConnection[]> {
  const db = await readDb();
  const at = nowIso();
  const byClient = new Map<string, OAuthToken[]>();
  for (const t of db.oauthTokens) {
    if (t.userId !== userId) continue;
    const list = byClient.get(t.clientId) ?? [];
    list.push(t);
    byClient.set(t.clientId, list);
  }
  const out: OAuthConnection[] = [];
  for (const [clientId, tokens] of byClient) {
    const client = db.oauthClients.find((c) => c.clientId === clientId);
    const live = tokens.some((t) => !t.revokedAt && t.expiresAt > at);
    const allRevoked = tokens.every((t) => t.revokedAt);
    out.push({
      clientId,
      clientName: client?.clientName ?? "삭제된 AI 도구",
      redirectHosts: uniqueHosts(client?.redirectUris ?? []),
      firstSeenAt: tokens.reduce((m, t) => (t.createdAt < m ? t.createdAt : m), tokens[0].createdAt),
      lastUsedAt: maxIso(tokens.map((t) => (t.kind === "access" ? t.lastUsedAt : t.createdAt))),
      status: live ? "active" : allRevoked ? "revoked" : "expired",
      revokedAt: live ? null : maxIso(tokens.map((t) => t.revokedAt)),
    });
  }
  const rank = { active: 0, expired: 1, revoked: 2 } as const;
  return out.sort(
    (a, b) => rank[a.status] - rank[b.status] || (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""),
  );
}

/** 교사가 연결을 끊는다. 그 도구의 접근·갱신 토큰을 즉시 모두 폐기한다. */
export async function revokeConnection(user: User, clientId: string): Promise<number> {
  if (!isTeacher(user) || !clientId) return 0;
  return mutate((db) => {
    const client = db.oauthClients.find((c) => c.clientId === clientId);
    const count = revokeFamily(db, clientId, user.id, nowIso());
    if (count > 0) writeAudit(db, user, "oauth.connection.revoke", clientId, client?.clientName ?? "");
    return count;
  });
}
