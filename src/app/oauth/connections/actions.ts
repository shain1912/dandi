"use server";

import { revalidatePath } from "next/cache";
import { revokeConnection } from "@/lib/oauth";
import { AuthError, requireTeacher } from "@/lib/session";

// F-57 연결된 AI 도구 끊기. 교사 본인의 연결만 폐기할 수 있다(revokeConnection이 교사 id로 한정한다).

export async function revokeConnectionAction(formData: FormData): Promise<void> {
  const clientId = String(formData.get("clientId") ?? "");
  if (!clientId || clientId.length > 100) return;
  let user;
  try {
    user = await requireTeacher();
  } catch (err) {
    if (err instanceof AuthError) return;
    throw err;
  }
  await revokeConnection(user, clientId);
  revalidatePath("/oauth/connections");
}
