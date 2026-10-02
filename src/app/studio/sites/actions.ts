"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isSchoolLevel } from "@/lib/constants";
import { hubOrigin } from "@/lib/origin";
import { AuthError, requireTeacher } from "@/lib/session";
import {
  SITE_LIMITS,
  createDeploy,
  deleteSite,
  finalizeDeploy,
  moveSiteProject,
  publishSite,
  uploadDeployFile,
  type ManifestFile,
  type PublishValue,
  type SiteResult,
  type SiteWarning,
} from "@/lib/sites";
import type { AppCategory, SchoolLevel, User } from "@/lib/types";

// 웹 폴더 올리기(F-52)와 허브 등록(F-51 publish). HTTP API와 같은 lib/sites.ts 함수를 교사 세션으로 부른다.
// 클라이언트가 보낸 값은 믿지 않고 여기서 형식을 다시 확인한다. 소유자 확인은 lib 함수가 한다.

export type ActionFailure = { ok: false; message: string; hint?: string };

type StartResult =
  | { ok: true; deployId: string; siteId: string; slug: string; projectId: string; upload: string[] }
  | ActionFailure;
type UploadResult = { ok: true } | ActionFailure;
type FinalizeResult =
  | { ok: true; siteId: string; deployId: string; slug: string; previewUrl: string; warnings: SiteWarning[] }
  | ActionFailure;

async function teacherOrFailure(): Promise<{ user: User } | ActionFailure> {
  try {
    return { user: await requireTeacher() };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, message: err.message, hint: "교사 로그인 후 다시 시도하십시오." };
    throw err;
  }
}

