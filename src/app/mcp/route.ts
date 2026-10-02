import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { authenticateAgent } from "@/lib/agent-auth";
import { MCP_SERVER_INSTRUCTIONS, registerDandiTools, type McpToolContext } from "@/lib/mcp-tools";
import { OAUTH_SCOPE } from "@/lib/oauth";
import { hubOriginFromRequest } from "@/lib/origin";

// F-57 원격 MCP(Streamable HTTP). `claude mcp add --transport http dandi <hub>/mcp`로 연결한다.
// - 인증: authenticateAgent와 같은 규칙. OAuth 접근 토큰(dd_mat_)과 CLI 토큰(dd_cli_, 헤더 직접 지정)을 받고 교사·관리자만 통과한다.
// - 토큰이 없거나 틀리면 401 + WWW-Authenticate: Bearer resource_metadata="<hub>/.well-known/oauth-protected-resource/mcp".
//   MCP 클라이언트는 이 주소에서 인가 서버를 찾아 브라우저 승인(OAuth + PKCE)을 시작한다.
// - 상태 없는(stateless) 서버다. 2026-07-28 규격과 2025년 규격 클라이언트를 같은 처리기로 받는다.

const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
/** dandi_deploy_files(파일 합계 5MB, base64로 약 6.7MB)를 담을 수 있는 요청 본문 상한 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID, Mcp-Method, Mcp-Name",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

const mcpHandler = createMcpHandler(registerDandiTools, {
  serverInfo: { name: "dandi", version: "0.2.0" },
  instructions: MCP_SERVER_INSTRUCTIONS,
});

/** Bearer 토큰을 확인한다. 실패하면 undefined를 돌려 withMcpAuth가 401 challenge를 보내게 한다. */
async function verifyToken(req: Request, bearer?: string): Promise<AuthInfo | undefined> {
  if (!bearer) return undefined;
  const auth = await authenticateAgent(req);
  if (!auth.ok) return undefined;
  const extra: McpToolContext & { tokenId: string } = {
    user: auth.user,
    hub: hubOriginFromRequest(req),
    via: auth.via,
    tokenId: auth.tokenId,
  };
  return {
    token: bearer,
    clientId: auth.via === "oauth" ? "dandi-oauth" : "dandi-cli",
    scopes: [OAUTH_SCOPE],
    extra: { ...extra },
  };
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function handle(req: Request): Promise<Response> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return withCors(
      Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request body is too large (max 8MB)" } },
        { status: 413 },
      ),
    );
  }
  // 허브 주소는 요청마다 구한다(HUB_ORIGIN이 없으면 Host 기준). 401의 resource_metadata가 이 주소를 쓴다.
  const hub = hubOriginFromRequest(req);
  const guarded = withMcpAuth(mcpHandler, verifyToken, {
    required: true,
    requiredScopes: [OAUTH_SCOPE],
    resourceMetadataPath: RESOURCE_METADATA_PATH,
    resourceUrl: hub,
  });
  return withCors(await guarded(req));
}

export { handle as GET, handle as POST, handle as DELETE };

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
