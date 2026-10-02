"use server";

import { revalidatePath } from "next/cache";
import { AuthError, requireAdmin } from "@/lib/session";
import { reviewSkillVersion } from "@/lib/skills";

export type SkillReviewState = { error?: string; message?: string };

/** F-40 스킬 버전 승인·반려. 교육청 관리자만 쓸 수 있고 감사 로그(skill.approve / skill.reject)를 남긴다. */
export async function reviewSkillAction(_prev: SkillReviewState, formData: FormData): Promise<SkillReviewState> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    if (err instanceof AuthError) return { error: err.message };
    throw err;
  }
  const name = String(formData.get("name") ?? "");
  const version = String(formData.get("version") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const reason = String(formData.get("reason") ?? "");
  if (decision !== "approve" && decision !== "reject") return { error: "승인 또는 반려를 고르십시오." };
  if (decision === "reject" && !reason.trim()) return { error: "반려할 때는 게시자가 고칠 수 있게 사유를 적으십시오." };

  const r = await reviewSkillVersion(admin, name, version, decision, reason);
  if (!r.ok) return { error: r.message };
  revalidatePath("/admin/skills");
  revalidatePath("/skills");
  revalidatePath(`/skills/${name}`);
  return { message: decision === "approve" ? `${name} v${version}을(를) 승인해 공개했습니다.` : `${name} v${version}을(를) 반려했습니다.` };
}
