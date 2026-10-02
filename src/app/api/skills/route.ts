import { revalidatePath } from "next/cache";
import { agentAuthError, apiError, authenticateAgent } from "@/lib/agent-auth";
import { isSchoolLevel } from "@/lib/constants";
import { hubOriginFromRequest } from "@/lib/origin";
import {
  formatFinding,
  isSkillTool,
  listPublicSkills,
  publishSkill,
  SKILL_LIMITS,
  skillInstallCommand,
  type SkillInputFile,
  type SkillSort,
} from "@/lib/skills";

// F-37·F-38 스킬 API.
//   GET  /api/skills?q=&level=&tool=&sort=  → 공개 승인 스킬 목록(로그인 불필요)
//   POST /api/skills                         → 스킬 게시(CLI 토큰 또는 OAuth 접근 토큰, 교사·관리자)
//        요청 { files: [{ path, contentBase64 }], title?, schoolLevels?, compatibility?, folder? }
//        응답 201 { name, version, status, findings, findingDetails, hasScripts, unchanged, url, installCommand }
//        findings는 사람이 읽는 문장 배열("[검토] scripts/run.sh:1 ..."), findingDetails는 { severity, rule, path, line?, message } 배열

// 10MB 한도의 base64(약 4/3배)와 JSON 여유분
const MAX_BODY_CHARS = Math.ceil((SKILL_LIMITS.totalBytes * 4) / 3) + 512 * 1024;
const MAX_FILE_B64 = Math.ceil((SKILL_LIMITS.fileBytes * 4) / 3) + 8;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? undefined;
  const level = url.searchParams.get("level");
  const tool = url.searchParams.get("tool");
  const sortParam = url.searchParams.get("sort");
  const sort: SkillSort = sortParam === "recent" || sortParam === "name" ? sortParam : "installs";
  const hub = hubOriginFromRequest(req);
  const skills = await listPublicSkills(q?.slice(0, 100), {
    level: isSchoolLevel(level) ? level : undefined,
    tool: isSkillTool(tool) ? tool : undefined,
    sort,
    hub,
  });
  return Response.json({
    skills: skills.map((s) => ({
      name: s.name,
      title: s.title,
      description: s.description,
      installs: s.installs,
      latestVersion: s.latestVersion,
      hasScripts: s.hasScripts,
      status: s.status,
      installCommand: skillInstallCommand(hub, s.name),
      url: `${hub}/skills/${s.name}`,
      license: s.license,
      schoolLevels: s.schoolLevels,
      compatibility: s.compatibility,
      authorName: s.authorName,
      updatedAt: s.updatedAt,
    })),
  });
}

function invalid(message: string, hint?: string): Response {
  return apiError(422, "invalid_skill", message, hint);
}

/** 없으면 undefined, 문자열 배열이 아니면 null(오류). */
function stringList(value: unknown): string[] | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 20 || !value.every((v) => typeof v === "string" && v.length <= 40)) return null;
  return value as string[];
}

export async function POST(req: Request) {
  const auth = await authenticateAgent(req);
  if (!auth.ok) return agentAuthError(auth);

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_CHARS) return apiError(413, "payload_too_large", "요청이 너무 큽니다. 스킬 전체 크기는 10MB까지입니다.");
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return apiError(413, "payload_too_large", "요청이 너무 큽니다. 스킬 전체 크기는 10MB까지입니다.");

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return apiError(400, "invalid_json", "요청 본문이 올바른 JSON 객체가 아닙니다.");
  }

  const list = body.files;
  if (!Array.isArray(list) || list.length === 0) {
    return invalid("files에 스킬 파일을 하나 이상 넣으십시오.", "형식: { \"files\": [{ \"path\": \"SKILL.md\", \"contentBase64\": \"...\" }] }");
  }
  if (list.length > SKILL_LIMITS.fileCount) return invalid(`파일은 ${SKILL_LIMITS.fileCount}개까지 올릴 수 있습니다.`);
  const files: SkillInputFile[] = [];
  for (const item of list) {
    const f = item as { path?: unknown; contentBase64?: unknown };
    if (!f || typeof f.path !== "string" || typeof f.contentBase64 !== "string") {
      return invalid("각 파일은 path와 contentBase64 문자열이 있어야 합니다.");
    }
    if (f.path.length > SKILL_LIMITS.pathLength * 2) return invalid("파일 경로가 너무 깁니다.");
    const b64 = f.contentBase64.replace(/\s+/g, "");
    if (b64.length > MAX_FILE_B64) return invalid("파일 하나는 2MB까지 올릴 수 있습니다.", `파일: ${f.path.slice(0, 120)}`);
    if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return invalid("contentBase64가 올바른 base64가 아닙니다.", `파일: ${f.path.slice(0, 120)}`);
    const buf = Buffer.from(b64, "base64");
    files.push({ path: f.path, bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) });
  }

  const title = typeof body.title === "string" ? body.title.slice(0, 200) : undefined;
  const folder = typeof body.folder === "string" ? body.folder.slice(0, 200) : undefined;
  const schoolLevels = stringList(body.schoolLevels);
  const compatibility = stringList(body.compatibility);
  if (schoolLevels === null || (schoolLevels && schoolLevels.some((l) => !isSchoolLevel(l)))) {
    return invalid("schoolLevels에는 elem, middle, high, special만 쓸 수 있습니다.");
  }
  if (compatibility === null || (compatibility && compatibility.some((t) => !isSkillTool(t)))) {
    return invalid("compatibility에는 claude-code, cursor, codex만 쓸 수 있습니다.");
  }

  const result = await publishSkill(auth.user, files, {
    title,
    folder,
    schoolLevels: schoolLevels ?? undefined,
    compatibility: compatibility ?? undefined,
  });
  if (!result.ok) {
    return Response.json(
      {
        error: { code: result.code, message: result.message, ...(result.hint ? { hint: result.hint } : {}) },
        ...(result.findings ? { findings: result.findings.map(formatFinding), findingDetails: result.findings } : {}),
      },
      { status: result.status },
    );
  }

  revalidatePath("/skills");
  revalidatePath(`/skills/${result.value.name}`);
  revalidatePath("/admin/skills");
  const hub = hubOriginFromRequest(req);
  return Response.json(
    {
      ...result.value,
      findings: result.value.findings.map(formatFinding),
      findingDetails: result.value.findings,
      url: `${hub}/skills/${result.value.name}`,
      installCommand: skillInstallCommand(hub, result.value.name),
    },
    { status: 201 },
  );
}
