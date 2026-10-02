import { pollDeviceToken } from "@/lib/device-auth";

// F-53: dandi login이 승인 결과를 폴링한다. 오류는 RFC 8628 형식({ error: "<문자열>" })이다.
// 승인되면 dd_cli_ 토큰을 한 번만 돌려주고, 같은 device_code로는 다시 받을 수 없다.

const MAX_BODY_CHARS = 4 * 1024;
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

function oauthError(error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status: 400, headers: NO_STORE });
}

/** JSON({ device_code }) 또는 RFC 8628의 form 형식(device_code=...)을 모두 받는다. */
function readDeviceCode(raw: string, contentType: string): string | null {
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(raw).get("device_code");
  }
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body === "object" && body !== null && "device_code" in body) {
      const v = (body as { device_code: unknown }).device_code;
      return typeof v === "string" ? v : null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return oauthError("invalid_request", "요청 본문이 너무 큽니다.");
  const deviceCode = readDeviceCode(raw, req.headers.get("content-type") ?? "");
  if (!deviceCode) return oauthError("invalid_request", "device_code가 필요합니다.");

  const result = await pollDeviceToken(deviceCode);
  if (!result.ok) return oauthError(result.error, result.description);
  return Response.json({ token: result.token, user: result.user }, { headers: NO_STORE });
}
