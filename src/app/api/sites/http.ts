import { revalidatePath } from "next/cache";
import { apiError } from "@/lib/agent-auth";
import type { SiteResult } from "@/lib/sites";

// /api/sites/** 공통 도우미(F-51). 라우트 파일이 아니므로 주소로 노출되지 않는다.

/** 요청 본문을 max 바이트까지만 읽는다. 넘으면 null(끝까지 읽지 않고 멈춘다). */
export async function readBodyLimited(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** JSON 본문을 읽는다. 크기 초과·형식 오류는 바로 보낼 오류 응답으로 돌려준다. */
export async function readJsonBody(req: Request, max: number): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const bytes = await readBodyLimited(req, max);
  if (!bytes) {
    return { ok: false, response: apiError(413, "payload_too_large", `요청 본문은 ${Math.floor(max / 1024)}KB 이하여야 합니다.`) };
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { ok: false, response: apiError(400, "invalid_json", "요청 본문이 올바른 JSON이 아닙니다.") };
  }
}

export function siteErrorResponse(result: Extract<SiteResult<unknown>, { ok: false }>): Response {
  return apiError(result.status, result.code, result.message, result.hint);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 사이트 목록·미니앱 화면을 새로 그리게 한다. */
export function revalidateSitePages(published = false): void {
  revalidatePath("/studio/sites");
  if (!published) return;
  revalidatePath("/");
  revalidatePath("/apps");
  revalidatePath("/studio");
  revalidatePath("/studio/apps");
  revalidatePath("/admin");
}
