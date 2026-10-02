import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "./constants";
import { mutate, nowIso, readDb } from "./db";
import { bearerToken, generateSessionId, hashSecret } from "./tokens";
import type { DB, User } from "./types";

// 익명 우선 세션(F-01). proxy.ts가 모든 방문자에게 dd_sid 쿠키(비밀값)를 발급한다.
// - 익명 방문자의 id는 세션 값의 해시다(좋아요 등 익명 활동용). 되돌려 세션 값을 알아낼 수 없다.
// - 로그인 계정의 id는 무작위 공개 id이고, 쿠키와 계정은 서버의 로그인 세션(db.sessions)으로 연결한다.
//   로그인·로그아웃 때마다 쿠키를 새로 발급하고, 로그아웃한 세션은 서버에서 폐기한다.

export class AuthError extends Error {}

function anonUser(id: string): User {
  return { id, role: "anon", name: null, schoolLevel: null, createdAt: nowIso() };
}

/** 세션 값에서 익명 방문자 id를 만든다. 되돌려 세션 값을 알아낼 수 없다. */
export function userIdForSession(sid: string): string {
  return `u_${hashSecret(sid).slice(0, 24)}`;
}

export async function getSessionId(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

/**
 * 새 세션 값을 발급하고 쿠키를 바꾼다. 서버 액션·라우트 핸들러에서만 호출할 수 있다.
 * 반환값은 새 세션 값(비밀값)이다. 저장할 때는 hashSecret으로 해시만 저장한다.
 */
export async function rotateSession(): Promise<string> {
  const sid = generateSessionId();
  const store = await cookies();
  store.set({
    name: SESSION_COOKIE,
    value: sid,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return sid;
}

/** 세션 값이 가리키는 사용자. 폐기되지 않은 로그인 세션이면 계정, 아니면 익명 방문자. */
export function userForSession(db: DB, sid: string): User {
  const hash = hashSecret(sid);
  const session = db.sessions.find((s) => s.sidHash === hash && !s.revokedAt);
  const account = session && db.users.find((u) => u.id === session.userId);
  if (account) return account;
  const anonId = userIdForSession(sid);
  return db.users.find((u) => u.id === anonId && u.role === "anon") ?? anonUser(anonId);
}

/** 현재 방문자. 로그인하지 않았으면 익명 사용자 객체를 돌려준다(DB에 쓰지 않음). */
export async function getCurrentUser(): Promise<User> {
  const sid = await getSessionId();
  if (!sid) return anonUser("anon_unknown");
  return userForSession(await readDb(), sid);
}

export function isTeacher(user: User): boolean {
  return user.role === "teacher" || user.role === "admin";
}

export async function requireTeacher(): Promise<User> {
  const user = await getCurrentUser();
  if (!isTeacher(user)) throw new AuthError("교사 로그인이 필요합니다.");
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await getCurrentUser();
  if (user.role !== "admin") throw new AuthError("교육청 관리자만 사용할 수 있습니다.");
  return user;
}

/** mutate 안에서 사용자 레코드가 없으면 만든다(익명 사용자가 좋아요를 누를 때 등). */
export function ensureUser(db: DB, user: User): User {
  const existing = db.users.find((u) => u.id === user.id);
  if (existing) return existing;
  db.users.push(user);
  return user;
}

export function displayName(user: User): string {
  return user.name ?? "익명";
}

/** CLI 요청용: Authorization: Bearer dd_cli_... 토큰으로 사용자를 찾는다(F-17). */
export async function userFromCliToken(req: Request): Promise<User | null> {
  const token = bearerToken(req);
  if (!token || !token.startsWith("dd_cli_")) return null;
  const hash = hashSecret(token);
  const db = await readDb();
  const t = db.cliTokens.find((x) => x.tokenHash === hash && !x.revokedAt);
  if (!t) return null;
  // 요청마다 저장소 전체를 다시 쓰지 않도록 마지막 사용 시각은 5분에 한 번만 기록한다.
  const now = nowIso();
  if (!t.lastUsedAt || Date.parse(now) - Date.parse(t.lastUsedAt) > 5 * 60 * 1000) {
    await mutate((w) => {
      const x = w.cliTokens.find((c) => c.id === t.id);
      if (x) x.lastUsedAt = now;
    });
  }
  return db.users.find((u) => u.id === t.userId) ?? null;
}

export function writeAudit(
  db: DB,
  actor: User,
  action: string,
  target: string,
  detail = "",
): void {
  db.audit.push({
    id: `aud_${db.audit.length + 1}_${Date.now().toString(36)}`,
    actorId: actor.id,
    actorName: displayName(actor),
    action,
    target,
    detail,
    createdAt: nowIso(),
  });
}
