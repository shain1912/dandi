import {
  corsPreflight,
  handleTokenRequest,
  OAUTH_CORS_HEADERS,
  oauthErrorResponse,
  type OAuthFailure,
  type TokenRequest,
} from "@/lib/oauth";
import { hubOriginFromRequest } from "@/lib/origin";

// F-57 토큰 엔드포인트(RFC 6749). application/x-www-form-urlencoded만 받는다.
// - authorization_code: code, redirect_uri, client_id, code_verifier(PKCE S256)
// - refresh_token: 새 접근 토큰과 새 갱신 토큰(이전 갱신 토큰은 폐기, 재사용하면 연결 전체 폐기)
// 토큰 원문은 이 응답에서만 나가며 로그에 남기지 않는다.

const MAX_BODY_CHARS = 16 * 1024;
const FIELDS = ["grant_type", "code", "redirect_uri", "client_id", "code_verifier", "refresh_token", "scope", "resource"] as const;

function bad(description: string, status = 400): Response {
  const f: OAuthFailure = { ok: false, status, error: "invalid_request", description };
  return oauthErrorResponse(f);
}

/** client_secret_basic 형식으로 client_id만 보낸 클라이언트를 위해 Basic 헤더에서 client_id를 꺼낸다(비밀값은 쓰지 않는다). */
function basicClientId(req: Request): string | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const id = decoded.split(":")[0];
  try {
    return decodeURIComponent(id.replace(/\+/g, " ")) || null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/x-www-form-urlencoded")) {
    return bad("content type must be application/x-www-form-urlencoded");
  }
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_CHARS) return bad("request body is too large", 413);
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return bad("request body is too large", 413);

  const form = new URLSearchParams(raw);
  const input: TokenRequest = {};
  for (const key of FIELDS) {
    const values = form.getAll(key);
    // RFC 6749 3.2: 같은 매개변수를 두 번 보내면 거절한다.
    if (values.length > 1) return bad(`${key} must not be repeated`);
    if (values.length === 1 && values[0] !== "") input[key] = values[0];
  }
  const fromBasic = basicClientId(req);
  if (fromBasic) {
    if (input.client_id && input.client_id !== fromBasic) return bad("client_id in header and body differ");
    input.client_id = fromBasic;
  }

  const result = await handleTokenRequest(input, hubOriginFromRequest(req));
  if (!result.ok) return oauthErrorResponse(result);
  return Response.json(result.value, {
    headers: { ...OAUTH_CORS_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

export function OPTIONS() {
  return corsPreflight();
}
