"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  archiveProject,
  createProject,
  createProjectKey,
  deleteKey,
  disableKey,
  enableKey,
  updateProject,
} from "@/lib/projects";
import { AuthError, requireTeacher } from "@/lib/session";
import type { User } from "@/lib/types";

// 프로젝트·키 관리 서버 액션(F-31 ~ F-34). 검증·마스킹·감사 로그는 lib/projects.ts가 맡는다.

/** savedAt은 성공할 때마다 바뀌어, 폼을 비울 때(key 재마운트) 기준으로 쓴다. */
export type ProjectFormState = { error?: string; message?: string; savedAt?: string };

/** 키 원문(secret)은 이 상태로 한 번만 전달되고 서버에는 해시만 남는다. */
export type KeyCreateState = {
  error?: string;
  secret?: string;
  keyId?: string;
  hint?: string;
  name?: string;
  savedAt?: string;
};

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

async function teacherOrError(): Promise<{ user: User } | { error: string }> {
  try {
    return { user: await requireTeacher() };
  } catch (err) {
    if (err instanceof AuthError) return { error: err.message };
    throw err;
  }
}

function revalidateProject(projectId: string): void {
  revalidatePath("/studio/projects");
  revalidatePath(`/studio/projects/${projectId}`);
  revalidatePath("/ai");
  revalidatePath("/admin");
}

export async function createProjectAction(_prev: ProjectFormState, formData: FormData): Promise<ProjectFormState> {
  const auth = await teacherOrError();
  if ("error" in auth) return { error: auth.error };
  const r = await createProject(auth.user, {
    name: str(formData, "name"),
    description: str(formData, "description"),
    monthlyTokenBudget: str(formData, "monthlyTokenBudget"),
  });
  if (!r.ok) return { error: r.error };
  revalidateProject(r.value.id);
  // 다음 단계는 키 만들기이므로 키 탭으로 보낸다.
  redirect(`/studio/projects/${r.value.id}?tab=keys`);
}

export async function updateSettingsAction(_prev: ProjectFormState, formData: FormData): Promise<ProjectFormState> {
  const auth = await teacherOrError();
  if ("error" in auth) return { error: auth.error };
  const projectId = str(formData, "projectId");
  const r = await updateProject(auth.user, projectId, {
    name: str(formData, "name"),
    description: str(formData, "description"),
    monthlyTokenBudget: str(formData, "monthlyTokenBudget"),
  });
  if (!r.ok) return { error: r.error };
  revalidateProject(projectId);
  return { message: "저장했습니다.", savedAt: String(Date.now()) };
}

export async function updateModelsAction(_prev: ProjectFormState, formData: FormData): Promise<ProjectFormState> {
  const auth = await teacherOrError();
  if ("error" in auth) return { error: auth.error };
  const projectId = str(formData, "projectId");
  const mode = str(formData, "mode");
  if (mode !== "all" && mode !== "custom") return { error: "허용 방식을 고르십시오." };
  const modelIds =
    mode === "all" ? null : formData.getAll("modelIds").filter((v): v is string => typeof v === "string");
  const r = await updateProject(auth.user, projectId, { modelIds });
  if (!r.ok) return { error: r.error };
  revalidateProject(projectId);
  return { message: "허용 모델을 저장했습니다.", savedAt: String(Date.now()) };
}

export async function archiveProjectAction(_prev: ProjectFormState, formData: FormData): Promise<ProjectFormState> {
  const auth = await teacherOrError();
  if ("error" in auth) return { error: auth.error };
  const projectId = str(formData, "projectId");
  const r = await archiveProject(auth.user, projectId);
  if (!r.ok) return { error: r.error };
  revalidateProject(projectId);
  // 보관하면 설정 탭이 보관 화면으로 바뀌어 이 폼이 사라지므로, 결과(비활성화한 키 수)는 주소에 실어 보관 화면에서 보여 준다.
  redirect(`/studio/projects/${encodeURIComponent(projectId)}?tab=settings&archived=${r.value.disabledKeys}`);
}

export async function createKeyAction(_prev: KeyCreateState, formData: FormData): Promise<KeyCreateState> {
  const auth = await teacherOrError();
  if ("error" in auth) return { error: auth.error };
  const projectId = str(formData, "projectId");
  const r = await createProjectKey(auth.user, projectId, {
    name: str(formData, "name"),
    role: str(formData, "role"),
    expiresPreset: str(formData, "expires"),
  });
  if (!r.ok) return { error: r.error };
  revalidateProject(projectId);
  return {
    secret: r.value.secret,
    keyId: r.value.key.id,
    hint: r.value.key.hint,
    name: r.value.key.name,
    savedAt: String(Date.now()),
  };
}

export type KeyActionState = { error?: string };

/** 키 비활성화·다시 켜기·삭제. op: "disable" | "enable" | "delete" */
export async function keyAction(_prev: KeyActionState, formData: FormData): Promise<KeyActionState> {
  const auth = await teacherOrError();
  if ("error" in auth) return { error: auth.error };
  const projectId = str(formData, "projectId");
  const keyId = str(formData, "keyId");
  const op = str(formData, "op");
  const fn = op === "disable" ? disableKey : op === "enable" ? enableKey : op === "delete" ? deleteKey : null;
  if (!fn) return { error: "알 수 없는 작업입니다." };
  const r = await fn(auth.user, projectId, keyId);
  if (!r.ok) return { error: r.error };
  revalidateProject(projectId);
  return {};
}
