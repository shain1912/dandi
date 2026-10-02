import { agentAuthError, authenticateAgent } from "@/lib/agent-auth";
import { hubOriginFromRequest } from "@/lib/origin";
import { finalizeDeploy } from "@/lib/sites";
import { revalidateSitePages, siteErrorResponse } from "../../../http";

// F-51 3단계: 빠진 파일(409 missing_files)과 비밀값(422 secret_detected)을 검사하고 배포를 확정한다.
// 응답 200 { siteId, deployId, slug, projectId, previewUrl, status: "preview", warnings: [{ path, kind, message }] }
// secret_detected의 hint는 "비밀값을 지운 뒤 다시 올리십시오: <경로>. <siteSecretGuidance(hub)>" 한 문장 묶음이다
// (정적 호스팅이라 키를 둘 곳이 없다는 공통 안내까지 포함하므로 CLI는 덧붙이지 않는다).

type Ctx = { params: Promise<{ deployId: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return agentAuthError(auth);

  const { deployId } = await ctx.params;
  const result = await finalizeDeploy(auth.user, deployId, hubOriginFromRequest(req));
  if (!result.ok) return siteErrorResponse(result);
  revalidateSitePages();
  return Response.json(result.value);
}
