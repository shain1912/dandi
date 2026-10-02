import { hubOriginFromRequest } from "@/lib/origin";
import { buildRunbook, markdownResponse } from "@/lib/runbook";

// F-55: AI 에이전트가 읽고 그대로 따라 하는 "내 사이트 올려줘" 실행 런북.
// 리다이렉트 없이 200 text/markdown(5KB 이하). dandi guide 명령도 이 원문을 그대로 출력한다.
export function GET(req: Request): Response {
  return markdownResponse(buildRunbook(hubOriginFromRequest(req)));
}
