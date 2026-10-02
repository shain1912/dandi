import { agentAuthError, apiError, authenticateAgent } from "@/lib/agent-auth";
import { SITE_LIMITS, uploadDeployFile } from "@/lib/sites";
import { readBodyLimited, siteErrorResponse } from "../../../http";

// F-51 2단계: PUT /api/sites/deploys/{deployId}/files?path=<encodeURIComponent(path)>
// 본문 = 파일 원본 바이트. 크기·sha256이 1단계 목록과 같아야 저장한다(아니면 400 hash_mismatch). 성공 204.

type Ctx = { params: Promise<{ deployId: string }> };

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return agentAuthError(auth);

  const { deployId } = await ctx.params;
  const filePath = new URL(req.url).searchParams.get("path");
  if (!filePath) {
    return apiError(400, "invalid_request", "path 쿼리가 필요합니다.", "?path=<encodeURIComponent(사이트 기준 경로)> 형식으로 보내십시오.");
  }
  const bytes = await readBodyLimited(req, SITE_LIMITS.fileBytes);
  if (!bytes) {
    return apiError(413, "file_too_large", `파일 하나는 ${SITE_LIMITS.fileBytes / 1024 / 1024}MB까지 올릴 수 있습니다.`);
  }

  const result = await uploadDeployFile(auth.user, deployId, filePath, bytes);
  if (!result.ok) return siteErrorResponse(result);
  return new Response(null, { status: 204 });
}
