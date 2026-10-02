import { revalidatePath } from "next/cache";
import { agentAuthError, apiError, authenticateAgent } from "@/lib/agent-auth";
import { createDeploy, type ManifestFile } from "@/lib/sites";
import { isPlainObject, readJsonBody, revalidateSitePages, siteErrorResponse } from "../http";

// F-51 1단계: 파일 목록(path·size·sha256)을 받아 배포를 만들고, 서버에 없는 파일 경로를 돌려준다.
// 요청 { siteId?, slug?, title?, projectId?, moveToProject?, files: [{ path, size, sha256 }] }
// 응답 201 { deployId, siteId, slug, projectId, projectMoved, projectNotice?, upload: [경로...] }
// projectId는 새 사이트(siteId 없음)를 만들 때의 기본값이다. moveToProject: true는 교사가 직접 고른 프로젝트라는 뜻
// (CLI --project): 기존 사이트는 이때만 그 프로젝트로 옮기고, 그 밖에는 다른 projectId를 무시하고 사이트의 현재
// projectId를 돌려준다(CLI가 dandi.json에 다시 적는다). 새 사이트에 쓸 수 없는 projectId를 moveToProject 없이 보내면
// 기본 프로젝트에 연결하고 projectNotice로 알린다. 오래된 projectId 때문에 409로 막지 않는다.

const MAX_BODY_BYTES = 1024 * 1024; // 파일 1,000개 × 경로 512자 + 해시

function optional(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return agentAuthError(auth);

  const parsed = await readJsonBody(req, MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!isPlainObject(body)) return apiError(400, "invalid_request", "요청 본문은 JSON 객체여야 합니다.");
  for (const key of ["siteId", "slug", "title", "projectId"] as const) {
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "string") {
      return apiError(400, "invalid_request", `${key}는 문자열이어야 합니다.`);
    }
  }
  if (body.moveToProject !== undefined && body.moveToProject !== null && typeof body.moveToProject !== "boolean") {
    return apiError(400, "invalid_request", "moveToProject는 true 또는 false여야 합니다.");
  }

  const result = await createDeploy(auth.user, {
    siteId: optional(body.siteId),
    slug: optional(body.slug),
    title: optional(body.title),
    projectId: optional(body.projectId),
    moveToProject: body.moveToProject === true,
    files: body.files as ManifestFile[], // createDeploy가 항목마다 형식을 검사한다.
  });
  if (!result.ok) return siteErrorResponse(result);
  revalidateSitePages();
  if (result.value.projectMoved) {
    revalidatePath(`/studio/sites/${result.value.siteId}`);
    revalidatePath("/studio/projects");
  }
  return Response.json(result.value, { status: 201 });
}
