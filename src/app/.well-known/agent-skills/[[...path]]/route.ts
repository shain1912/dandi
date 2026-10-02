import { hubOriginFromRequest } from "@/lib/origin";
import {
  discoveryIndex,
  installClientKey,
  legacyDiscoveryIndex,
  noteScopedIndexRead,
  readPublicSkillFile,
  readSkillArchive,
  recordSkillInstall,
} from "@/lib/skills";

// F-39 스킬 설치 엔드포인트(Agent Skills Discovery v0.2.0). vercel-labs/skills CLI(src/providers/wellknown.ts)가 읽는다.
//   GET /.well-known/agent-skills/index.json                                  → { $schema, skills: [{ name, type: "archive", description, url, digest }] }
//   GET /.well-known/agent-skills/<name>/<version>.zip                         → 설치용 zip(바이트의 sha256이 digest와 같다)
//   GET /.well-known/agent-skills/<name>/SKILL.md                              → 현재 공개 버전의 SKILL.md
//   GET /.well-known/agent-skills/<name>/.well-known/agent-skills/index.json   → 그 스킬 하나만 담은 index(범위 지정 설치)
//   GET /.well-known/agent-skills/<name>/.well-known/skills/index.json         → 같은 범위의 구 형식(v0.1.0) index
//   GET /.well-known/agent-skills/<name>/.well-known/skills/<name>/<파일>      → 구 형식 CLI가 범위 index 다음에 받는 파일
// 설치 명령은 범위 지정 소스(`npx skills add <hub>/.well-known/agent-skills/<name> --skill <name>`)를 쓴다. CLI는 먼저
// <소스>/.well-known/agent-skills/index.json(범위 index)을 읽고 거기 적힌 압축 파일 하나만 받는다. 범위 index를 읽은
// 클라이언트가 이어서 받은 압축 파일만 설치 수로 센다(루트 index로 모든 스킬을 한꺼번에 받은 것은 세지 않는다).
// 허브 주소를 넣어 내보내는 템플릿 스킬(시드 dandi-deploy)은 index의 digest와 압축 파일을 같은 허브 기준으로 만든다.
// 승인된 공개 스킬만 내보내며 쿠키·로그인과 무관하다.

type Ctx = { params: Promise<{ path?: string[] }> };

const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; sandbox",
};

function notFound(): Response {
  return Response.json(
    { error: { code: "not_found", message: "스킬을 찾을 수 없습니다.", hint: "/.well-known/agent-skills/index.json에서 목록을 확인하십시오." } },
    { status: 404, headers: HEADERS },
  );
}

function body(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 허브 origin에서 올린 파일이 문서로 실행되지 않게 글자 또는 내려받기 형식으로만 보낸다. */
function fileResponse(file: { bytes: Uint8Array; contentType: string }): Response {
  const type = file.contentType.startsWith("text/markdown")
    ? "text/markdown; charset=utf-8"
    : file.contentType.includes("charset=utf-8")
      ? "text/plain; charset=utf-8"
      : "application/octet-stream";
  return new Response(body(file.bytes), {
    headers: { ...HEADERS, "Content-Type": type, "Content-Length": String(file.bytes.byteLength) },
  });
}

export async function GET(req: Request, { params }: Ctx) {
  const segs = (await params).path ?? [];
  const hub = hubOriginFromRequest(req);

  if (segs.length === 0 || (segs.length === 1 && segs[0] === "index.json")) {
    return Response.json(await discoveryIndex(undefined, hub), { headers: HEADERS });
  }

  const [name, ...rest] = segs;

  // 범위 지정 소스: <hub>/.well-known/agent-skills/<name>/.well-known/(agent-skills|skills)/...
  if (rest.length >= 3 && rest[0] === ".well-known") {
    if (rest[1] === "agent-skills" && rest.length === 3 && rest[2] === "index.json") {
      const index = await discoveryIndex(name, hub);
      if (!index) return notFound();
      noteScopedIndexRead(req, name);
      return Response.json(index, { headers: HEADERS });
    }
    if (rest[1] === "skills" && rest.length === 3 && rest[2] === "index.json") {
      const index = await legacyDiscoveryIndex(name);
      if (!index) return notFound();
      noteScopedIndexRead(req, name);
      return Response.json(index, { headers: HEADERS });
    }
    if (rest[1] === "skills" && rest.length >= 4 && rest[2] === name) {
      const filePath = rest.slice(3).join("/");
      const file = await readPublicSkillFile(name, filePath, hub);
      if (!file) return notFound();
      if (filePath === "SKILL.md") await recordSkillInstall(name, installClientKey(req));
      return fileResponse(file);
    }
    return notFound();
  }
  if (rest.length !== 1) return notFound();

  const zip = /^(\d{1,6}\.\d{1,6}\.\d{1,6})\.zip$/.exec(rest[0]);
  if (zip) {
    const archive = await readSkillArchive(name, zip[1], hub);
    if (!archive) return notFound();
    await recordSkillInstall(name, installClientKey(req));
    return new Response(body(archive.bytes), {
      headers: {
        ...HEADERS,
        "Content-Type": "application/zip",
        "Content-Length": String(archive.bytes.byteLength),
        "Content-Disposition": `attachment; filename="${name}-${zip[1]}.zip"`,
        ETag: `"${archive.digest}"`,
      },
    });
  }

  if (rest[0] === "SKILL.md") {
    const file = await readPublicSkillFile(name, "SKILL.md", hub);
    if (!file) return notFound();
    return new Response(body(file.bytes), {
      headers: { ...HEADERS, "Content-Type": "text/markdown; charset=utf-8" },
    });
  }

  return notFound();
}
