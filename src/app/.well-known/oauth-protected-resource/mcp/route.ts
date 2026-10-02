import { connection } from "next/server";
import { corsPreflight, metadataResponse, protectedResourceMetadata } from "@/lib/oauth";
import { hubOriginFromRequest } from "@/lib/origin";

// F-57 보호 자원 메타데이터(RFC 9728)의 경로 삽입 주소. 자원 <hub>/mcp의 메타데이터이며
// /mcp의 401 응답 WWW-Authenticate resource_metadata가 이 주소를 가리킨다.

export async function GET(req: Request) {
  await connection();
  return metadataResponse(protectedResourceMetadata(hubOriginFromRequest(req)));
}

export function OPTIONS() {
  return corsPreflight();
}
