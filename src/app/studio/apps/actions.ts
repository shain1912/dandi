"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { approveApp, createApp, deleteApp } from "@/lib/apps";
import { isSchoolLevel } from "@/lib/constants";
import { AuthError, requireTeacher } from "@/lib/session";
import { normalizeNewlines } from "@/lib/text";
import type { AppCategory, NewAppInput, User } from "@/lib/types";

// 교사 스튜디오 미니앱 등록·삭제(F-04, F-16). 저장 전 마스킹(F-14)은 lib/apps.ts의 createApp이 처리한다.

/** 오류가 나면 입력값을 되돌려 주어, 폼이 초기화되어도 다시 채울 수 있게 한다. */
export type NewAppValues = {
  title: string;
  description: string;
  url: string;
  schoolLevels: string[];
  category: string;
  collectsStudentData: string; // "yes" | "no" | ""
  storageLocation: string;
  retention: string;
  externalTransfer: string;
  needsSchoolApproval: string;
};

export type NewAppState = { error?: string; values?: NewAppValues };
export type DeleteAppState = { error?: string };
export type ApproveAppState = { error?: string; done?: boolean };

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

function yesNo(v: string): boolean | null {
  if (v === "yes") return true;
  if (v === "no") return false;
  return null;
}

async function teacherOrError(): Promise<{ user: User } | { error: string }> {
  try {
    return { user: await requireTeacher() };
  } catch (err) {
    if (err instanceof AuthError) return { error: err.message };
    throw err;
  }
}

function revalidateAppPages(): void {
  revalidatePath("/");
  revalidatePath("/apps");
  revalidatePath("/studio/apps");
  revalidatePath("/admin");
}

export async function createAppAction(_prev: NewAppState, formData: FormData): Promise<NewAppState> {
  const values: NewAppValues = {
    title: str(formData, "title"),
    description: str(formData, "description"),
    url: str(formData, "url"),
    schoolLevels: formData.getAll("schoolLevels").filter((v): v is string => typeof v === "string"),
    category: str(formData, "category"),
    collectsStudentData: str(formData, "collectsStudentData"),
    storageLocation: str(formData, "storageLocation"),
    retention: str(formData, "retention"),
    externalTransfer: str(formData, "externalTransfer"),
    needsSchoolApproval: str(formData, "needsSchoolApproval"),
  };

  const auth = await teacherOrError();
  if ("error" in auth) return { error: auth.error, values };

  if (normalizeNewlines(values.description).length > 2000) return { error: "설명은 2000자 이하로 입력하십시오.", values };
  if (values.storageLocation.length > 200 || values.retention.length > 200) {
    return { error: "셀프점검: 저장 위치와 보관 기간은 200자 이하로 입력하십시오.", values };
  }

  const collectsStudentData = yesNo(values.collectsStudentData);
  const externalTransfer = yesNo(values.externalTransfer);
  const needsSchoolApproval = yesNo(values.needsSchoolApproval);
  if (collectsStudentData === null) {
    return { error: "셀프점검: 학생 개인정보 수집·처리 여부를 선택하십시오.", values };
  }
  if (externalTransfer === null) {
    return { error: "셀프점검: 외부 전송 여부를 선택하십시오.", values };
  }
  if (needsSchoolApproval === null) {
    return { error: "셀프점검: 학교 내부 승인 필요 여부를 선택하십시오.", values };
  }
  if (!values.schoolLevels.every(isSchoolLevel)) {
    return { error: "알 수 없는 학교급이 있습니다.", values };
  }

  const projectIdRaw = str(formData, "projectId").trim();
  const input: NewAppInput = {
    projectId: projectIdRaw ? projectIdRaw.slice(0, 64) : null,
    title: values.title,
    description: values.description,
    url: values.url,
    schoolLevels: values.schoolLevels.filter(isSchoolLevel),
    category: values.category as AppCategory, // validateNewApp이 isAppCategory로 검사한다.
    privacyCheck: {
      collectsStudentData,
      storageLocation: values.storageLocation,
      retention: values.retention,
      externalTransfer,
      needsSchoolApproval,
    },
  };

  const result = await createApp(input, auth.user);
  if (!result.ok) return { error: result.error, values };

  revalidateAppPages();
  redirect(`/apps/${result.value.id}`);
}

export async function deleteAppAction(_prev: DeleteAppState, formData: FormData): Promise<DeleteAppState> {
  const auth = await teacherOrError();
  if ("error" in auth) return { error: auth.error };

  const id = str(formData, "id");
  if (!id) return { error: "삭제할 앱을 찾을 수 없습니다." };

  // 작성자 검사(F-15 P0 대체)는 deleteApp 안에서 한다. 관리자는 모든 앱을 삭제할 수 있다.
  const result = await deleteApp(id, auth.user);
  if (!result.ok) return { error: result.error };

  revalidateAppPages();
  return {};
}

/** 학교 내부 승인 완료 표시(F-16). 작성자나 관리자만 가능하며 권한 검사는 approveApp 안에서 한다. */
export async function approveAppAction(_prev: ApproveAppState, formData: FormData): Promise<ApproveAppState> {
  const auth = await teacherOrError();
  if ("error" in auth) return { error: auth.error };

  const id = str(formData, "id");
  if (!id) return { error: "승인할 앱을 찾을 수 없습니다." };

  const result = await approveApp(id, auth.user);
  if (!result.ok) return { error: result.error };

  revalidateAppPages();
  revalidatePath(`/apps/${id}`);
  return { done: true };
}
