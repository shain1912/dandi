import { connection } from "next/server";
import { corsPreflight, metadataResponse, protectedResourceMetadata } from "@/lib/oauth";
import { hubOriginFromRequest } from "@/lib/origin";

// F-57 보호 자원 메타데이터(RFC 9728). MCP 클라이언트가 /mcp의 401 응답을 받은 뒤 여기서 인가 서버를 찾는다.
// 같은 문서를 /.well-known/oauth-protected-resource/mcp(경로 삽입 방식)에서도 준다.

export async function GET(req: Request) {
  await connection();
  return metadataResponse(protectedResourceMetadata(hubOriginFromRequest(req)));
}

export function OPTIONS() {
  return corsPreflight();
}
