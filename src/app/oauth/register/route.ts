import { corsPreflight, OAUTH_CORS_HEADERS, oauthErrorResponse, registerClient } from "@/lib/oauth";

// F-57 동적 클라이언트 등록(RFC 7591). Claude Code·Cursor·VS Code 같은 MCP 클라이언트가 처음 연결할 때 호출한다.
// 공개 클라이언트(token_endpoint_auth_method "none")만 등록하며, 로그인 없이 호출할 수 있으므로
// 본문 크기를 제한하고 등록 내용은 교사가 동의 화면에서 확인한다.

const MAX_BODY_CHARS = 16 * 1024;

export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_CHARS) {
    return oauthErrorResponse({ ok: false, status: 413, error: "invalid_client_metadata", description: "request body is too large" });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) {
    return oauthErrorResponse({ ok: false, status: 413, error: "invalid_client_metadata", description: "request body is too large" });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return oauthErrorResponse({ ok: false, status: 400, error: "invalid_client_metadata", description: "request body must be JSON" });
  }

  const result = await registerClient(body);
  if (!result.ok) return oauthErrorResponse(result);
  return Response.json(result.value, {
    status: 201,
    headers: { ...OAUTH_CORS_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

export function OPTIONS() {
  return corsPreflight();
}
