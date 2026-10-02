import { apiError } from "@/lib/agent-auth";
import { hubOriginFromRequest } from "@/lib/origin";
import { getSkill } from "@/lib/skills";

// F-37 스킬 상세. 공개 승인 스킬만 돌려준다(로그인 불필요). skillMd는 현재 공개 버전의 SKILL.md 원문이다.

type Ctx = { params: Promise<{ name: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { name } = await params;
  const skill = await getSkill(name, { hub: hubOriginFromRequest(req) });
  if (!skill) {
    return apiError(404, "skill_not_found", "공개된 스킬을 찾을 수 없습니다.", "GET /api/skills?q= 로 이름을 확인하십시오.");
  }
  return Response.json(skill);
}
