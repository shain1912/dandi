import { agentAuthError, apiError, authenticateAgent } from "@/lib/agent-auth";
import { hubOriginFromRequest } from "@/lib/origin";
import { createProject, listMyProjects, PROJECT_LIMIT, TEACHER_MONTHLY_CAP, teacherMonthUsage } from "@/lib/projects";
import { projectError, projectJson, readJsonObject } from "./project-auth";

// F-31 프로젝트 API (CLI·에이전트용). 인증: dd_cli_ CLI 토큰 또는 dd_mat_ OAuth 접근 토큰(교사·관리자).
// GET  /api/projects → { projects: [...], limits: { projectLimit, teacherMonthlyCap, teacherMonthTokens } }
// POST /api/projects { name, description?, monthlyTokenBudget?, modelIds? } → 201 { project }

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return agentAuthError(auth);
  const hub = hubOriginFromRequest(req);
  const [projects, used] = await Promise.all([listMyProjects(auth.user), teacherMonthUsage(auth.user.id)]);
  return Response.json({
    projects: projects.map((p) => projectJson(p, hub)),
    limits: { projectLimit: PROJECT_LIMIT, teacherMonthlyCap: TEACHER_MONTHLY_CAP, teacherMonthTokens: used },
  });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return agentAuthError(auth);
  const body = await readJsonObject(req);
  if (!body) return apiError(400, "invalid_request", "요청 본문은 JSON 객체여야 합니다.");
  const r = await createProject(auth.user, {
    name: body.name,
    description: body.description,
    monthlyTokenBudget: body.monthlyTokenBudget,
    modelIds: body.modelIds,
  });
  if (!r.ok) return projectError(r.code, r.error);
  const hub = hubOriginFromRequest(req);
  const project = (await listMyProjects(auth.user)).find((p) => p.id === r.value.id);
  return Response.json(
    {
      project: project ? projectJson(project, hub) : { id: r.value.id, name: r.value.name },
      next_step: `POST /api/projects/${r.value.id}/keys 로 이 프로젝트의 키를 만드십시오.`,
    },
    { status: 201 },
  );
}
