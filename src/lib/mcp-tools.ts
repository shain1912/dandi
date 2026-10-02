import "server-only";
import { z } from "zod";
import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { APP_CATEGORIES, levelLabel, SCHOOL_LEVELS } from "./constants";
import { PRIVACY_QUESTIONS as RUNBOOK_PRIVACY_QUESTIONS } from "./runbook";
import { deploySiteFiles, listMySites, publishSite } from "./sites";
import { getSkill, listPublicSkills, skillInstallCommand } from "./skills";
import type { AppCategory, SchoolLevel, User } from "./types";

// 원격 MCP(<hub>/mcp, F-57) 도구. 계약: docs/v0.2-contracts.md 4장.
// 도구 이름·입력·의미는 CLI의 stdio MCP(dandi mcp, F-58)와 같다. dandi_deploy_folder는 로컬 폴더를 읽어야 하므로 stdio 전용이다.
// 각 도구는 사이트·스킬 lib 함수를 직접 부르고, 결과를 JSON 텍스트로 돌려준다. 실패는 isError와 { error: { code, message, hint } }.

/** 인증을 통과한 요청의 사용자와 허브 주소. /mcp 라우트가 AuthInfo.extra에 담아 넘긴다. */
export interface McpToolContext {
  user: User;
  hub: string;
  via: "cli" | "oauth";
}

export type ToolOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: string; message: string; hint?: string };

/** dandi_deploy_files 한 번에 올릴 수 있는 파일 합계(디코딩 후). 더 큰 사이트는 CLI deploy를 쓴다. */
export const MCP_DEPLOY_MAX_BYTES = 5 * 1024 * 1024;

export const MCP_SERVER_INSTRUCTIONS = [
  "Dandi는 교사가 만든 수업·업무용 미니앱(정적 사이트)을 올리고 학교 허브에 등록하는 서비스입니다.",
  "1) dandi_deploy_files로 사이트 파일(루트 index.html 필수)을 올리면 비공개 미리보기 주소가 나옵니다. 주소를 교사에게 그대로 보여 주십시오.",
  "2) 허브에 등록하려면 dandi_privacy_questions로 셀프점검 5문항을 받아 교사에게 문장 그대로 묻고, 교사가 직접 답하고 확인한 뒤에만 dandi_publish_site를 호출하십시오. 답을 대신 정하거나 추측하지 마십시오.",
  "3) 토큰·비밀번호를 대화창에 요구하지 마십시오. 실제 학생 개인정보를 사이트나 입력값에 넣지 마십시오.",
].join("\n");

/* ---------- 셀프점검 5문항 (F-16) ---------- */

/**
 * 교사에게 물을 5문항. 문항 문장은 런북(src/lib/runbook.ts PRIVACY_QUESTIONS)과 같은 원문을 그대로 쓴다
 * (/llms.txt, stdio MCP, 등록 폼과 문구가 어긋나지 않게 한 곳에서 가져온다).
 */
export const MCP_PRIVACY_QUESTIONS = RUNBOOK_PRIVACY_QUESTIONS.map((q) => ({
  mark: q.mark,
  key: q.key,
  question: q.question,
  answer: q.answer,
  valueFormat: q.type === "boolean" ? "true(예) 또는 false(아니요)" : "문장, 200자 이하",
}));

/** ①이 "예"인데 ⑤가 "아니요"인 답에 돌려주는 안내(에이전트가 ⑤를 스스로 바꾸지 않게 교사에게 다시 묻도록 한다). */
export const APPROVAL_MISMATCH_MESSAGE = "①이 예이면 ⑤도 예여야 합니다. 교사에게 ⑤를 다시 물으십시오.";

const APPROVAL_QUESTION =
  RUNBOOK_PRIVACY_QUESTIONS.find((q) => q.key === "needsSchoolApproval")?.question ?? "학교 내부 승인(운영위원회 등)이 필요합니까?";

