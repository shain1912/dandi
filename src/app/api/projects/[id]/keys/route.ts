import { apiError } from "@/lib/agent-auth";
import { createProjectKey, listProjectKeys } from "@/lib/projects";
import { authorizeProjectApi, keyJson, projectError, readJsonObject, viaKey } from "../../project-auth";

// F-32 프로젝트 키 목록·발급.
// GET  → { keys: [{ id, name, role, hint, status, ... }] }  (원문·해시는 내보내지 않는다)
// POST { name, role?: "inference"|"admin"|"readonly", expires?: "3h"|"1d"|"7d"|"30d"|"semester"|"none" }
//   → 201 { key, secret, warning }  secret(원문)은 이 응답에서 한 번만 나온다.
// 인증: 교사 토큰(dd_cli_·dd_mat_). 목록은 admin·readonly 키, 발급은 admin 키로도 할 수 있다.

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const actor = await authorizeProjectApi(req, id, "read");
  if (!actor.ok) return actor.response;
  const keys = await listProjectKeys(actor.user, id);
  if (!keys) return apiError(404, "not_found", "프로젝트를 찾을 수 없습니다.");
  return Response.json({ keys: keys.map(keyJson) }, { headers: { "x-dandi-project-id": id } });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const actor = await authorizeProjectApi(req, id, "manage");
  if (!actor.ok) return actor.response;
  const body = await readJsonObject(req);
  if (!body) return apiError(400, "invalid_request", "요청 본문은 JSON 객체여야 합니다.");
  const r = await createProjectKey(
    actor.user,
    id,
    { name: body.name, role: body.role, expiresPreset: body.expires ?? body.expiresPreset },
    viaKey(actor),
  );
  if (!r.ok) return projectError(r.code, r.error);
  return Response.json(
    {
      key: keyJson(r.value.key),
      secret: r.value.secret,
      warning:
        "키 원문은 이 응답에서 한 번만 제공됩니다. 채팅·로그·HTML에 출력하지 말고 미니앱 서버의 환경변수 DANDI_PROJECT_KEY에 바로 저장하십시오.",
    },
    { status: 201, headers: { "x-dandi-project-id": id, "Cache-Control": "no-store" } },
  );
}
