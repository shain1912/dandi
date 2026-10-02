import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import type { User } from "../src/lib/types.ts";

// 원격 MCP OAuth 갱신 유예(QA R13). 공개 클라이언트는 갱신 요청에 client_id를 빼도 되므로(RFC 6749 3.2.1, 6),
// client_id 없이 동시에 보낸 갱신 요청도 연결을 끊지 않고 같은 후속 토큰 한 쌍을 받아야 한다.
// src/lib/oauth.ts는 서버 전용(server-only, next/headers)이라 이 파일 안에서만 쓰는 로더로 해석한다(books.test.ts와 같음).
const ROOT = new URL("../", import.meta.url).href;
const HOOKS = `
const ROOT = ${JSON.stringify(ROOT)};
const stub = (src) => ({ url: "data:text/javascript," + encodeURIComponent(src), shortCircuit: true });
export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return stub("export default null");
  if (specifier === "next/headers") return stub("export async function headers(){return new Headers()} export async function cookies(){return {get(){return undefined},set(){}}}");
  if (specifier.startsWith("@/")) specifier = new URL("src/" + specifier.slice(2), ROOT).href;
  try {
    return await next(specifier, context);
  } catch (err) {
    if ((specifier.startsWith(".") || specifier.startsWith("file:")) && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
      for (const ext of [".ts", ".tsx"]) {
        try { return await next(specifier + ext, context); } catch {}
      }
    }
    throw err;
  }
}`;
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`);

const dataDir = mkdtempSync(path.join(os.tmpdir(), "dandi-oauth-test-"));
process.env.DANDI_DATA_DIR = dataDir;
delete process.env.HUB_ORIGIN;

const oauth = await import("../src/lib/oauth.ts");
const { mutate, readDb } = await import("../src/lib/db.ts");

after(() => rmSync(dataDir, { recursive: true, force: true }));

const HUB = "http://localhost:3100";
const REDIRECT = "http://127.0.0.1:33418/callback";
const teacher: User = { id: "seed_teacher", role: "teacher", name: "데모 교사", schoolLevel: "middle", createdAt: "2026-01-01T00:00:00.000Z" };

type Tokens = { access_token: string; refresh_token: string };

/** 클라이언트 등록 → 교사 승인 → 코드 교환까지 해서 첫 토큰 한 쌍을 받는다. */
async function connect(): Promise<{ clientId: string; tokens: Tokens }> {
  const reg = await oauth.registerClient({ redirect_uris: [REDIRECT], client_name: "테스트 도구" });
  assert.equal(reg.ok, true);
  if (!reg.ok) throw new Error("unreachable");
  const clientId = reg.value.client_id;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const check = await oauth.validateAuthorizeRequest(
    { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s1" },
    HUB,
  );
  assert.equal(check.ok, true, JSON.stringify(check));
  if (!check.ok) throw new Error("unreachable");
  const back = new URL(await oauth.approveAuthorization(teacher, check.request, HUB));
  const code = back.searchParams.get("code")!;
  const r = await oauth.handleTokenRequest(
    { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier },
    HUB,
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error("unreachable");
  return { clientId, tokens: r.value as Tokens };
}

async function tokenRevoked(secret: string): Promise<boolean> {
  const hash = createHash("sha256").update(secret).digest("hex");
  const db = await readDb();
  const row = db.oauthTokens.find((t) => t.tokenHash === hash);
  // 해시 방식이 바뀌어도 테스트가 헛돌지 않게, 못 찾으면 실패로 둔다.
  assert.ok(row, "issued token must be stored");
  return Boolean(row!.revokedAt);
}

test("R13: client_id 없이 동시에 보낸 갱신 두 번은 모두 성공하고 같은 후속 토큰을 받는다", async () => {
  const { tokens } = await connect();
  const [a, b] = await Promise.all([
    oauth.handleTokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }, HUB),
    oauth.handleTokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }, HUB),
  ]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  if (!a.ok || !b.ok) return;
  const ta = a.value as Tokens;
  const tb = b.value as Tokens;
  assert.equal(ta.access_token, tb.access_token);
  assert.equal(ta.refresh_token, tb.refresh_token);
  assert.equal(await tokenRevoked(ta.access_token), false, "the winner's new access token must stay valid");
  assert.equal(await tokenRevoked(ta.refresh_token), false);

  // 후속 갱신 토큰으로 다시 갱신하는 것도 정상 동작한다.
  const next = await oauth.handleTokenRequest({ grant_type: "refresh_token", refresh_token: ta.refresh_token }, HUB);
  assert.equal(next.ok, true, JSON.stringify(next));
});

test("R13: client_id가 있을 때와 없을 때 섞여 와도 유예가 적용된다", async () => {
  const { clientId, tokens } = await connect();
  const first = await oauth.handleTokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }, HUB);
  const retry = await oauth.handleTokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }, HUB);
  assert.equal(first.ok && retry.ok, true, JSON.stringify({ first, retry }));
  if (!first.ok || !retry.ok) return;
  assert.equal((first.value as Tokens).access_token, (retry.value as Tokens).access_token);
});

test("R13: 다른 client_id로 보낸 갱신은 거절한다", async () => {
  const { tokens } = await connect();
  const other = await connect();
  const r = await oauth.handleTokenRequest(
    { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: other.clientId },
    HUB,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "invalid_grant");
});

test("R13: 유예 시간이 지난 재사용은 client_id가 없어도 탈취로 보고 연결 전체를 폐기한다", async () => {
  const { tokens } = await connect();
  const first = await oauth.handleTokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }, HUB);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const successor = first.value as Tokens;
  // 회전 시각을 유예 시간(60초) 밖으로 옮긴다.
  const oldHash = createHash("sha256").update(tokens.refresh_token).digest("hex");
  await mutate((db) => {
    const row = db.oauthTokens.find((t) => t.tokenHash === oldHash) as { rotatedAt?: string | null } | undefined;
    assert.ok(row);
    row!.rotatedAt = new Date(Date.now() - (oauth.REFRESH_REUSE_GRACE_SEC + 5) * 1000).toISOString();
  });
  const late = await oauth.handleTokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }, HUB);
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.error, "invalid_grant");
  assert.equal(await tokenRevoked(successor.access_token), true);
  assert.equal(await tokenRevoked(successor.refresh_token), true);
});

test("R13: 연결을 끊은 뒤에는 유예 시간 안이라도 다시 받을 수 없다", async () => {
  const { clientId, tokens } = await connect();
  const first = await oauth.handleTokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }, HUB);
  assert.equal(first.ok, true);
  assert.ok((await oauth.revokeConnection(teacher, clientId)) > 0);
  const replay = await oauth.handleTokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }, HUB);
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.error, "invalid_grant");
});