export function privacyQuestions(): Record<string, unknown> {
  return {
    instructions:
      "아래 5문항을 교사에게 문장 그대로 묻고, 교사가 직접 답한 내용만 dandi_publish_site의 privacyCheck에 넣으십시오. 답을 대신 정하거나 추측하지 마십시오. 답을 받은 뒤 교사에게 내용을 다시 보여 주고 확인을 받으십시오.",
    questions: MCP_PRIVACY_QUESTIONS,
    rules: [
      '⑤가 "예"이면 승인 대기(①이 "예"면 ⑤도 반드시 "예") 상태로 등록되어, 교사가 승인 완료를 표시하기 전까지 허브 목록과 무로그인 실행에서 빠집니다. ⑤가 "아니요"이면 바로 공개됩니다. (⑤ = privacyCheck.needsSchoolApproval, ① = privacyCheck.collectsStudentData, "예" = true)',
      '이미 공개한 앱을 다시 등록할 때: 새 버전이 승인을 기다리면 결과의 liveVersion이 "kept_until_approval"이고, 승인 완료 표시 전까지 공개 주소(liveUrl)는 이전 버전을 계속 보여 줍니다. 승인받은 앱을 같은 셀프점검 답으로 다시 등록하면 approvalStatus가 "approved"(승인 유지)이고 새 버전이 바로 공개됩니다. 결과의 message를 교사에게 그대로 전하십시오.',
      '①이 "예"인데 ⑤가 "아니요"이면 등록되지 않습니다. ⑤를 스스로 바꾸지 말고 교사에게 ⑤를 다시 물으십시오.',
      "②·③에는 학생 이름·연락처를 적지 마십시오. 개인정보로 보이는 값은 가려서 저장됩니다.",
    ],
    publishFields: {
      title: "앱 이름, 80자 이하",
      description: "어떤 수업·업무에 쓰는 앱인지, 2000자 이하",
      schoolLevels: SCHOOL_LEVELS.map((l) => ({ value: l.id, label: l.label })),
      category: APP_CATEGORIES.map((c) => ({ value: c.id, label: c.label })),
    },
    example: {
      privacyCheck: {
        collectsStudentData: false,
        storageLocation: "저장 안 함(브라우저 안에서만 처리)",
        retention: "저장 안 함",
        externalTransfer: false,
        needsSchoolApproval: false,
      },
    },
  };
}

/* ---------- 도구 구현 (MCP 라이브러리와 무관한 순수 함수) ---------- */

export function toolWhoami(c: McpToolContext): ToolOutcome {
  const { name, role, schoolLevel } = c.user;
  return {
    ok: true,
    data: {
      name,
      role,
      roleLabel: role === "admin" ? "교육청 관리자" : "교사",
      schoolLevel,
      schoolLevelLabel: schoolLevel ? levelLabel(schoolLevel) : null,
      connectedVia: c.via,
      hub: c.hub,
    },
  };
}

