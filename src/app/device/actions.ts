"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { decideDeviceAuth, normalizeUserCode } from "@/lib/device-auth";
import { getCurrentUser, isTeacher } from "@/lib/session";

// F-53 기기 연결 승인·거부. 화면에서 버튼을 보여 준 것만으로는 권한 확인이 아니므로
// 여기서 교사 세션을 다시 확인하고, 결과는 /device?code=... 화면이 저장소 상태로 다시 그린다.

export async function decideDeviceAction(formData: FormData): Promise<void> {
  const code = normalizeUserCode(String(formData.get("code") ?? ""));
  const decision = formData.get("decision");
  const back = code ? `/device?code=${encodeURIComponent(code)}` : "/device";

  const user = await getCurrentUser();
  if (!isTeacher(user)) redirect(`/login?next=${encodeURIComponent(back)}`);
  if (!code || (decision !== "approve" && decision !== "deny")) {
    redirect(code ? `${back}&error=invalid` : "/device?error=invalid");
  }

  const result = await decideDeviceAuth(user, code, decision);
  if (result.ok) revalidatePath("/studio/cli");
  redirect(result.ok ? back : `${back}&error=${encodeURIComponent(result.code)}`);
}
