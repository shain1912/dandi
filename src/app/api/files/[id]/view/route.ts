import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import {
  etagMatches,
  fileEtag,
  fileInlineAccess,
  ifRangeAllows,
  notModifiedSince,
  parseByteRange,
  storedFileIsPdf,
} from "@/lib/books";
import { getFile, storedFilePath } from "@/lib/files";
import { getCurrentUser } from "@/lib/session";

// F-44 PDF 브라우저 안 열람. 다운로드(/api/files/[id]/download)와 같은 파일을 Content-Disposition: inline으로 보낸다.
// - PDF(확장자 pdf이고 앞부분에 %PDF- 머리말이 있는 파일)만 보낸다. 다른 형식은 404.
// - 공개 자료는 다운로드와 같이 로그인 없이 열람한다. 교사 전용 책(F-45 저작권 게이트 포함)이 쓰는 파일은 교사만 연다.
// - 다운로드 수는 세지 않는다(책 열람 수는 서가가 따로 센다).
// - 단일 구간 Range 요청에 206으로 답한다(Accept-Ranges: bytes). pdf.js가 큰 PDF를 전부 받기 전에 첫 쪽을 그릴 수 있다.
// - ETag·Last-Modified로 다시 열 때 304로 답한다. 브라우저 캐시만 쓰고(private) 공유 캐시에는 남기지 않는다.
//   교사 전용 책의 파일은 매번 권한을 다시 확인하도록 no-cache(재검증)로 보낸다.

type Ctx = { params: Promise<{ id: string }> };

/** 공개 PDF를 브라우저가 재검증 없이 다시 쓰는 시간(초). 자료실 파일은 저장 후 바뀌지 않는다. */
const PUBLIC_MAX_AGE = 3600;

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function asciiFallback(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return /[A-Za-z0-9]/.test(ascii.replace(/\.pdf$/i, "")) ? ascii : "document.pdf";
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}

async function handle(req: Request, id: string, withBody: boolean): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return textResponse(404, "자료를 찾을 수 없습니다.");
  const item = await getFile(id);
  if (!item || item.ext !== "pdf") return textResponse(404, "PDF 자료를 찾을 수 없습니다.");

  // 권한을 먼저 확인한다(304·206도 권한이 있을 때만).
  const access = await fileInlineAccess(item.id, await getCurrentUser());
  if (!access.allowed) return textResponse(403, "교사 전용 책의 자료입니다. 교사 로그인 후 열람하십시오.");

  const full = storedFilePath(item);
  if (!full) return textResponse(404, "PDF 자료를 찾을 수 없습니다.");
  let size: number;
  let mtimeMs: number;
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) return textResponse(404, "저장된 파일이 없습니다.");
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    return textResponse(404, "저장된 파일이 없습니다.");
  }
  if (!(await storedFileIsPdf(item))) return textResponse(404, "PDF 형식이 아닌 파일입니다.");

  const etag = fileEtag(size, mtimeMs);
  const lastModified = new Date(Math.floor(mtimeMs / 1000) * 1000).toUTCString();
  const cacheHeaders = {
    ETag: etag,
    "Last-Modified": lastModified,
    "Cache-Control": access.restricted ? "private, no-cache" : `private, max-age=${PUBLIC_MAX_AGE}`,
    Vary: "Cookie",
  };

  const ifNoneMatch = req.headers.get("if-none-match");
  const fresh = ifNoneMatch ? etagMatches(ifNoneMatch, etag) : notModifiedSince(req.headers.get("if-modified-since"), mtimeMs);
  if (fresh) return new Response(null, { status: 304, headers: cacheHeaders });

  const headers: Record<string, string> = {
    ...cacheHeaders,
    "Content-Type": "application/pdf",
    "Accept-Ranges": "bytes",
    "Content-Disposition": `inline; filename="${asciiFallback(item.originalName)}"; filename*=UTF-8''${encodeRfc5987(item.originalName)}`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };

  const range = ifRangeAllows(req.headers.get("if-range"), etag, lastModified)
    ? parseByteRange(req.headers.get("range"), size)
    : null;
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...cacheHeaders, "Accept-Ranges": "bytes", "Content-Range": `bytes */${size}` },
    });
  }
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    if (!withBody) return new Response(null, { status: 206, headers });
    const part = Readable.toWeb(createReadStream(full, { start: range.start, end: range.end })) as ReadableStream<Uint8Array>;
    return new Response(part, { status: 206, headers });
  }

  headers["Content-Length"] = String(size);
  if (!withBody) return new Response(null, { status: 200, headers });
  const body = Readable.toWeb(createReadStream(full)) as ReadableStream<Uint8Array>;
  return new Response(body, { status: 200, headers });
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  return handle(req, id, true);
}

export async function HEAD(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  return handle(req, id, false);
}
