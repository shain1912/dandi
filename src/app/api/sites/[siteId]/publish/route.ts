import { revalidatePath } from "next/cache";
import { agentAuthError, apiError, authenticateAgent } from "@/lib/agent-auth";
import { hubOriginFromRequest } from "@/lib/origin";
import { publishSite, type PublishInput } from "@/lib/sites";
import { isPlainObject, readJsonBody, revalidateSitePages, siteErrorResponse } from "../../http";

// F-51 publish: 셀프점검(F-16)을 거쳐 사이트를 허브 미니앱으로 등록하고 공개 주소를 연다.
// 요청 { deployId?, title, description, schoolLevels, category, privacyCheck: { 5항목 } }
// 응답 200 { appId, appUrl, liveUrl, previewUrl, approvalStatus: "approved"|"not_required"|"pending",
//            liveVersion: "updated"|"kept_until_approval", message }. 검증 오류는 422 invalid_publish.
// approved는 승인받은 앱을 같은 셀프점검 답으로 다시 등록해 승인 완료를 유지한 경우다. message는 교사에게 그대로 전할
// 한국어 안내로, CLI·MCP가 바꾸지 않고 전달한다(kept_until_approval이면 이전 공개 버전이 승인 때까지 유지된다는 설명 포함).

const MAX_BODY_BYTES = 64 * 1024;

type Ctx = { params: Promise<{ siteId: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return agentAuthError(auth);

  const { siteId } = await ctx.params;
  const parsed = await readJsonBody(req, MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  if (!isPlainObject(parsed.body)) return apiError(400, "invalid_request", "요청 본문은 JSON 객체여야 합니다.");

  // 항목별 형식 검사(셀프점검 5문항 포함)는 publishSite가 한다.
  const result = await publishSite(auth.user, siteId, parsed.body as unknown as PublishInput, hubOriginFromRequest(req));
  if (!result.ok) return siteErrorResponse(result);
  revalidateSitePages(true);
  revalidatePath(`/apps/${result.value.appId}`);
  return Response.json(result.value);
}
