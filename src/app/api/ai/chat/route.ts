import { GATEWAY_STATUS, gatewayCall } from "@/lib/ai";
import { authenticateProjectKey } from "@/lib/projects";

// F-21 게이트웨이 호출 API. 프로젝트 API 키(dd_sk_...)로 호출한다(F-32).
// 인증 헤더: Authorization: Bearer dd_sk_...  또는  x-api-key: dd_sk_...
// 키만 있으면 프로젝트가 정해지므로 projectId는 보내지 않는다. 응답 헤더 x-dandi-project-id로 알려 준다.
// 요청 형식
//   { "model": "claude", "prompt": "..." }
//   { "model": "claude", "messages": [{ "role": "user", "content": "..." }] }  // OpenAI 호환 형태
// 응답(200): { model, output, projectId, usage: { tokens, remaining, quota, teacherRemaining, teacherCap }, warnings, piiMasked, mock }
// 오류: { error: { code, message, hint? } }
//   401 missing_key · invalid_key · key_disabled · key_expired · browser_key_forbidden
//   403 project_archived · insufficient_role · model_not_allowed
//   400 invalid_request · model_not_found
//   429 project_quota_exceeded · teacher_quota_exceeded
//
// F-35: 브라우저(Origin·Sec-Fetch-Site 등)에서 dd_sk_ 키로 부르면 401 browser_key_forbidden.
// 교사가 HTML에 키를 넣은 사고를 곧바로 드러내도록, 브라우저가 이 오류 본문을 읽을 수 있게 CORS를 연다
// (브라우저 요청은 어떤 경우에도 성공하지 않으므로 CORS를 열어도 호출 권한이 생기지 않는다).

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Max-Age": "600",
};

function errorResponse(
  req: Request,
  status: number,
  code: string,
  message: string,
  opts: { hint?: string; projectId?: string } = {},
): Response {
  const headers = new Headers();
  if (status === 401) headers.set("WWW-Authenticate", "Bearer");
  if (opts.projectId) headers.set("x-dandi-project-id", opts.projectId);
  if (req.headers.has("origin")) headers.set("Access-Control-Allow-Origin", "*");
  return Response.json({ error: { code, message, ...(opts.hint ? { hint: opts.hint } : {}) } }, { status, headers });
}

type Message = { role?: unknown; content?: unknown };

/** content는 문자열이거나 [{ type: "text", text }] 배열일 수 있다. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function promptFromBody(body: Record<string, unknown>): string | null {
  if (typeof body.prompt === "string") return body.prompt;
  if (Array.isArray(body.messages)) {
    const parts = (body.messages as Message[])
      .filter((m) => m && typeof m === "object" && m.role === "user")
      .map((m) => contentText(m.content))
      .filter((t) => t.length > 0);
    return parts.length > 0 ? parts.join("\n\n") : null;
  }
  return null;
}

/** CORS 사전 요청. 실제 POST는 브라우저 신호 때문에 401 browser_key_forbidden으로 끝난다. */
export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateProjectKey(req);
  if (!auth.ok) {
    return errorResponse(req, auth.status, auth.code, auth.message, { hint: auth.hint, projectId: auth.projectId });
  }
  const projectId = auth.project.id;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(req, 400, "invalid_request", "요청 본문은 JSON이어야 합니다.", { projectId });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse(req, 400, "invalid_request", "요청 본문은 JSON 객체여야 합니다.", { projectId });
  }
  const record = body as Record<string, unknown>;

  const model = typeof record.model === "string" ? record.model.trim() : "";
  if (!model) {
    return errorResponse(req, 400, "invalid_request", "model을 지정하십시오.", {
      hint: "사용 가능한 모델은 GET /api/ai/models에서 확인하십시오.",
      projectId,
    });
  }
  const prompt = promptFromBody(record);
  if (prompt === null) {
    return errorResponse(req, 400, "invalid_request", 'prompt 문자열 또는 role이 "user"인 messages 배열을 보내십시오.', {
      projectId,
    });
  }

  // 키의 마지막 사용 시각·IP는 authenticateProjectKey가 이미 기록했다.
  const result = await gatewayCall({ keyId: auth.key.id, modelId: model, prompt });
  if (!result.ok) {
    return errorResponse(req, GATEWAY_STATUS[result.code], result.code, result.error, {
      hint: result.hint,
      projectId: result.projectId ?? projectId,
    });
  }

  return Response.json(
    {
      model: result.model,
      output: result.output,
      projectId: result.projectId,
      usage: {
        tokens: result.tokens,
        remaining: result.remaining,
        quota: result.quota,
        teacherRemaining: result.teacherRemaining,
        teacherCap: result.teacherCap,
      },
      warnings: result.warnings,
      piiMasked: result.piiMasked,
      mock: result.mock,
    },
    { headers: { "x-dandi-project-id": result.projectId } },
  );
}
