import { hubOriginFromRequest } from "@/lib/origin";
import { buildRunbook, markdownResponse } from "@/lib/runbook";

// F-55: /llms.txt 별칭. 리다이렉트하면 WebFetch가 따라가지 않을 수 있어 같은 원문을 200으로 준다.
export function GET(req: Request): Response {
  return markdownResponse(buildRunbook(hubOriginFromRequest(req)));
}