function failure(r: Extract<SiteResult<unknown>, { ok: false }>): ActionFailure {
  return r.hint ? { ok: false, message: r.message, hint: r.hint } : { ok: false, message: r.message };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** 1단계: 파일 목록(경로·크기·sha256)으로 배포를 만든다. */
export async function startDeployAction(input: unknown): Promise<StartResult> {
  const auth = await teacherOrFailure();
  if ("ok" in auth) return auth;
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const siteId = str(i.siteId);
  // 새 사이트: 교사가 목록에서 직접 고른 프로젝트이므로 쓸 수 없으면(그사이 보관 등) 기본 프로젝트로 넘기지 않고 알린다.
  // 기존 사이트의 새 버전: projectId를 보내지 않아 프로젝트가 바뀌지 않는다(바꾸기는 moveSiteProjectAction으로만).
  const projectId = siteId ? undefined : str(i.projectId);
  const result = await createDeploy(auth.user, {
    siteId,
    slug: str(i.slug),
    title: str(i.title),
    projectId, // 본인 활성 프로젝트인지는 createDeploy가 확인한다.
    moveToProject: Boolean(projectId),
    files: (Array.isArray(i.files) ? i.files : []) as ManifestFile[], // createDeploy가 항목마다 검사한다.
  });
  if (!result.ok) return failure(result);
  return { ok: true, ...result.value };
}

/** 2단계: 파일 하나를 올린다. FormData: deployId, path, file */
export async function uploadSiteFileAction(formData: FormData): Promise<UploadResult> {
  const auth = await teacherOrFailure();
  if ("ok" in auth) return auth;
  const deployId = formData.get("deployId");
  const filePath = formData.get("path");
  const file = formData.get("file");
  if (typeof deployId !== "string" || typeof filePath !== "string") {
    return { ok: false, message: "올릴 파일 정보가 올바르지 않습니다." };
  }
  if (!(file instanceof File)) {
    return {
      ok: false,
      message: `파일 본문이 전송되지 않았습니다: ${filePath.slice(0, 200)}`,
      hint: "폴더를 다시 고른 뒤 올리십시오.",
    };
  }
  if (file.size > SITE_LIMITS.fileBytes) {
    return { ok: false, message: `파일 하나는 ${SITE_LIMITS.fileBytes / 1024 / 1024}MB까지 올릴 수 있습니다.` };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await uploadDeployFile(auth.user, deployId, filePath, bytes);
  if (!result.ok) return failure(result);
  return { ok: true };
}

/** 3단계: 확정하고 미리보기 주소와 개인정보 경고를 돌려준다. */
export async function finalizeDeployAction(deployId: unknown): Promise<FinalizeResult> {
  const auth = await teacherOrFailure();
  if ("ok" in auth) return auth;
  if (typeof deployId !== "string") return { ok: false, message: "배포를 찾을 수 없습니다." };
  const result = await finalizeDeploy(auth.user, deployId, await hubOrigin());
  if (!result.ok) return failure(result);
  revalidatePath("/studio/sites");
  revalidatePath(`/studio/sites/${result.value.siteId}`);
  const { siteId, slug, previewUrl, warnings } = result.value;
  return { ok: true, siteId, deployId: result.value.deployId, slug, previewUrl, warnings };
}

/* ---------- 허브 등록(셀프점검) ---------- */

/** 오류가 나면 입력값을 되돌려 주어 다시 채울 수 있게 한다(studio/apps/actions.ts와 같은 방식). */
export type PublishValues = {
  title: string;
  description: string;
  schoolLevels: string[];
  category: string;
  collectsStudentData: string; // "yes" | "no" | ""
  storageLocation: string;
  retention: string;
  externalTransfer: string;
  needsSchoolApproval: string;
};

export type PublishState = {
  error?: string;
  values?: PublishValues;
  result?: PublishValue;
};

function field(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

function yesNo(v: string): boolean | null {
  if (v === "yes") return true;
  if (v === "no") return false;
  return null;
}

export async function publishSiteAction(_prev: PublishState, formData: FormData): Promise<PublishState> {
  const values: PublishValues = {
    title: field(formData, "title"),
    description: field(formData, "description"),
    schoolLevels: formData.getAll("schoolLevels").filter((v): v is string => typeof v === "string"),
    category: field(formData, "category"),
    collectsStudentData: field(formData, "collectsStudentData"),
    storageLocation: field(formData, "storageLocation"),
    retention: field(formData, "retention"),
    externalTransfer: field(formData, "externalTransfer"),
    needsSchoolApproval: field(formData, "needsSchoolApproval"),
  };
  const auth = await teacherOrFailure();
  if ("ok" in auth) return { error: auth.message, values };

  const siteId = field(formData, "siteId");
  const deployId = field(formData, "deployId");
  if (!siteId) return { error: "사이트를 찾을 수 없습니다.", values };

  const collectsStudentData = yesNo(values.collectsStudentData);
  const externalTransfer = yesNo(values.externalTransfer);
  const needsSchoolApproval = yesNo(values.needsSchoolApproval);
  if (collectsStudentData === null) return { error: "셀프점검: 학생 개인정보 수집·처리 여부를 선택하십시오.", values };
  if (externalTransfer === null) return { error: "셀프점검: 외부 전송 여부를 선택하십시오.", values };
  if (needsSchoolApproval === null) return { error: "셀프점검: 학교 내부 승인 필요 여부를 선택하십시오.", values };
  if (!values.schoolLevels.every(isSchoolLevel)) return { error: "알 수 없는 학교급이 있습니다.", values };

  // 길이 검사·검증(validateNewApp)·마스킹은 publishSite가 한다.
  const result = await publishSite(
    auth.user,
    siteId,
    {
      ...(deployId ? { deployId } : {}),
      title: values.title,
      description: values.description,
      schoolLevels: values.schoolLevels as SchoolLevel[],
      category: values.category as AppCategory,
      privacyCheck: {
        collectsStudentData,
        storageLocation: values.storageLocation,
        retention: values.retention,
        externalTransfer,
        needsSchoolApproval,
      },
    },
    await hubOrigin(),
  );
  if (!result.ok) {
    // invalid_publish의 hint는 AI 에이전트용 안내(교사에게 물어보라)라서 웹 화면에서는 뺀다.
    const showHint = result.hint && result.code !== "invalid_publish";
    return { error: showHint ? `${result.message} ${result.hint}` : result.message, values };
  }

  revalidatePath("/");
  revalidatePath("/apps");
  revalidatePath(`/apps/${result.value.appId}`);
  revalidatePath("/studio");
  revalidatePath("/studio/apps");
  revalidatePath("/studio/sites");
  revalidatePath(`/studio/sites/${siteId}`);
  revalidatePath("/admin");
  return { values, result: result.value };
}

/* ---------- 사이트 관리: 프로젝트 옮기기·삭제 ---------- */

export type SiteSettingsState = { error?: string; message?: string };

/** 사이트(와 연결된 미니앱)를 내 다른 프로젝트로 옮긴다(F-31). FormData: siteId, projectId */
export async function moveSiteProjectAction(_prev: SiteSettingsState, formData: FormData): Promise<SiteSettingsState> {
  const auth = await teacherOrFailure();
  if ("ok" in auth) return { error: auth.message };
  const siteId = field(formData, "siteId");
  const projectId = field(formData, "projectId");
  if (!siteId) return { error: "사이트를 찾을 수 없습니다." };
  const result = await moveSiteProject(auth.user, siteId, projectId);
  if (!result.ok) return { error: result.hint ? `${result.message} ${result.hint}` : result.message };
  revalidatePath("/studio/sites");
  revalidatePath(`/studio/sites/${siteId}`);
  revalidatePath("/studio/projects");
  return { message: result.value.moved ? "사이트를 고른 프로젝트로 옮겼습니다." : "이미 이 프로젝트에 연결되어 있습니다." };
}

/** 허브에 등록하지 않은 사이트를 지운다(QA UX-15). FormData: siteId, confirm=yes. 성공하면 내 사이트 목록으로 간다. */
export async function deleteSiteAction(_prev: SiteSettingsState, formData: FormData): Promise<SiteSettingsState> {
  const auth = await teacherOrFailure();
  if ("ok" in auth) return { error: auth.message };
  const siteId = field(formData, "siteId");
  if (!siteId) return { error: "사이트를 찾을 수 없습니다." };
  if (field(formData, "confirm") !== "yes") return { error: "삭제 확인란에 표시하십시오." };
  const result = await deleteSite(auth.user, siteId);
  if (!result.ok) return { error: result.hint ? `${result.message} ${result.hint}` : result.message };
  revalidatePath("/studio/sites");
  revalidatePath("/studio/projects");
  redirect("/studio/sites");
}
