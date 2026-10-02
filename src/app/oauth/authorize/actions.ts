"use server";

import { redirect } from "next/navigation";
import {
  approveAuthorization,
  authorizePagePath,
  denyAuthorization,
  pickAuthorizeParams,
  validateAuthorizeRequest,
} from "@/lib/oauth";
import { hubOrigin } from "@/lib/origin";
import { getCurrentUser, isTeacher } from "@/lib/session";

// F-57 동의 화면의 [허용]/[거부]. 화면에서 보낸 값을 믿지 않고 인가 요청과 교사 세션을 처음부터 다시 확인한다.
// 서버 액션은 Next.js가 Origin을 확인하므로 다른 사이트가 대신 제출할 수 없다.

async function decide(formData: FormData, allow: boolean): Promise<never> {
  const params = pickAuthorizeParams((key) => formData.get(key));
  const hub = await hubOrigin();
  const check = await validateAuthorizeRequest(params, hub);
  // 요청이 잘못됐으면 동의 화면으로 돌려보내 같은 오류 안내를 보여 준다.
  if (!check.ok) redirect(authorizePagePath(params));

  const user = await getCurrentUser();
  if (!isTeacher(user)) redirect(`/login?next=${encodeURIComponent(authorizePagePath(params))}`);

  const url = allow
    ? await approveAuthorization(user, check.request, hub)
    : await denyAuthorization(user, check.request, hub);
  redirect(url);
}

export async function approveAuthorizationAction(formData: FormData): Promise<void> {
  await decide(formData, true);
}

export async function denyAuthorizationAction(formData: FormData): Promise<void> {
  await decide(formData, false);
}
