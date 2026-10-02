"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isLevelOrAll } from "@/lib/constants";
import { deleteFile, saveUpload } from "@/lib/files";
import { AuthError, getCurrentUser, isTeacher, requireTeacher } from "@/lib/session";
import type { User } from "@/lib/types";

export type FileFormState = { error?: string };

// 자료 업로드(F-08). 폼 제출은 multipart/form-data로 들어오며 next.config.ts에서 본문 한도를 52MB로 올려 두었다.
export async function uploadFileAction(
  _prev: FileFormState,
  formData: FormData,
): Promise<FileFormState> {
  let user: User;
  try {
    user = await requireTeacher();
  } catch (err) {
    if (err instanceof AuthError) return { error: err.message };
    throw err;
  }

  // F-08: 파일 내용은 자동 검사하지 않으므로(P2) 업로드하는 교사의 확인을 필수로 받는다.
  if (formData.get("noStudentData") !== "yes") {
    return { error: "파일에 학생 개인정보가 없음을 확인하는 항목에 체크하십시오." };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "업로드할 파일을 선택하십시오. 빈 파일은 올릴 수 없습니다." };
  }
  const schoolLevel = String(formData.get("schoolLevel") ?? "all");
  if (!isLevelOrAll(schoolLevel)) return { error: "학교급을 선택하십시오." };

  const result = await saveUpload(
    {
      file,
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? ""),
      schoolLevel,
    },
    user,
  );
  if (!result.ok) return { error: result.error };

  revalidatePath("/files");
  revalidatePath("/");
  redirect("/files");
}

export async function deleteFileAction(
  _prev: FileFormState,
  formData: FormData,
): Promise<FileFormState> {
  const user = await getCurrentUser();
  if (!isTeacher(user)) return { error: "교사 로그인이 필요합니다." };

  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "삭제할 자료를 찾을 수 없습니다." };

  const result = await deleteFile(id, user);
  if (!result.ok) return { error: result.error };

  revalidatePath("/files");
  revalidatePath("/");
  return {};
}
