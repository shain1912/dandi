import { connection } from "next/server";
import { MODEL_STATUS_LABEL } from "@/lib/constants";
import { DEPLOYMENT_LABEL, listModels } from "@/lib/ai";

// F-22 모델 가이드 공개 API. 로그인 없이 누구나 조회할 수 있다.
// 상태는 관리자가 바꾸는 즉시 반영되어야 하므로 빌드 시점에 미리 만들지 않는다.
// F-23: 차단 모델은 목록에서 빼고, 보류 모델은 "정책 검토 중"으로 표시한다.

export async function GET(): Promise<Response> {
  await connection();
  const models = (await listModels()).filter((m) => m.status !== "blocked");
  return Response.json({
    policyNote: "모델 허용 여부는 교육청 정책 판단에 따릅니다. status가 allowed인 모델만 게이트웨이를 통과하고, 차단된 모델은 목록에 나오지 않습니다.",
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      origin: m.origin,
      status: m.status,
      statusLabel: m.status === "pending" ? "정책 검토 중" : MODEL_STATUS_LABEL[m.status],
      deployment: m.deployment,
      deploymentLabel: DEPLOYMENT_LABEL[m.deployment],
      dataLocation: m.dataLocation,
      recommendedUse: m.recommendedUse,
      updatedAt: m.updatedAt,
    })),
  });
}
