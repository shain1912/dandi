import "server-only";
import { isAppCategory, isSchoolLevel } from "./constants";
import { mutate, newId, nowIso, readDb } from "./db";
import { maskFields } from "./pii";
import { normalizeNewlines, urlHasPII } from "./text";
import { displayName, ensureUser, isTeacher, writeAudit } from "./session";
import type { AppCategory, MiniApp, NewAppInput, SchoolLevel, User } from "./types";

// 미니앱 등록·조회 도메인 로직(F-04 ~ F-06, F-16). 웹 폼과 CLI publish가 모두 이 함수를 사용한다.

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const URL_MAX = 500;

/** 허브 목록·무로그인 실행에 노출되는 앱인가(F-16: 승인 대기 앱은 제외). */
export function isPublicApp(app: MiniApp): boolean {
  return app.approvalStatus !== "pending";
}

/** 승인 대기 앱도 볼 수 있는 사람: 로그인한 작성자와 관리자. */
export function canViewApp(app: MiniApp, viewer: User | null): boolean {
  if (isPublicApp(app)) return true;
  if (!viewer) return false;
  return viewer.role === "admin" || (isTeacher(viewer) && viewer.id === app.authorId);
}

/** 공개 앱 목록. 승인 대기 앱은 빠진다(작성자·관리자 화면은 db.apps를 직접 사용). */
export async function listApps(filter: {
  level?: SchoolLevel;
  category?: AppCategory;
} = {}): Promise<MiniApp[]> {
  const db = await readDb();
  return db.apps
    .filter(isPublicApp)
    .filter((a) => !filter.level || a.schoolLevels.includes(filter.level))
    .filter((a) => !filter.category || a.category === filter.category)
    .sort((a, b) => b.runs - a.runs || b.createdAt.localeCompare(a.createdAt));
}

export async function listPendingApps(): Promise<MiniApp[]> {
  const db = await readDb();
  return db.apps.filter((a) => a.approvalStatus === "pending");
}

/** 학교 내부 승인 완료 표시(F-16). v0.1은 작성자 자기 표시 또는 관리자 표시(PRD Q5). */
export async function approveApp(id: string, actor: User): Promise<Result<MiniApp>> {
  return mutate((db) => {
    const app = db.apps.find((a) => a.id === id);
    if (!app) return { ok: false, error: "앱을 찾을 수 없습니다." } as const;
    if (app.authorId !== actor.id && actor.role !== "admin") {
      return { ok: false, error: "작성자나 관리자만 승인 완료를 표시할 수 있습니다." } as const;
    }
    if (app.approvalStatus !== "pending") {
      return { ok: false, error: "승인 대기 상태인 앱이 아닙니다." } as const;
    }
    app.approvalStatus = "approved";
    app.approvedAt = nowIso();
    app.approvedByName = displayName(actor);
    // 허브 호스팅 사이트(F-51): 승인을 기다리던 새 버전이 있으면 이제 공개 주소로 옮긴다.
    const site = db.sites.find((s) => s.appId === app.id);
    if (site?.pendingDeployId) {
      site.liveDeployId = site.pendingDeployId;
      site.pendingDeployId = null;
      site.updatedAt = nowIso();
    }
    writeAudit(db, actor, "app.approve", app.id, app.title);
    return { ok: true, value: app } as const;
  });
}

export async function getApp(id: string): Promise<MiniApp | null> {
  const db = await readDb();
  return db.apps.find((a) => a.id === id) ?? null;
}

export async function incrementRuns(id: string): Promise<void> {
  await mutate((db) => {
    const app = db.apps.find((a) => a.id === id);
    if (app && isPublicApp(app)) app.runs += 1;
  });
}

