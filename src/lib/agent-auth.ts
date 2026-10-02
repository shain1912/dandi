import "server-only";
import { mutate, nowIso, readDb } from "./db";
import { isTeacher } from "./session";
import { bearerToken, hashSecret } from "./tokens";
import type { User } from "./types";

// AI 에이전트·CLI 요청 공통 인증(F-53, F-57).
// - dd_cli_ : CLI 토큰(브라우저 승인 로그인 또는 /studio/cli 발급)
// - dd_mat_ : 원격 MCP OAuth 접근 토큰
// 두 경우 모두 교사·관리자 계정만 통과한다. 프로젝트 API 키(dd_sk_)는 AI 게이트웨이 전용이라 여기서 받지 않는다.

const LAST_USED_WRITE_MS = 5 * 60 * 1000;

export type AgentAuth =
  | { ok: true; user: User; via: "cli" | "oauth"; tokenId: string }
  | { ok: false; status: 401 | 403; code: string; message: string };

export async function authenticateAgent(req: Request): Promise<AgentAuth> {
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, code: "unauthorized", message: "로그인이 필요합니다." };
  const via = token.startsWith("dd_cli_") ? "cli" : token.startsWith("dd_mat_") ? "oauth" : null;
  if (!via) return { ok: false, status: 401, code: "invalid_token", message: "알 수 없는 토큰 형식입니다." };
  const hash = hashSecret(token);
  const now = nowIso();

  // 읽기 스냅샷으로 인증한다. 요청마다 db.json 전체를 다시 쓰지 않도록 마지막 사용 시각은 5분에 한 번만 기록한다.
  const db = await readDb();
  const record =
    via === "cli"
      ? db.cliTokens.find((x) => x.tokenHash === hash && !x.revokedAt)
      : db.oauthTokens.find((x) => x.kind === "access" && x.tokenHash === hash && !x.revokedAt && x.expiresAt > now);
  const found = record ? { user: db.users.find((u) => u.id === record.userId) ?? null, tokenId: record.id } : null;
  if (record && (!record.lastUsedAt || Date.parse(now) - Date.parse(record.lastUsedAt) > LAST_USED_WRITE_MS)) {
    await mutate((w) => {
      const t = via === "cli" ? w.cliTokens.find((x) => x.id === record.id) : w.oauthTokens.find((x) => x.id === record.id);
      if (t) t.lastUsedAt = now;
    });
  }

  if (!found || !found.user) {
    return { ok: false, status: 401, code: "invalid_token", message: "토큰이 없거나 만료·폐기되었습니다." };
  }
  if (!isTeacher(found.user)) {
    return { ok: false, status: 403, code: "forbidden", message: "교사·관리자 계정만 사용할 수 있습니다." };
  }
  return { ok: true, user: found.user, via, tokenId: found.tokenId };
}

/** 새 API 공통 오류 형식: { error: { code, message, hint? } } */
export function apiError(status: number, code: string, message: string, hint?: string, headers?: HeadersInit): Response {
  return Response.json({ error: { code, message, ...(hint ? { hint } : {}) } }, { status, headers });
}

/** authenticateAgent 실패를 응답으로 바꾼다. 401이면 CLI 로그인 안내를 hint로 붙인다. */
export function agentAuthError(auth: Extract<AgentAuth, { ok: false }>): Response {
  const hint = auth.status === 401 ? "dandi login 으로 다시 로그인하십시오." : undefined;
  const headers: HeadersInit = auth.status === 401 ? { "WWW-Authenticate": "Bearer" } : {};
  return apiError(auth.status, auth.code, auth.message, hint, headers);
}
