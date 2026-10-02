import { hubOriginFromRequest } from "@/lib/origin";
import { buildFullReference, markdownResponse } from "@/lib/runbook";

// F-55: 명령·JSON·종료 코드·MCP 설정·스킬을 모은 전체 레퍼런스(40KB 이하). 짧은 런북은 /llms.txt.
export function GET(req: Request): Response {
  return markdownResponse(buildFullReference(hubOriginFromRequest(req)));
}