function isAllowedUrl(url: string): boolean {
  if (url.startsWith("/examples/")) return true; // 허브에 포함된 예시 앱
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** 입력 검증. 셀프점검(F-16)의 모든 항목이 채워져야 공개된다. */
export function validateNewApp(input: NewAppInput): string | null {
  if (!input.title.trim()) return "앱 이름을 입력하십시오.";
  if (input.title.length > 80) return "앱 이름은 80자 이하로 입력하십시오.";
  // 길이를 먼저 확인한 뒤 형식·개인정보를 검사한다(매우 긴 입력으로 검사기를 붙잡지 못하게).
  if (input.url.trim().length > URL_MAX) return `배포 URL은 ${URL_MAX}자 이하로 입력하십시오.`;
  if (!isAllowedUrl(input.url.trim())) return "배포 URL은 http(s)로 시작해야 합니다.";
  if (urlHasPII(input.url)) {
    return "배포 URL에 개인정보(전화번호·이메일 등)로 보이는 값이 있습니다. 개인정보가 없는 주소를 입력하십시오.";
  }
  if (input.schoolLevels.length === 0) return "학교급을 하나 이상 선택하십시오.";
  if (!input.schoolLevels.every(isSchoolLevel)) return "알 수 없는 학교급이 있습니다.";
  if (!isAppCategory(input.category)) return "분류를 선택하십시오.";
  const pc = input.privacyCheck;
  if (!pc.storageLocation.trim()) return "셀프점검: 데이터 저장 위치를 입력하십시오.";
  if (!pc.retention.trim()) return "셀프점검: 보관 기간을 입력하십시오.";
  if (pc.collectsStudentData && !pc.needsSchoolApproval) {
    // 학생 개인정보를 다루면 학교 내부 승인 확인을 강제한다(교사단 논의 P1 사례).
    return "셀프점검: 학생 개인정보를 처리하는 앱은 학교 내부 승인 필요 여부를 확인해야 합니다.";
  }
  return null;
}

export async function createApp(input: NewAppInput, author: User): Promise<Result<MiniApp>> {
  const error = validateNewApp(input);
  if (error) return { ok: false, error };

  // F-14 서버 마스킹: 설명과 셀프점검 자유 입력에 섞인 개인정보를 저장 전에 가린다.
  const masked = maskFields({
    title: input.title.trim(),
    description: normalizeNewlines(input.description).trim(),
    storageLocation: input.privacyCheck.storageLocation.trim(),
    retention: input.privacyCheck.retention.trim(),
  });

  const app: MiniApp = {
    id: newId("app"),
    projectId: input.projectId ?? null,
    title: masked.values.title,
    description: masked.values.description,
    url: input.url.trim(),
    schoolLevels: [...new Set(input.schoolLevels)],
    category: input.category,
    handlesPersonalData: input.privacyCheck.collectsStudentData,
    privacyCheck: {
      collectsStudentData: input.privacyCheck.collectsStudentData,
      storageLocation: masked.values.storageLocation,
      retention: masked.values.retention,
      externalTransfer: input.privacyCheck.externalTransfer,
      needsSchoolApproval: input.privacyCheck.needsSchoolApproval,
      checkedAt: nowIso(),
    },
    approvalStatus: input.privacyCheck.needsSchoolApproval ? "pending" : "not_required",
    approvedAt: null,
    approvedByName: null,
    authorId: author.id,
    authorName: displayName(author),
    runs: 0,
    createdAt: nowIso(),
  };

  const error2 = await mutate((db) => {
    // F-31: 연결할 프로젝트는 본인 것(관리자는 모두)이어야 한다.
    if (app.projectId) {
      const project = db.projects.find((p) => p.id === app.projectId && p.status === "active");
      if (!project || (project.ownerUserId !== author.id && author.role !== "admin")) {
        return "연결할 프로젝트를 찾을 수 없습니다.";
      }
    }
    ensureUser(db, author);
    db.apps.push(app);
    writeAudit(db, author, "app.create", app.id, masked.count ? `개인정보 ${masked.count}건 마스킹` : "");
    return null;
  });
  if (error2) return { ok: false, error: error2 };
  return { ok: true, value: app };
}

export async function deleteApp(id: string, actor: User): Promise<Result<null>> {
  return mutate((db) => {
    const idx = db.apps.findIndex((a) => a.id === id);
    if (idx < 0) return { ok: false, error: "앱을 찾을 수 없습니다." } as const;
    const app = db.apps[idx];
    if (app.authorId !== actor.id && actor.role !== "admin") {
      return { ok: false, error: "본인이 등록한 앱만 삭제할 수 있습니다." } as const;
    }
    db.apps.splice(idx, 1);
    writeAudit(db, actor, "app.delete", id);
    return { ok: true, value: null } as const;
  });
}
