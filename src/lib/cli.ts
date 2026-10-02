import "server-only";
import type { Result } from "./apps";
import { isAppCategory, isSchoolLevel } from "./constants";
import { mutate, newId, nowIso, readDb } from "./db";
import { AuthError, ensureUser, isTeacher, userFromCliToken, writeAudit } from "./session";
import { generateSecret } from "./tokens";
import type { CliToken, NewAppInput, User } from "./types";

// CLI 토큰(F-17)과 CLI 요청 처리(F-18) 도우미.
// 토큰 원문은 발급 순간 한 번만 돌려주고 DB에는 해시와 앞부분만 저장한다.

/** 화면에 내보내는 토큰 정보. 해시는 밖으로 내보내지 않는다. */
export type CliTokenView = Omit<CliToken, "tokenHash">;

function toView(t: CliToken): CliTokenView {
  return {
    id: t.id,
    userId: t.userId,
    tokenPrefix: t.tokenPrefix,
    label: t.label ?? null,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
  };
}

export async function issueCliToken(user: User): Promise<{ secret: string; token: CliTokenView }> {
  if (!isTeacher(user)) throw new AuthError("교사 로그인이 필요합니다.");
  const { secret, hash, prefix } = generateSecret("cli");
  const token: CliToken = {
    id: newId("cli"),
    userId: user.id,
    tokenHash: hash,
    tokenPrefix: prefix,
    createdAt: nowIso(),
    lastUsedAt: null,
    revokedAt: null,
  };
  await mutate((db) => {
    ensureUser(db, user);
    db.cliTokens.push(token);
    writeAudit(db, user, "cli.token.issue", token.id, prefix);
  });
  return { secret, token: toView(token) };
}

export async function listCliTokens(userId: string): Promise<CliTokenView[]> {
  const db = await readDb();
  return db.cliTokens
    .filter((t) => t.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toView);
}

/** 본인 토큰만 폐기할 수 있다. 이미 폐기된 토큰은 그대로 둔다. */
export async function revokeCliToken(user: User, id: string): Promise<Result<null>> {
  return mutate((db) => {
    const t = db.cliTokens.find((x) => x.id === id && x.userId === user.id);
    if (!t) return { ok: false, error: "토큰을 찾을 수 없습니다." } as const;
    if (!t.revokedAt) {
      t.revokedAt = nowIso();
      writeAudit(db, user, "cli.token.revoke", t.id, t.tokenPrefix);
    }
    return { ok: true, value: null } as const;
  });
}

/* ---------- CLI API 공통 ---------- */

export function jsonError(status: number, error: string): Response {
  const headers: HeadersInit = status === 401 ? { "WWW-Authenticate": "Bearer" } : {};
  return Response.json({ error }, { status, headers });
}

/** Authorization: Bearer dd_cli_... 를 확인한다. 교사·관리자 계정의 토큰만 통과한다. */
export async function authenticateCli(
  req: Request,
): Promise<{ ok: true; user: User } | { ok: false; response: Response }> {
  const user = await userFromCliToken(req);
  if (!user) {
    return {
      ok: false,
      response: jsonError(
        401,
        "CLI 토큰이 없거나 유효하지 않습니다. 허브의 /studio/cli에서 토큰을 발급한 뒤 dandi login을 다시 실행하십시오.",
      ),
    };
  }
  if (!isTeacher(user)) {
    return {
      ok: false,
      response: jsonError(
        403,
        "교사 계정의 토큰만 사용할 수 있습니다. 허브에서 교사로 다시 로그인한 뒤 토큰을 새로 발급하십시오.",
      ),
    };
  }
  return { ok: true, user };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const MAX_DESCRIPTION = 2000;
const MAX_PRIVACY_TEXT = 200;

/**
 * CLI가 보낸 JSON 본문을 NewAppInput으로 좁힌다. 여기서는 형식(타입)만 검사하고,
 * 내용 규칙(필수 입력, URL, 셀프점검 조건)은 웹 폼과 같은 validateNewApp이 검사한다.
 */
export function parseNewAppInput(body: unknown): Result<NewAppInput> {
  const fail = (error: string) => ({ ok: false, error }) as const;
  if (!isRecord(body)) return fail("요청 본문은 JSON 객체여야 합니다.");

  const { title, url, schoolLevels, category, privacyCheck } = body;
  const description = body.description ?? "";
  if (typeof title !== "string") return fail("title 항목(앱 이름)은 문자열이어야 합니다.");
  if (typeof description !== "string") return fail("description 항목(설명)은 문자열이어야 합니다.");
  if (description.length > MAX_DESCRIPTION) {
    return fail(`description 항목(설명)은 ${MAX_DESCRIPTION}자 이하로 입력하십시오.`);
  }
  if (typeof url !== "string") return fail("url 항목(배포 URL)은 문자열이어야 합니다.");
  if (!Array.isArray(schoolLevels) || !schoolLevels.every(isSchoolLevel)) {
    return fail("schoolLevels 항목은 elem, middle, high, special 중 하나 이상을 담은 배열이어야 합니다.");
  }
  if (!isAppCategory(category)) {
    return fail("category 항목은 class, work, guidance, etc 중 하나여야 합니다.");
  }
  if (!isRecord(privacyCheck)) {
    return fail("privacyCheck 항목(배포 전 개인정보 셀프점검)이 필요합니다.");
  }
  const { collectsStudentData, storageLocation, retention, externalTransfer, needsSchoolApproval } =
    privacyCheck;
  const notBool = (key: string) => fail(`privacyCheck.${key} 항목은 true 또는 false여야 합니다.`);
  const notText = (key: string) => fail(`privacyCheck.${key} 항목은 문자열이어야 합니다.`);
  const tooLong = (key: string) =>
    fail(`privacyCheck.${key} 항목은 ${MAX_PRIVACY_TEXT}자 이하로 입력하십시오.`);
  if (typeof collectsStudentData !== "boolean") return notBool("collectsStudentData");
  if (typeof storageLocation !== "string") return notText("storageLocation");
  if (storageLocation.length > MAX_PRIVACY_TEXT) return tooLong("storageLocation");
  if (typeof retention !== "string") return notText("retention");
  if (retention.length > MAX_PRIVACY_TEXT) return tooLong("retention");
  if (typeof externalTransfer !== "boolean") return notBool("externalTransfer");
  if (typeof needsSchoolApproval !== "boolean") return notBool("needsSchoolApproval");

  return {
    ok: true,
    value: {
      // F-31: 연결할 프로젝트(선택). 소유 확인은 createApp이 한다.
      projectId: typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim().slice(0, 64) : null,
      title,
      description,
      url,
      schoolLevels,
      category,
      privacyCheck: {
        collectsStudentData,
        storageLocation,
        retention,
        externalTransfer,
        needsSchoolApproval,
      },
    },
  };
}
