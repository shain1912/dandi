import { apiError } from "@/lib/agent-auth";
import { hubOriginFromRequest } from "@/lib/origin";
import { getProjectDetail } from "@/lib/projects";
import { authorizeProjectApi, detailJson } from "../project-auth";

// F-31·F-33 프로젝트 하나의 설정·이번 달 사용량·키 힌트.
// 인증: 교사 토큰(dd_cli_·dd_mat_) 또는 이 프로젝트의 admin·readonly 키(dd_sk_).

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const actor = await authorizeProjectApi(req, id, "read");
  if (!actor.ok) return actor.response;
  const detail = await getProjectDetail(actor.user, id);
  if (!detail) return apiError(404, "not_found", "프로젝트를 찾을 수 없습니다.");
  return Response.json(detailJson(detail, hubOriginFromRequest(req)), {
    headers: { "x-dandi-project-id": detail.project.id },
  });
}
