"use server";

import { revalidatePath } from "next/cache";
import { addModel, isDeployment, isModelStatus, setModelStatus, updateModelGuide } from "@/lib/ai";
import { AuthError, requireAdmin } from "@/lib/session";

/** savedAt은 성공할 때마다 바뀌어, 폼이 입력칸을 비울 때(key 재마운트) 기준으로 사용한다. */
export type AdminFormState = { error?: string; message?: string; savedAt?: string };

function authError(err: unknown): AdminFormState {
  if (err instanceof AuthError) return { error: err.message };
  throw err;
}

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

// F-23 모델 상태 변경 + F-24 변경 이력(setModelStatus가 감사 로그를 남긴다).
export async function updateModelStatus(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  try {
    const admin = await requireAdmin();
    const modelId = field(formData, "modelId");
    const status = field(formData, "status");
    if (!isModelStatus(status)) return { error: "상태를 선택하십시오." };
    const r = await setModelStatus(admin, modelId, status, field(formData, "reason"));
    if (!r.ok) return { error: r.error };
    // 교사 화면·게이트웨이는 매 요청 저장소를 읽으므로 곧바로 반영된다.
    revalidatePath("/admin");
    revalidatePath("/ai");
    return { message: "저장했습니다.", savedAt: String(Date.now()) };
  } catch (err) {
    return authError(err);
  }
}

// F-23 모델 추가. 신규 모델은 항상 '보류'로 시작한다.
export async function createModel(_prev: AdminFormState, formData: FormData): Promise<AdminFormState> {
  try {
    const admin = await requireAdmin();
    const deployment = field(formData, "deployment");
    if (!isDeployment(deployment)) return { error: "실행 방식을 선택하십시오." };
    const r = await addModel(admin, {
      id: field(formData, "id"),
      name: field(formData, "name"),
      provider: field(formData, "provider"),
      origin: field(formData, "origin"),
      deployment,
      dataLocation: field(formData, "dataLocation"),
      recommendedUse: field(formData, "recommendedUse"),
    });
    if (!r.ok) return { error: r.error };
    revalidatePath("/admin");
    revalidatePath("/ai");
    return {
      message: `${r.value.name}(${r.value.id}) 모델을 '보류' 상태로 추가했습니다.`,
      savedAt: String(Date.now()),
    };
  } catch (err) {
    return authError(err);
  }
}

// F-22 모델 가이드 수정. 가이드 내용은 교육청 관리자가 입력·승인한다(감사 로그 model.guide).
export async function updateModelGuideAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  try {
    const admin = await requireAdmin();
    const deployment = field(formData, "deployment");
    if (!isDeployment(deployment)) return { error: "실행 방식을 선택하십시오." };
    const r = await updateModelGuide(admin, field(formData, "modelId"), {
      name: field(formData, "name"),
      provider: field(formData, "provider"),
      origin: field(formData, "origin"),
      deployment,
      dataLocation: field(formData, "dataLocation"),
      recommendedUse: field(formData, "recommendedUse"),
    });
    if (!r.ok) return { error: r.error };
    revalidatePath("/admin");
    revalidatePath("/ai");
    return { message: "가이드를 수정했습니다.", savedAt: String(Date.now()) };
  } catch (err) {
    return authError(err);
  }
}
