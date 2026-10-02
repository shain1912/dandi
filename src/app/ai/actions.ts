"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { gatewayCall, type GatewayErrorCode } from "@/lib/ai";
import { clientIp, getProjectDetail } from "@/lib/projects";
import { AuthError, requireTeacher } from "@/lib/session";

export type GatewayTestState = {
  error?: string;
  code?: GatewayErrorCode | "invalid_key";
  hint?: string;
  result?: {
    model: string;
    modelName: string;
    projectName: string;
    output: string;
    tokens: number;
    remaining: number;
    quota: number;
    teacherRemaining: number;
    teacherCap: number;
    piiMasked: number;
    piiLabels: string[];
    warnings: string[];
  };
};

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

// F-21 게이트웨이 테스트. 교사가 고른 자기 프로젝트의 키로 서버에서 호출한다(키 원문은 필요 없다).
// 개인정보가 있어도 제출을 막지 않고, 서버 마스킹 결과를 보여 준다.
export async function testGateway(_prev: GatewayTestState, formData: FormData): Promise<GatewayTestState> {
  let user;
  try {
    user = await requireTeacher();
  } catch (err) {
    if (err instanceof AuthError) return { error: err.message };
    throw err;
  }

  const projectId = str(formData, "projectId");
  const keyId = str(formData, "keyId");
  const detail = projectId ? await getProjectDetail(user, projectId) : null;
  if (!detail) return { error: "프로젝트를 고르십시오. 프로젝트는 /studio/projects 에서 만듭니다.", code: "invalid_key" };
  if (!keyId || !detail.keys.some((k) => k.id === keyId)) {
    return { error: "이 프로젝트의 키를 고르십시오. 키는 프로젝트의 키 탭에서 만듭니다.", code: "invalid_key" };
  }

  const ip = clientIp(await headers());
  const r = await gatewayCall({ keyId, modelId: str(formData, "model"), prompt: str(formData, "prompt"), touchIp: ip });
  if (!r.ok) return { error: r.error, code: r.code, hint: r.hint };

  revalidatePath(`/studio/projects/${r.projectId}`);
  return {
    result: {
      model: r.model,
      modelName: r.modelName,
      projectName: r.projectName,
      output: r.output,
      tokens: r.tokens,
      remaining: r.remaining,
      quota: r.quota,
      teacherRemaining: r.teacherRemaining,
      teacherCap: r.teacherCap,
      piiMasked: r.piiMasked,
      piiLabels: r.piiLabels,
      warnings: r.warnings,
    },
  };
}
