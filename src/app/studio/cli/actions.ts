"use server";

import { revalidatePath } from "next/cache";
import { issueCliToken, revokeCliToken } from "@/lib/cli";
import { AuthError, requireTeacher } from "@/lib/session";

export type IssueState = { secret?: string; prefix?: string; error?: string };

/** F-17: CLI 토큰 발급. 원문은 이 응답으로 한 번만 전달되고 서버에는 해시만 남는다. */
export async function issueTokenAction(): Promise<IssueState> {
  try {
    const user = await requireTeacher();
    const { secret, token } = await issueCliToken(user);
    revalidatePath("/studio/cli");
    revalidatePath("/studio");
    return { secret, prefix: token.tokenPrefix };
  } catch (err) {
    if (err instanceof AuthError) return { error: err.message };
    throw err;
  }
}

export async function revokeTokenAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  let user;
  try {
    user = await requireTeacher();
  } catch (err) {
    if (err instanceof AuthError) return;
    throw err;
  }
  await revokeCliToken(user, id);
  revalidatePath("/studio/cli");
  revalidatePath("/studio");
}
