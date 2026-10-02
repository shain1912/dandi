import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { canViewFileInline } from "@/lib/books";
import { getFile, incrementDownloads, storedFilePath } from "@/lib/files";
import { getCurrentUser } from "@/lib/session";

// F-08 자료 다운로드. 로그인 없이 누구나 받을 수 있다(F-01 익명 우선).
// 예외: 교사 전용 책(F-45 저작권 게이트)이 쓰는 PDF는 교사만 받는다(브라우저가 보내는 세션 쿠키로 확인).

type Ctx = { params: Promise<{ id: string }> };

/** RFC 5987 filename* 값. encodeURIComponent가 남기는 ' ( ) * 도 인코딩한다. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** filename= 에 넣을 ASCII 대체 이름. 한글 등은 _로 바뀌므로 filename*을 지원하지 않는 클라이언트용이다. */
function asciiFallback(name: string, ext: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return /[A-Za-z0-9]/.test(ascii.replace(new RegExp(`\\.${ext}$`), "")) ? ascii : `download.${ext}`;
}

function notFound(message: string): Response {
  return new Response(message, {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function handle(id: string, withBody: boolean): Promise<Response> {
  const item = await getFile(id);
  if (!item) return notFound("자료를 찾을 수 없습니다.");
  if (!(await canViewFileInline(item.id, await getCurrentUser()))) {
    return new Response("교사 전용 자료입니다. 교사 로그인 후 받을 수 있습니다.", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const full = storedFilePath(item);
  if (!full) return notFound("자료를 찾을 수 없습니다.");
  let size: number;
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) return notFound("저장된 파일이 없습니다.");
    size = stat.size;
  } catch {
    return notFound("저장된 파일이 없습니다.");
  }

  const headers = {
    "Content-Type": item.mime || "application/octet-stream",
    "Content-Length": String(size),
    "Content-Disposition": `attachment; filename="${asciiFallback(item.originalName, item.ext)}"; filename*=UTF-8''${encodeRfc5987(item.originalName)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };

  if (!withBody) return new Response(null, { status: 200, headers });

  // HEAD 요청이나 404는 세지 않고, 실제로 본문을 보내는 GET만 다운로드 수에 더한다.
  await incrementDownloads(item.id);
  const body = Readable.toWeb(createReadStream(full)) as ReadableStream<Uint8Array>;
  return new Response(body, { status: 200, headers });
}

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  return handle(id, true);
}

export async function HEAD(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  return handle(id, false);
}