export interface DeployFilesInput {
  files: { path: string; content: string; encoding?: "utf8" | "base64" }[];
  siteId?: string;
  slug?: string;
  title?: string;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** 파일 내용을 바이트로 바꾼다. 합계가 한도를 넘으면 그 자리에서 멈춘다. */
export function decodeDeployFiles(
  files: DeployFilesInput["files"],
): { ok: true; files: { path: string; bytes: Uint8Array }[]; totalBytes: number } | Extract<ToolOutcome, { ok: false }> {
  const out: { path: string; bytes: Uint8Array }[] = [];
  let total = 0;
  const encoder = new TextEncoder();
  for (const f of files) {
    let bytes: Uint8Array;
    if (f.encoding === "base64") {
      // 공백·줄바꿈을 지우고 base64url 글자도 표준 base64로 바꿔 받는다.
      const clean = f.content.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
      if (clean.length % 4 === 1 || !BASE64_RE.test(clean)) {
        return { ok: false, code: "invalid_base64", message: `base64 내용이 올바르지 않습니다: ${f.path.slice(0, 200)}` };
      }
      bytes = new Uint8Array(Buffer.from(clean, "base64"));
    } else {
      bytes = encoder.encode(f.content);
    }
    total += bytes.byteLength;
    if (total > MCP_DEPLOY_MAX_BYTES) {
      return {
        ok: false,
        code: "too_large",
        message: `한 번에 올릴 수 있는 파일 합계는 ${MCP_DEPLOY_MAX_BYTES / 1024 / 1024}MB입니다.`,
        hint: "큰 사이트는 터미널에서 dandi deploy 명령으로 올리십시오(20MB까지).",
      };
    }
    out.push({ path: f.path, bytes });
  }
  return { ok: true, files: out, totalBytes: total };
}

export async function toolDeployFiles(c: McpToolContext, input: DeployFilesInput): Promise<ToolOutcome> {
  const decoded = decodeDeployFiles(input.files);
  if (!decoded.ok) return decoded;
  const result = await deploySiteFiles(
    c.user,
    { siteId: input.siteId, slug: input.slug, title: input.title, files: decoded.files },
    c.hub,
  );
  if (!result.ok) return { ok: false, code: result.code, message: result.message, hint: result.hint };
  return {
    ok: true,
    data: {
      ...result.value,
      status: "preview",
      next_step:
        "previewUrl을 교사에게 그대로 보여 주고 확인을 받으십시오. 같은 사이트를 고쳐 다시 올릴 때는 siteId를 함께 보내십시오. 허브에 등록하려면 dandi_privacy_questions로 셀프점검 5문항을 받아 교사에게 물으십시오.",
    },
  };
}

export interface PublishSiteInput {
  siteId: string;
  title: string;
  description: string;
  schoolLevels: SchoolLevel[];
  category: AppCategory;
  privacyCheck: {
    collectsStudentData: boolean;
    storageLocation: string;
    retention: string;
    externalTransfer: boolean;
    needsSchoolApproval: boolean;
  };
}

export async function toolPublishSite(c: McpToolContext, input: PublishSiteInput): Promise<ToolOutcome> {
  if (input.privacyCheck.collectsStudentData && !input.privacyCheck.needsSchoolApproval) {
    return {
      ok: false,
      code: "invalid_publish",
      message: APPROVAL_MISMATCH_MESSAGE,
      hint: `교사가 ⑤ "${APPROVAL_QUESTION}"에 "예"라고 답하면 승인 대기 상태로 등록됩니다. ①의 답이 잘못되었다면 ①도 교사에게 다시 확인하십시오.`,
    };
  }
  const result = await publishSite(
    c.user,
    input.siteId,
    {
      title: input.title,
      description: input.description,
      schoolLevels: input.schoolLevels,
      category: input.category,
      privacyCheck: input.privacyCheck,
    },
    c.hub,
  );
  if (!result.ok) return { ok: false, code: result.code, message: result.message, hint: result.hint };
  // 허브(sites.ts)의 message를 바꾸지 않고 그대로 넘기고, 에이전트용 안내만 따로 붙인다(계약: 결정 4).
  return { ok: true, data: { ...result.value, agent_instructions: publishAgentInstructions(result.value) } };
}

/**
 * dandi_publish_site 결과에 붙이는 에이전트용 안내. 이전 버전이 공개 주소에 남는지는 liveVersion으로 판단한다.
 * approvalStatus: approved(승인 유지) | not_required | pending, liveVersion: updated | kept_until_approval.
 */
export function publishAgentInstructions(v: { approvalStatus: string; liveVersion?: string }): string {
  const verbatim = "Read the message field to the teacher verbatim (it is Korean and already accurate); do not replace it with your own summary.";
  if (v.liveVersion === "kept_until_approval") {
    return (
      `${verbatim} liveVersion is kept_until_approval: this version waits for school approval (⑤ = 예). ` +
      "Until the teacher marks 승인 완료 on the hub, liveUrl keeps serving the previously published version " +
      "(or a 'waiting for school approval' notice if the app was never public), the app is left out of the hub listing, " +
      "and appUrl opens only for the author and admins. Show previewUrl so the teacher can check the new version, and show liveUrl too. " +
      "Never mark approval for the teacher and never change ⑤ to get the app public."
    );
  }
  if (v.approvalStatus === "approved") {
    return (
      `${verbatim} approvalStatus is approved: the privacy answers match the ones the school approved, so approval was kept ` +
      "and liveUrl already serves this new version without a new approval. Show appUrl and liveUrl on their own lines, unchanged, " +
      "and tell the teacher to check with the school again if the content changed a lot since approval."
    );
  }
  return `${verbatim} Show appUrl and liveUrl to the teacher on their own lines, unchanged.`;
}

export async function toolListMySites(c: McpToolContext): Promise<ToolOutcome> {
  const sites = await listMySites(c.user, c.hub);
  return { ok: true, data: { sites } };
}

const SKILL_LIST_MAX = 30;

export async function toolSearchSkills(c: McpToolContext, query?: string): Promise<ToolOutcome> {
  const q = query?.trim().slice(0, 100) || undefined;
  const skills = await listPublicSkills(q, { hub: c.hub });
  return {
    ok: true,
    data: {
      skills: skills.slice(0, SKILL_LIST_MAX).map((s) => ({
        name: s.name,
        title: s.title,
        description: s.description,
        installs: s.installs,
        latestVersion: s.latestVersion,
        hasScripts: s.hasScripts,
        compatibility: s.compatibility,
        installCommand: s.installCommand ?? skillInstallCommand(c.hub, s.name),
        url: s.url ?? `${c.hub}/skills/${s.name}`,
      })),
      total: skills.length,
      next_step: "설치하려면 installCommand를 그대로 실행하십시오. 내용은 dandi_get_skill로 SKILL.md 본문을 읽어 확인하십시오.",
    },
  };
}

export async function toolGetSkill(c: McpToolContext, name: string): Promise<ToolOutcome> {
  const detail = await getSkill(name, { hub: c.hub });
  if (!detail) {
    return {
      ok: false,
      code: "skill_not_found",
      message: "공개된 스킬 중에 그 이름이 없습니다.",
      hint: "dandi_search_skills로 이름을 먼저 찾으십시오.",
    };
  }
  return {
    ok: true,
    data: { ...detail, installCommand: detail.installCommand ?? skillInstallCommand(c.hub, detail.name) },
  };
}

/* ---------- MCP 서버 등록 ---------- */

function toResult(o: ToolOutcome): CallToolResult {
  if (o.ok) return { content: [{ type: "text", text: JSON.stringify(o.data, null, 2) }] };
  const error = { code: o.code, message: o.message, ...(o.hint ? { hint: o.hint } : {}) };
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error }, null, 2) }] };
}

