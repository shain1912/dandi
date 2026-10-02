import { hubOriginFromRequest } from "@/lib/origin";
import { installClientKey, legacyDiscoveryIndex, readPublicSkillFile, recordSkillInstall } from "@/lib/skills";

// F-39 구 경로(v0.1.0 형식). 예전 skills CLI는 /.well-known/skills/index.json만 읽고 파일을 하나씩 받는다.
//   GET /.well-known/skills/index.json          → { skills: [{ name, description, files: ["SKILL.md", ...] }] } ($schema 없음)
//   GET /.well-known/skills/<name>/<파일 경로>   → 현재 공개 버전의 파일 원본(템플릿 스킬은 이 허브 주소를 넣은 내용)
// 최신 CLI는 /.well-known/agent-skills/를 먼저 쓰므로 이 경로는 호환용이다. 루트 index로는 모든 스킬의 SKILL.md를
// 한꺼번에 받으므로, 같은 클라이언트가 범위 index(<hub>/.well-known/agent-skills/<name>/.well-known/...)를 먼저 읽은
// 경우에만 SKILL.md를 받을 때 설치 수를 센다(skills.ts recordSkillInstall).

type Ctx = { params: Promise<{ path?: string[] }> };

const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; sandbox",
};

export async function GET(req: Request, { params }: Ctx) {
  const segs = (await params).path ?? [];

  if (segs.length === 0 || (segs.length === 1 && segs[0] === "index.json")) {
    return Response.json(await legacyDiscoveryIndex(), { headers: HEADERS });
  }

  const [name, ...rest] = segs;
  if (rest.length === 0) {
    return Response.json({ error: { code: "not_found", message: "파일 경로가 없습니다." } }, { status: 404, headers: HEADERS });
  }
  const filePath = rest.join("/");
  const file = await readPublicSkillFile(name, filePath, hubOriginFromRequest(req));
  if (!file) {
    return Response.json({ error: { code: "not_found", message: "스킬 파일을 찾을 수 없습니다." } }, { status: 404, headers: HEADERS });
  }
  if (filePath === "SKILL.md") await recordSkillInstall(name, installClientKey(req));
  const bytes = file.bytes;
  // 허브 origin에서 올린 파일이 문서로 실행되지 않게 한다(SVG·HTML도 글자 또는 내려받기로만).
  const type = file.contentType.startsWith("text/markdown")
    ? "text/markdown; charset=utf-8"
    : file.contentType.includes("charset=utf-8")
      ? "text/plain; charset=utf-8"
      : "application/octet-stream";
  return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
    headers: {
      ...HEADERS,
      "Content-Type": type,
      "Content-Length": String(bytes.byteLength),
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
