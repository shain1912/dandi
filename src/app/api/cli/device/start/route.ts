import { apiError } from "@/lib/agent-auth";
import { parseStartInput, startDeviceAuth } from "@/lib/device-auth";
import { clientIp, hubOriginFromRequest } from "@/lib/origin";

// F-53: dandi login이 브라우저 승인 로그인을 시작한다(RFC 8628 device authorization).
// 인증 없이 호출한다. 응답의 device_code는 CLI만 알고, 교사는 /device 화면에서 user_code를 대조해 승인한다.
// 요청 IP는 origin.ts의 clientIp를 쓴다(믿을 수 있는 프록시 뒤에서만 X-Forwarded-For의 가장 오른쪽 값).
// 클라이언트가 넣은 X-Forwarded-For 첫 값으로 속도 제한을 피하거나 승인 화면의 IP를 꾸밀 수 없다.

const MAX_BODY_CHARS = 4 * 1024;

export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return apiError(413, "too_large", "요청 본문이 너무 큽니다.");
  let body: unknown = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch {
      return apiError(400, "invalid_request", "요청 본문이 올바른 JSON이 아닙니다.");
    }
  }
  const input = parseStartInput(body);
  if (!input.ok) return apiError(input.status, input.code, input.message, input.hint);

  const result = await startDeviceAuth(input.value, clientIp(req.headers), hubOriginFromRequest(req));
  if (!result.ok) return apiError(result.status, result.code, result.message, result.hint);
  return Response.json(result.value, { headers: { "Cache-Control": "no-store" } });
}
