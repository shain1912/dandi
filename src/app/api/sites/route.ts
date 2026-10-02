import { agentAuthError, authenticateAgent } from "@/lib/agent-auth";
import { hubOriginFromRequest } from "@/lib/origin";
import { listMySites } from "@/lib/sites";

// F-51 내 사이트 목록: GET /api/sites → { sites: [{ id, slug, title, projectId, liveUrl, previewUrl, appId, approvalStatus, updatedAt }] }

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return agentAuthError(auth);
  const sites = await listMySites(auth.user, hubOriginFromRequest(req));
  return Response.json({ sites }, { headers: { "Cache-Control": "no-store" } });
}