function contextOf(ctx: ServerContext): McpToolContext | null {
  const extra = ctx.http?.authInfo?.extra as Partial<McpToolContext> | undefined;
  if (!extra?.user || typeof extra.hub !== "string") return null;
  return { user: extra.user, hub: extra.hub, via: extra.via === "cli" ? "cli" : "oauth" };
}

async function run(ctx: ServerContext, fn: (c: McpToolContext) => ToolOutcome | Promise<ToolOutcome>): Promise<CallToolResult> {
  const c = contextOf(ctx);
  if (!c) {
    return toResult({
      ok: false,
      code: "unauthorized",
      message: "로그인이 필요합니다.",
      hint: "AI 도구에서 Dandi 연결을 다시 승인하십시오.",
    });
  }
  try {
    return toResult(await fn(c));
  } catch (err) {
    // 요청 내용(파일·토큰)은 남기지 않고 오류 종류만 남긴다.
    console.error("[mcp] tool error:", err instanceof Error ? err.name : "unknown");
    return toResult({ ok: false, code: "internal_error", message: "서버 오류로 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하십시오." });
  }
}

const empty = z.object({});

const schoolLevelSchema = z.enum(["elem", "middle", "high", "special"]);
const categorySchema = z.enum(["class", "work", "guidance", "etc"]);

const deployFilesSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(512).describe("사이트 루트 기준 상대 경로. 예: index.html, assets/app.js"),
        content: z.string().max(7 * 1024 * 1024).describe("파일 내용. encoding이 base64이면 base64 문자열"),
        encoding: z.enum(["utf8", "base64"]).default("utf8").describe("텍스트 파일은 utf8, 이미지 등 바이너리는 base64"),
      }),
    )
    .min(1)
    .max(1000)
    .describe("올릴 파일 전체. 루트에 index.html이 있어야 합니다. 합계 5MB 이하"),
  siteId: z.string().min(1).max(100).optional().describe("이미 올린 사이트에 새 버전을 올릴 때 그 사이트 id"),
  slug: z.string().min(3).max(30).optional().describe("새 사이트 주소 이름(소문자·숫자·하이픈). 없으면 자동으로 정합니다"),
  title: z.string().min(1).max(80).optional().describe("사이트 제목"),
});

const publishSiteSchema = z.object({
  siteId: z.string().min(1).max(100).describe("dandi_deploy_files 결과의 siteId"),
  title: z.string().min(1).max(80).describe("허브에 보일 앱 이름"),
  description: z.string().max(2000).describe("어떤 수업·업무에 쓰는 앱인지"),
  schoolLevels: z.array(schoolLevelSchema).min(1).max(4).describe("대상 학교급: elem(초), middle(중), high(고), special(특수)"),
  category: categorySchema.describe("분류: class(수업), work(업무), guidance(학생지도), etc(기타)"),
  privacyCheck: z
    .object({
      collectsStudentData: z.boolean().describe("① 교사의 답. 예=true, 아니요=false"),
      storageLocation: z.string().min(1).max(200).describe("② 교사의 답(문장)"),
      retention: z.string().min(1).max(200).describe("③ 교사의 답(문장)"),
      externalTransfer: z.boolean().describe("④ 교사의 답. 예=true, 아니요=false"),
      needsSchoolApproval: z.boolean().describe('⑤ 교사의 답. 예=true, 아니요=false. ①이 "예"면 ⑤도 반드시 "예"'),
    })
    .describe("셀프점검 5문항(①~⑤)에 교사가 직접 답한 값"),
});

