"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AuthError, requireTeacher } from "@/lib/session";
import { createTemplate, incrementCopies, type NewTemplateInput } from "@/lib/templates";
import type { AppCategory, SchoolLevel } from "@/lib/types";

export type TemplateFormState = { error?: string };

/** 새 템플릿 등록(F-10). 교사만 사용할 수 있다. */
export async function createTemplateAction(
  _prev: TemplateFormState,
  formData: FormData,
): Promise<TemplateFormState> {
  let user;
  try {
    user = await requireTeacher();
  } catch (err) {
    if (err instanceof AuthError) return { error: err.message };
    throw err;
  }

  const input: NewTemplateInput = {
    title: String(formData.get("title") ?? ""),
    summary: String(formData.get("summary") ?? ""),
    category: String(formData.get("category") ?? "") as AppCategory,
    schoolLevels: formData.getAll("schoolLevels").map(String) as SchoolLevel[],
    workOrder: String(formData.get("workOrder") ?? ""),
    exampleUrl: String(formData.get("exampleUrl") ?? ""),
  };

  const result = await createTemplate(input, user);
  if (!result.ok) return { error: result.error };

  revalidatePath("/templates");
  const masked = result.masked ? `?masked=${result.masked}` : "";
  redirect(`/templates/${result.value.id}${masked}`);
}

/** 작업 지시서 복사 수 집계. 로그인하지 않은 방문자도 복사할 수 있다. */
export async function recordTemplateCopy(id: string): Promise<number | null> {
  if (typeof id !== "string" || id.length > 64) return null;
  const copies = await incrementCopies(id);
  if (copies !== null) {
    revalidatePath("/templates");
    revalidatePath(`/templates/${id}`);
  }
  return copies;
}
