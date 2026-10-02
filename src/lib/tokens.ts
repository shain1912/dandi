import "server-only";
import { createHash, randomBytes } from "node:crypto";

// 비밀값을 만든다. 원문은 발급 순간 한 번만 보여 주고 해시만 저장한다.
// dd_cli_ CLI 토큰 · dd_sk_ 프로젝트 API 키 · dd_mat_/dd_mrt_ MCP OAuth 접근·갱신 토큰 · dd_dev_ device code

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function generateSecret(kind: "cli" | "sk" | "mat" | "mrt" | "dev"): {
  secret: string;
  hash: string;
  prefix: string;
} {
  const secret = `dd_${kind}_${randomBytes(24).toString("base64url")}`;
  return { secret, hash: hashSecret(secret), prefix: secret.slice(0, 12) };
}

/** 브라우저 세션 값(dd_sid). proxy.ts와 같은 형식(s_ + 32자리 16진수)을 사용한다. */
export function generateSessionId(): string {
  return `s_${randomBytes(16).toString("hex")}`;
}

/** Authorization: Bearer <token> 헤더에서 토큰을 꺼낸다. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}
