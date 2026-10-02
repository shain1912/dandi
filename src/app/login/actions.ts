"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isSchoolLevel } from "@/lib/constants";
import { mutate, newId, nowIso } from "@/lib/db";
import { safeNextPath } from "@/lib/origin";
import { hasPII } from "@/lib/pii";
import { getSessionId, rotateSession, userIdForSession, writeAudit } from "@/lib/session";
import { hashSecret } from "@/lib/tokens";
import type { DB, User } from "@/lib/types";

export type LoginState = { error?: string };

const NAME_MAX = 30;

function revokeSession(db: DB, sid: string | null): void {
  if (!sid) return;
  const hash = hashSecret(sid);
  for (const s of db.sessions) if (s.sidHash === hash && !s.revokedAt) s.revokedAt = nowIso();
}

/** 익명일 때 누른 좋아요를 로그인 계정으로 옮긴다. 이미 계정으로 누른 글은 중복을 지운다. */
function moveAnonLikes(db: DB, anonId: string, accountId: string): void {
  if (anonId === accountId) return;
  const liked = new Set(db.likes.filter((l) => l.userId === accountId).map((l) => l.postId));
  db.likes = db.likes.filter((l) => {
    if (l.userId !== anonId) return true;
    if (liked.has(l.postId)) return false;
    liked.add(l.postId);
    l.userId = accountId;
    return true;
  });
}

// 데모 로그인(F-02 대체). 실제 서비스에서는 Supabase Auth의 구글·카카오 로그인으로 바뀐다.
// 같은 이름·역할로 다시 로그인하면 같은 계정으로 들어간다(소셜 로그인과 같은 동작). 계정의 앱·글·토큰·키를 그대로 관리할 수 있다.
// 로그인할 때마다 새 쿠키를 발급하고 서버에 로그인 세션을 만든다. 이전 쿠키는 이 계정의 권한을 얻지 못한다.
export async function demoLogin(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const rawName = String(formData.get("name") ?? "").trim();
  const level = String(formData.get("schoolLevel") ?? "");
  const role = formData.get("role") === "admin" ? "admin" : "teacher";
  if (!rawName) return { error: "이름을 입력하십시오." };
  // 길이 검사를 개인정보 검사보다 먼저 한다. 매우 긴 입력으로 검사기를 오래 붙잡지 못하게 하기 위해서다.
  if (rawName.length > NAME_MAX) return { error: `이름은 ${NAME_MAX}자 이하로 입력하십시오.` };
  if (role === "teacher" && !isSchoolLevel(level)) return { error: "학교급을 선택하십시오." };
  // 이름은 계정을 찾는 열쇠이자 작성자 이름으로 공개되므로, 개인정보가 섞이면 가리지 않고 거절한다
  // (가리면 서로 다른 이름이 같은 "***" 계정으로 합쳐진다).
  if (hasPII(rawName)) return { error: "이름에 전화번호·이메일 등 개인정보로 보이는 내용이 있습니다. 이름만 입력하십시오." };
  const name = rawName;
  // 관리자는 학교급이 없다.
  const schoolLevel = role === "teacher" && isSchoolLevel(level) ? level : null;

  const oldSid = await getSessionId();
  const newSid = await rotateSession();
  await mutate((db) => {
    revokeSession(db, oldSid);
    let account: User | undefined = db.users.find((u) => u.role === role && u.name === name);
    if (account) {
      account.schoolLevel = schoolLevel;
    } else {
      account = { id: newId("u"), role, name, schoolLevel, createdAt: nowIso() };
      db.users.push(account);
    }
    db.sessions.push({ sidHash: hashSecret(newSid), userId: account.id, createdAt: nowIso(), revokedAt: null });
    if (oldSid) moveAnonLikes(db, userIdForSession(oldSid), account.id);
    writeAudit(db, account, "auth.demo_login", account.id, role);
  });
  revalidatePath("/", "layout");
  // /device(CLI 승인)·/oauth/authorize(MCP 연결)에서 로그인하러 온 경우 원래 화면으로 돌려보낸다.
  redirect(safeNextPath(String(formData.get("next") ?? "")) ?? "/studio");
}

// 로그아웃: 서버의 로그인 세션을 폐기하고 새 익명 쿠키로 바꾼다.
// 계정과 콘텐츠, 발급한 CLI 토큰·API 키는 그대로이며, 같은 이름·역할로 다시 로그인하면 관리할 수 있다.
export async function logout(): Promise<void> {
  const sid = await getSessionId();
  await mutate((db) => revokeSession(db, sid));
  await rotateSession();
  revalidatePath("/", "layout");
  redirect("/");
}