/** createMcpHandler의 초기화 함수. 요청마다 새 서버에 도구를 등록한다. */
export function registerDandiTools(server: McpServer): void {
  server.registerTool(
    "dandi_whoami",
    {
      title: "내 Dandi 계정",
      description: "연결된 교사 계정의 이름·역할·학교급을 돌려줍니다.",
      inputSchema: empty,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (_args, ctx) => run(ctx, (c) => toolWhoami(c)),
  );

  server.registerTool(
    "dandi_privacy_questions",
    {
      title: "셀프점검 5문항",
      description:
        "허브 등록 전에 교사에게 물어야 할 개인정보 셀프점검 5문항 원문과 답 형식, 등록에 필요한 항목을 돌려줍니다. dandi_publish_site 전에 호출하십시오.",
      inputSchema: empty,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (_args, ctx) => run(ctx, () => ({ ok: true, data: privacyQuestions() })),
  );

  server.registerTool(
    "dandi_deploy_files",
    {
      title: "사이트 파일 올리기(미리보기)",
      description:
        "정적 사이트 파일을 올려 비공개 미리보기 주소를 만듭니다. 허브 공개는 하지 않습니다. 루트 index.html 필수, 합계 5MB 이하. 같은 사이트를 다시 올릴 때는 siteId를 보내십시오. 결과의 previewUrl을 교사에게 그대로 보여 주십시오.",
      inputSchema: deployFilesSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args, ctx) => run(ctx, (c) => toolDeployFiles(c, args)),
  );

  server.registerTool(
    "dandi_publish_site",
    {
      title: "허브에 등록(공개)",
      description:
        "미리보기로 올린 사이트를 Dandi 허브에 미니앱으로 등록하고 공개 주소를 엽니다. 교사가 셀프점검 5문항에 직접 답하고 확인하기 전에는 호출하지 마십시오. " +
        "먼저 dandi_privacy_questions로 문항을 받아 교사에게 문장 그대로 묻고, 답을 대신 정하거나 추측하지 마십시오. " +
        '⑤가 "예"이면 승인 대기(①이 "예"면 ⑤도 반드시 "예") 상태로 등록되어 승인 완료 전까지 새 버전이 공개되지 않습니다' +
        "(이미 공개한 앱이면 그동안 이전 버전이 공개 주소에 남습니다: liveVersion kept_until_approval). " +
        '결과: approvalStatus approved|not_required|pending, liveVersion updated|kept_until_approval, message(교사에게 그대로 전할 한국어 안내). ' +
        "Do not call this tool until the teacher has personally answered and confirmed all five privacy self-check questions.",
      inputSchema: publishSiteSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args, ctx) => run(ctx, (c) => toolPublishSite(c, args)),
  );

  server.registerTool(
    "dandi_list_my_sites",
    {
      title: "내 사이트 목록",
      description: "내가 올린 사이트의 미리보기 주소, 공개 주소, 허브 등록·승인 상태를 돌려줍니다.",
      inputSchema: empty,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (_args, ctx) => run(ctx, (c) => toolListMySites(c)),
  );

  server.registerTool(
    "dandi_search_skills",
    {
      title: "스킬 검색",
      description: "Dandi에 공개된 AI 스킬을 검색합니다. 이름·제목·설명·설치 명령을 돌려줍니다.",
      inputSchema: z.object({ query: z.string().max(100).optional().describe("검색어. 없으면 인기순 목록") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, ctx) => run(ctx, (c) => toolSearchSkills(c, args.query)),
  );

  server.registerTool(
    "dandi_get_skill",
    {
      title: "스킬 상세",
      description: "공개 스킬 하나의 상세 정보와 SKILL.md 본문, 설치 명령을 돌려줍니다.",
      inputSchema: z.object({ name: z.string().min(1).max(64).describe("스킬 이름(소문자·숫자·하이픈)") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, ctx) => run(ctx, (c) => toolGetSkill(c, args.name)),
  );
}
