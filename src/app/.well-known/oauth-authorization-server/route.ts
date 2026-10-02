import { connection } from "next/server";
import { authorizationServerMetadata, corsPreflight, metadataResponse } from "@/lib/oauth";
import { hubOriginFromRequest } from "@/lib/origin";

// F-57 인가 서버 메타데이터(RFC 8414). issuer는 허브 주소이고, 인가 응답의 iss 값과 같다.

export async function GET(req: Request) {
  await connection();
  return metadataResponse(authorizationServerMetadata(hubOriginFromRequest(req)));
}

export function OPTIONS() {
  return corsPreflight();
}
