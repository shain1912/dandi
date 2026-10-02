// dandi mcp: 의존성 없는 stdio MCP 서버(F-58). JSON-RPC 2.0을 한 줄에 메시지 하나씩 주고받는다.
// 도구 이름·의미는 원격 MCP(<hub>/mcp, 계약 4장)와 같고, 모든 동작은 허브 HTTP API로 한다.
// stdout에는 프로토콜 메시지만 쓴다. 진단 메시지는 stderr로 보낸다.

import path from "node:path";
import readline from "node:readline";
import {
  APP_CATEGORIES,
  APPROVAL_RULE,
  CLI_VERSION,
  EXIT,
  PRIVACY_QUESTIONS,
  SCHOOL_LEVELS,
  describeUser,
  fromMsysPath,
  isRecord,
  isValidSkillName,
  privacyQuestionsText,
  redactSecrets,
  sanitizeClientName,
} from "./lib.mjs";
import * as core from "./core.mjs";

/** initialize로 협상하는 프로토콜 버전(최신 순). */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** server/discover(2026-07-28 개정)에서 알리는 버전 */
export const MCP_DISCOVER_VERSIONS = ["2026-07-28"];
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
export const SERVER_INFO = { name: "dandi", title: "Dandi", version: CLI_VERSION };

export const MCP_INSTRUCTIONS = [
  "Dandi는 교사용 미니앱 허브입니다. 교사가 \"내 사이트 올려줘\"라고 하면 다음 순서를 따르십시오.",
  "1) dandi_whoami. 로그인되어 있지 않으면 dandi_login을 호출해 받은 링크와 코드를 교사에게 그대로 보여 주고, 교사가 브라우저에서 승인한 뒤 dandi_login을 다시 호출해 로그인을 확인하십시오.",
  "2) dandi_deploy_folder(로컬 폴더, 빌드 결과 폴더 dist 등) 또는 dandi_deploy_files(파일 내용)로 비공개 미리보기를 만들고 previewUrl을 한 줄에 따로 보여 주십시오. 결과의 skipped에 있는 파일(올리지 않은 파일)은 교사에게 이름을 알려 주고 자료실이나 PDF를 권하십시오.",
  "3) 교사의 요청에 제목·한 줄 설명·학교급·분류와 dandi_privacy_questions 5문항의 답이 이미 모두 있으면 그대로 쓰고 다시 묻지 마십시오. 빠진 항목이 있으면 한 번에 물으십시오. 답을 대신 정하지 마십시오. 이미 공개한 사이트를 고쳐 올릴 때는 지난번 답을 보여 주고 그대로인지 확인하십시오.",
  `4) 모든 답이 교사에게서 나왔으면 dandi_publish_site로 허브에 등록하고, 결과의 message(허브가 준 안내)와 앱 주소, 등록에 쓴 답을 알려 주십시오. liveVersion이 kept_until_approval이면 승인 완료 표시 전까지 공개 주소(liveUrl)는 이전 버전을 보여 줍니다. ${APPROVAL_RULE}입니다.`,
  "토큰·비밀번호·API 키를 대화창에 요구하지 마십시오. 키를 숨기거나 나누어 검사를 피하지 마십시오. 실제 학생 데이터를 예시나 제목에 넣지 마십시오.",
].join("\n");

const PUBLISH_GUARD = "교사가 셀프점검 5문항에 직접 답하고 확인하기 전에는 호출하지 마십시오.";

const siteTargetProps = {
  siteId: { type: "string", description: "다시 올릴 기존 사이트 ID. 없으면 새 사이트를 만듭니다." },
  slug: { type: "string", description: "새 사이트 주소 이름(소문자·숫자·하이픈 3~30자). 선택." },
  title: { type: "string", description: "사이트 제목. 선택." },
};

/** tools/list 결과(계약 4장 + stdio 전용 dandi_login·dandi_deploy_folder). */
export const MCP_TOOLS = [
  {
    name: "dandi_login",
    title: "Dandi 로그인",
    description:
      "브라우저 승인 로그인을 시작하거나 진행 상황을 확인합니다. 결과의 verification_uri_complete와 user_code를 교사에게 그대로 보여 주고 승인하게 한 뒤, 이 도구를 다시 호출하면 로그인이 끝났는지 확인합니다. 토큰을 대화창에 붙여 넣게 하지 마십시오.",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "이미 로그인되어 있어도 새로 로그인합니다(다른 계정으로 바꿀 때). 교사가 계정이 다르다고 확인했을 때만 쓰십시오.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "dandi_whoami",
    title: "로그인한 교사",
    description: "로그인한 교사의 이름·역할·학교급과 허브 주소를 알려 줍니다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dandi_privacy_questions",
    title: "셀프점검 5문항",
    description: "허브 등록 전에 교사에게 그대로 물어야 할 개인정보 셀프점검 5문항과 답 형식을 돌려줍니다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "dandi_deploy_files",
    title: "파일로 미리보기 만들기",
    description:
      "파일 내용을 받아 허브에 비공개 미리보기 사이트를 만듭니다(합계 5MB 이하, 맨 위에 index.html 필수). 결과의 previewUrl을 교사에게 보여 주십시오. 공개 등록은 dandi_publish_site로 따로 합니다.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "올릴 파일 목록",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "사이트 루트 기준 상대 경로(예: index.html, assets/app.js)" },
              content: { type: "string", description: "파일 내용" },
              encoding: { type: "string", enum: ["utf8", "base64"], description: "content 인코딩(기본 utf8, 이미지는 base64)" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
        ...siteTargetProps,
      },
      required: ["files"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "dandi_deploy_folder",
    title: "로컬 폴더로 미리보기 만들기",
    description:
      "이 컴퓨터의 폴더를 읽어 허브에 비공개 미리보기 사이트를 만듭니다. 폴더 맨 위에 index.html이 없으면 그 안의 dist·build·out을 찾습니다. node_modules, .git, .env, 점으로 시작하는 파일, dandi.json은 올리지 않습니다.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "올릴 폴더의 절대 경로(Windows는 C:/Users/... 형식, /c/Users/...도 받음)" },
        ...siteTargetProps,
        newSite: {
          type: "boolean",
          description: "dandi.json의 siteId를 쓰지 않고 새 사이트로 올립니다(이전 siteId는 previousSiteId에 남김). 교사가 확인했을 때만 쓰십시오.",
        },
        allowSource: {
          type: "boolean",
          description: "빌드 전 소스 폴더로 보여도 그대로 올립니다. 교사가 빌드 없이 올려야 한다고 확인했을 때만 쓰십시오.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "dandi_publish_site",
    title: "허브에 등록",
    description: `미리보기로 올린 사이트를 허브 미니앱으로 공개 등록합니다. ${PUBLISH_GUARD} 문항은 dandi_privacy_questions로 받습니다. ${APPROVAL_RULE} 상태로 등록됩니다.`,
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string", description: "dandi_deploy_* 결과의 siteId" },
        deployId: { type: "string", description: "공개할 배포 ID. 없으면 가장 최근 배포" },
        title: { type: "string", description: "앱 이름(80자 이하)" },
        description: { type: "string", description: "한두 문장 설명. 개인정보를 넣지 마십시오." },
        schoolLevels: {
          type: "array",
          items: { type: "string", enum: SCHOOL_LEVELS.map((l) => l.id) },
          description: "대상 학교급: elem(초), middle(중), high(고), special(특수). 교사에게 확인한 값",
        },
        category: {
          type: "string",
          enum: APP_CATEGORIES.map((c) => c.id),
          description: "분류: class(수업), work(업무), guidance(학생지도), etc(기타). 교사에게 확인한 값",
        },
        privacyCheck: {
          type: "object",
          description: "교사가 직접 답한 셀프점검 5항목",
          properties: {
            collectsStudentData: { type: "boolean" },
            storageLocation: { type: "string" },
            retention: { type: "string" },
            externalTransfer: { type: "boolean" },
            needsSchoolApproval: { type: "boolean" },
          },
          required: ["collectsStudentData", "storageLocation", "retention", "externalTransfer", "needsSchoolApproval"],
          additionalProperties: false,
        },
      },
      required: ["siteId", "title", "description", "schoolLevels", "category", "privacyCheck"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "dandi_list_my_sites",
    title: "내 사이트",
    description: "내가 올린 사이트의 미리보기·공개 주소와 승인 상태를 보여 줍니다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dandi_search_skills",
    title: "스킬 찾기",
    description: "허브의 공개 스킬(AI 코딩 도구용 SKILL.md)을 찾고 설치 명령을 보여 줍니다.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "검색어. 비우면 인기 순 목록" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dandi_get_skill",
    title: "스킬 상세",
    description: "스킬의 상세 정보와 SKILL.md 본문을 돌려줍니다.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "스킬 이름(소문자·하이픈)" } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

/** dandi_login을 다시 불렀을 때 승인을 기다리는 최대 시간 */
const LOGIN_WAIT_MS = 20_000;

/**
 * promise가 ms 안에 끝나지 않으면 fallback. 타이머는 끝나면 치운다(프로세스를 붙잡지 않게).
 * @template T, F
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {F} fallback
 * @returns {Promise<T | F>}
 */
function raceTimeout(promise, ms, fallback) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return /** @type {Promise<T | F>} */ (Promise.race([promise, timeout]).finally(() => clearTimeout(timer)));
}

class RpcError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.rpcCode = code;
  }
}

/** @param {unknown} id */
function validId(id) {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

/**
 * @param {string | number | null} id
 * @param {number} code
 * @param {string} message
 */
export function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} max
 * @param {boolean} [required]
 * @returns {string | undefined}
 */
function stringArg(value, name, max, required = false) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new core.CliError("invalid_argument", `${name} 값이 필요합니다.`, { exitCode: EXIT.USAGE });
    return undefined;
  }
  if (typeof value !== "string") throw new core.CliError("invalid_argument", `${name}은 문자열이어야 합니다.`, { exitCode: EXIT.USAGE });
  if (value.length > max) throw new core.CliError("invalid_argument", `${name}은 ${max}자 이하여야 합니다.`, { exitCode: EXIT.USAGE });
  return value.trim();
}

/**
 * @typedef {{ text: string, data: Record<string, unknown> }} ToolOutput
 */

/** @param {ToolOutput} out */
function toolResult(out) {
  const text = `${out.text}\n\n${JSON.stringify(out.data, null, 2)}`;
  return { content: [{ type: "text", text: redactSecrets(text) }], structuredContent: JSON.parse(redactSecrets(JSON.stringify(out.data))) };
}

/** @param {core.CliError} err */
function toolError(err) {
  /** @type {string[]} */
  const lines = [`오류: ${err.message}`];
  if (err.hint) lines.push(`도움말: ${err.hint}`);
  const extra = err.extra ?? {};
  const missing = Array.isArray(extra.missing) ? extra.missing : [];
  const invalid = Array.isArray(extra.invalid_format) ? extra.invalid_format : [];
  const conflicts = Array.isArray(extra.conflicts) ? extra.conflicts : [];
  if (err.exitCode === EXIT.LOGIN_REQUIRED) {
    lines.push("다음 행동: dandi_login 도구를 호출해 받은 링크와 코드를 교사에게 그대로 보여 주고 승인을 받으십시오.");
  } else if (err.exitCode === EXIT.PENDING) {
    lines.push("다음 행동: 교사가 승인한 뒤 dandi_login을 다시 호출해 로그인을 확인하십시오.");
  } else if (err.exitCode === EXIT.PUBLISH_INVALID) {
    if (missing.length || conflicts.length) {
      lines.push("다음 행동: missing·conflicts의 항목을 교사에게 한 번에 직접 묻고 답을 넣어 다시 호출하십시오. 셀프점검을 대신 답하지 마십시오.");
    }
    if (invalid.length) {
      lines.push("다음 행동: invalid_format의 항목은 교사가 이미 답했으므로 다시 묻지 말고 허용값 형식으로만 고쳐 다시 호출하십시오.");
    }
  } else if (err.exitCode === EXIT.UPLOAD_REJECTED && typeof extra.agent_instructions !== "string") {
    lines.push("다음 행동: 도움말에 따라 고친 뒤 다시 올리십시오.");
  }
  const problems = Array.isArray(extra.problems) ? extra.problems.map(String) : [];
  for (const p of problems) lines.push(`  - ${p}`);
  if (typeof extra.agent_instructions === "string") lines.push(extra.agent_instructions);
  const data = {
    ok: false,
    error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) },
    ...extra,
  };
  return {
    content: [{ type: "text", text: redactSecrets(lines.join("\n")) }],
    structuredContent: JSON.parse(redactSecrets(JSON.stringify(data))),
    isError: true,
  };
}

/**
 * @param {Record<string, unknown>} pending
 */
function pendingOutput(pending) {
  const uri = String(pending.verification_uri_complete);
  const code = String(pending.user_code);
  return {
    text: [
      "Dandi 로그인 승인을 기다리고 있습니다. 아래 링크와 코드를 교사에게 그대로 보여 주십시오.",
      uri,
      `코드: ${code}`,
      `교사에게 "링크를 열고, 화면의 코드가 ${code}와 같으면 [승인]을 눌러 주십시오."라고 말하십시오. 승인 뒤 dandi_login을 다시 호출하면 로그인을 확인합니다.`,
    ].join("\n"),
    data: {
      ok: true,
      status: "pending",
      done: false,
      user_code: code,
      verification_uri: String(pending.verification_uri),
      verification_uri_complete: uri,
      expires_in: Number(pending.expires_in),
      agent_instructions:
        "Show verification_uri_complete and user_code to the user exactly as given, ask them to approve in the browser, then call dandi_login again. Repeat while status is pending.",
    },
  };
}

/** 교사가 [거부]를 눌렀을 때. 바로 새 로그인을 시작하지 않고 교사에게 먼저 묻게 한다. */
function deniedOutput() {
  return {
    text: [
      "교사가 브라우저에서 로그인을 거부했습니다. 새 로그인을 바로 시작하지 마십시오.",
      "교사에게 지금 Dandi에 로그인할지 물은 뒤, 원한다고 답하면 dandi_login을 다시 호출하십시오.",
    ].join("\n"),
    data: {
      ok: false,
      status: "denied",
      done: false,
      agent_instructions:
        "The teacher pressed [거부] (deny) in the browser. Do not start a new login on your own. ASK the teacher whether they want to log in to Dandi now; only if they say yes, call dandi_login again.",
    },
  };
}

/**
 * @param {core.DeployResult & Record<string, unknown>} r
 * @param {string} hub
 */
function deployOutput(r, hub) {
  const d = core.describeDeploy(/** @type {Parameters<typeof core.describeDeploy>[0]} */ (r), hub, { publishHow: "call dandi_publish_site" });
  const answers = /** @type {{ complete: boolean, saved: unknown, missing: string[] } | null | undefined} */ (r.answers);
  /** @type {string[]} */
  const lines = [...d.lines, `siteId: ${r.siteId}`];
  lines.push(
    r.published
      ? "다음 행동: previewUrl을 교사에게 보여 주고, 지난번 등록 정보와 셀프점검 답이 그대로인지 확인받은 뒤 dandi_publish_site를 호출하십시오. 그 전까지 공개된 버전은 그대로입니다."
      : "다음 행동: previewUrl을 교사에게 보여 주고, 제목·설명·학교급·분류와 dandi_privacy_questions의 5문항을 교사에게 한 번에 직접 물은 뒤 답을 확인받으면 dandi_publish_site를 호출하십시오.",
  );
  return {
    text: lines.join("\n"),
    data: {
      ok: true,
      status: "preview",
      message: d.message,
      siteId: r.siteId,
      deployId: r.deployId,
      slug: r.slug,
      previewUrl: r.previewUrl,
      ...(r.projectId ? { projectId: r.projectId } : {}),
      warnings: d.warnings,
      notes: d.notes,
      uploaded: r.uploaded,
      reused: r.reused,
      ...(typeof r.folder === "string" ? { folder: r.folder } : {}),
      ...(Array.isArray(r.skipped) ? { skipped: r.skipped } : {}),
      ...(typeof r.manifestFile === "string" ? { manifest: r.manifestFile } : {}),
      published: r.published ?? null,
      ...(answers?.complete ? { saved_answers: answers.saved } : {}),
      ...(d.privacy_questions ? { privacy_questions: d.privacy_questions } : {}),
      ...(typeof r.htmlTitle === "string" && r.htmlTitle ? { suggested_title: r.htmlTitle } : {}),
      agent_instructions: d.agent_instructions,
    },
  };
}

/**
 * stdio MCP 서버. handle(message)는 응답 객체(알림이면 null)를 돌려준다.
 * @param {{ env?: Record<string, string | undefined>, cwd?: string, log?: (text: string) => void }} [options]
 */
export function createMcpServer(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((text) => process.stderr.write(`${redactSecrets(text)}\n`));
  const state = {
    clientName: "",
    /** @type {{ deviceCode: string, promise: Promise<{ status: string, error?: unknown }> } | null} */
    poller: null,
    /** 백그라운드 확인에서 교사가 [거부]한 것을 알았고 아직 에이전트에게 알리지 않았다 */
    deniedNotice: false,
    /** dandi_login force로 시작한 로그인의 device_code(다른 계정으로 바꾸는 중) */
    forcedCode: /** @type {string | null} */ (null),
  };

  function ctx() {
    const client = `mcp:${sanitizeClientName(state.clientName) || "unknown"}`;
    return core.createCtx({ env, cwd, stdinIsTTY: false, client });
  }

  /** 로그인이 필요한 도구용 세션 */
  async function session() {
    const c = ctx();
    const s = await core.trySession(c);
    if (s.token) return { c, s: { hub: s.hub, token: s.token } };
    const pending = await core.loadPending(c);
    if (pending && pending.hub === s.hub && core.remainingSeconds(pending) > 0) {
      throw new core.CliError("authorization_pending", "Dandi 로그인 승인을 기다리는 중입니다.", {
        hint: `교사가 ${pending.verification_uri_complete} 에서 코드 ${pending.user_code}를 확인하고 [승인]을 눌러야 합니다.`,
        exitCode: EXIT.PENDING,
      });
    }
    throw new core.CliError("login_required", `Dandi(${s.hub})에 로그인되어 있지 않습니다.`, {
      hint: "dandi_login 도구로 브라우저 승인 링크를 받으십시오. 토큰을 대화창에 붙여 넣을 필요는 없습니다.",
      exitCode: EXIT.LOGIN_REQUIRED,
    });
  }

  /**
   * 승인 폴링을 백그라운드로 돌린다(같은 device_code면 하나만).
   * @param {ReturnType<typeof ctx>} c
   * @param {core.Pending} pending
   */
  function ensurePoller(c, pending) {
    if (state.poller && state.poller.deviceCode === pending.device_code) return state.poller;
    const timeoutMs = core.remainingSeconds(pending) * 1000 + 5_000;
    const poller = {
      deviceCode: pending.device_code,
      promise: core.waitForApproval(c, pending, { timeoutMs }).catch((error) => ({ status: "error", error })),
    };
    state.poller = poller;
    poller.promise.then((outcome) => {
      if (outcome.status === "denied") state.deniedNotice = true;
      if (state.poller === poller) state.poller = null;
    });
    return poller;
  }

  /** @type {Record<string, (args: Record<string, unknown>) => Promise<ToolOutput>>} */
  const tools = {
    async dandi_login(args) {
      if (args.force !== undefined && typeof args.force !== "boolean") {
        throw new core.CliError("invalid_argument", "force는 true 또는 false여야 합니다.", { exitCode: EXIT.USAGE });
      }
      const force = args.force === true;
      // force로 시작한 새 로그인이 아직 진행 중이면(다시 불러 승인을 확인할 때) 예전 토큰으로 "이미 로그인됨"이라 답하지 않는다.
      const forcedRunning = state.forcedCode !== null && state.poller?.deviceCode === state.forcedCode;
      const c = ctx();
      /** @type {{ hub: string, token: string } | null} */
      let saved = null;
      try {
        saved = await core.loadConfig(c);
      } catch {
        saved = null;
      }
      const hub = await core.resolveHub(c, saved);
      const token = env.DANDI_TOKEN?.trim() || (saved && saved.hub === hub ? saved.token : null);
      if (token && !force && !forcedRunning) {
        try {
          const user = await core.whoami(c, { hub, token });
          return { text: `이미 로그인되어 있습니다: ${describeUser(user)}\n허브: ${hub}`, data: { ok: true, status: "logged_in", done: true, hub, user } };
        } catch (err) {
          if (!(err instanceof core.CliError) || err.exitCode !== EXIT.LOGIN_REQUIRED) throw err;
          log("저장된 토큰이 더 이상 유효하지 않아 로그인을 다시 시작합니다.");
        }
      }
      let pending = await core.loadPending(c);
      if (pending && (pending.hub !== hub || core.remainingSeconds(pending) <= 0)) pending = null;
      // force: 진행 중인 강제 로그인이 없으면 예전 요청을 이어 쓰지 않고 새로 시작한다.
      if (force && !forcedRunning) pending = null;
      if (pending) {
        const poller = ensurePoller(c, pending);
        const outcome = await raceTimeout(poller.promise, LOGIN_WAIT_MS, { status: "pending" });
        if (outcome.status === "logged_in") {
          const user = /** @type {{ user: Record<string, unknown> }} */ (/** @type {unknown} */ (outcome)).user;
          return { text: `로그인했습니다: ${describeUser(user)}\n허브: ${hub}`, data: { ok: true, status: "logged_in", done: true, hub, user } };
        }
        if (outcome.status === "error") throw /** @type {{ error: unknown }} */ (outcome).error;
        if (outcome.status === "pending") return pendingOutput({ ...pending, expires_in: core.remainingSeconds(pending) });
        if (outcome.status === "denied") {
          state.deniedNotice = false;
          return deniedOutput();
        }
        log("로그인 요청이 만료되어 새로 시작합니다.");
      }
      if (state.deniedNotice) {
        // 앞선 요청을 교사가 거부했다. 한 번은 알리고, 교사가 원해서 다시 부르면 새로 시작한다.
        state.deniedNotice = false;
        return deniedOutput();
      }
      const start = await core.deviceStart(c, hub);
      ensurePoller(c, start);
      state.forcedCode = force ? start.device_code : null;
      return pendingOutput(start);
    },

    async dandi_whoami() {
      const { c, s } = await session();
      const user = await core.whoami(c, s);
      return { text: `${describeUser(user)}\n허브: ${s.hub}`, data: { ok: true, status: "logged_in", hub: s.hub, user } };
    },

    async dandi_privacy_questions() {
      return {
        text: privacyQuestionsText(),
        data: {
          ok: true,
          questions: PRIVACY_QUESTIONS,
          schoolLevels: SCHOOL_LEVELS,
          categories: APP_CATEGORIES,
          rule: `${APPROVAL_RULE}. collectsStudentData가 true이면 needsSchoolApproval도 true여야 합니다.`,
        },
      };
    },

    async dandi_deploy_files(args) {
      const siteId = stringArg(args.siteId, "siteId", 64);
      const slug = stringArg(args.slug, "slug", 64);
      const title = stringArg(args.title, "title", 80);
      const { c, s } = await session();
      const guide = { prefix: core.prefixFor(c, s.hub), hub: s.hub, retry: null };
      const files = core.decodeInlineFiles(args.files, guide);
      let r;
      try {
        r = await core.uploadSite(c, s, files, { siteId, slug, title }, { guide });
      } catch (err) {
        if (err instanceof core.CliError && err.code === "site_not_found" && siteId) {
          throw await core.explainSiteNotFound(c, s, err, {
            siteId,
            fromManifest: false,
            via: "mcp",
            newSiteAction: "call dandi_deploy_files again without siteId (a new site is created)",
          });
        }
        throw err;
      }
      const published = await core.publishedInfo(c, s, r.siteId);
      return deployOutput({ ...r, published }, s.hub);
    },

    async dandi_deploy_folder(args) {
      const p = /** @type {string} */ (stringArg(args.path, "path", 1024, true));
      const siteId = stringArg(args.siteId, "siteId", 64);
      const slug = stringArg(args.slug, "slug", 64);
      const title = stringArg(args.title, "title", 80);
      for (const name of ["newSite", "allowSource"]) {
        if (args[name] !== undefined && typeof args[name] !== "boolean") {
          throw new core.CliError("invalid_argument", `${name}은 true 또는 false여야 합니다.`, { exitCode: EXIT.USAGE });
        }
      }
      if (args.newSite === true && siteId) {
        throw new core.CliError("invalid_argument", "newSite와 siteId는 함께 쓸 수 없습니다.", { exitCode: EXIT.USAGE });
      }
      const { c, s } = await session();
      // Git Bash(MSYS) 형식 경로(/c/Users/...)는 Windows 경로로 바꾼다.
      const abs = path.resolve(cwd, fromMsysPath(p));
      const r = await core.deployFolder(c, s, {
        folder: abs,
        projectDir: abs,
        siteId,
        newSite: args.newSite === true,
        slug,
        title,
        manifestMode: "update",
        via: "mcp",
        allowSource: args.allowSource === true,
      });
      return deployOutput(r, s.hub);
    },

    async dandi_publish_site(args) {
      const siteId = /** @type {string} */ (stringArg(args.siteId, "siteId", 64, true));
      const deployId = stringArg(args.deployId, "deployId", 64);
      const title = stringArg(args.title, "title", 200);
      const description = typeof args.description === "string" ? args.description : "";
      if (description.length > 4000) throw new core.CliError("invalid_argument", "description은 2000자 이하여야 합니다.", { exitCode: EXIT.USAGE });
      const { c, s } = await session();
      const payload = core.checkManifest(
        { title, description, url: "", schoolLevels: args.schoolLevels, category: args.category, privacyCheck: args.privacyCheck },
        core.prefixFor(c, s.hub),
        { requireUrl: false },
      );
      let r;
      try {
        r = await core.publishSite(c, s, siteId, payload, deployId);
      } catch (err) {
        if (err instanceof core.CliError && err.code === "site_not_found") {
          throw await core.explainSiteNotFound(c, s, err, {
            siteId,
            fromManifest: false,
            via: "mcp",
            newSiteAction:
              "upload the site again as a new site (dandi_deploy_folder with newSite: true, or dandi_deploy_files without siteId) and publish the new siteId",
          });
        }
        throw err;
      }
      // 허브가 준 message를 그대로 쓴다(승인 유지·이전 버전 유지 설명 포함).
      const p = core.describePublish(r);
      const lines = [`허브에 등록했습니다: ${payload.title}`, `앱 주소: ${r.appUrl}`];
      if (r.liveUrl) lines.push(`${p.keepsLive ? "공개 주소(승인 전까지 이전 버전)" : "공개 주소"}: ${r.liveUrl}`);
      if (p.keepsLive && typeof r.previewUrl === "string") lines.push(`새 버전 미리보기: ${r.previewUrl}`);
      lines.push(p.message, p.agent_instructions);
      return {
        text: lines.join("\n"),
        data: { ok: true, status: "published", title: payload.title, ...r, message: p.message, agent_instructions: p.agent_instructions },
      };
    },

    async dandi_list_my_sites() {
      const { c, s } = await session();
      const sites = await core.listMySites(c, s);
      const lines = sites.length ? [`사이트 ${sites.length}개`] : ["올린 사이트가 없습니다."];
      for (const site of sites) {
        const status = site.approvalStatus === "pending" ? "승인 대기" : site.liveUrl ? "공개" : "미리보기";
        lines.push(`- ${String(site.title ?? site.slug ?? site.id)} (${status}) ${String(site.liveUrl ?? site.previewUrl ?? "")}`.trim());
      }
      return { text: lines.join("\n"), data: { ok: true, sites } };
    },

    async dandi_search_skills(args) {
      const query = stringArg(args.query, "query", 100) ?? "";
      const c = ctx();
      let s;
      try {
        s = await core.trySession(c);
      } catch {
        s = { hub: await core.resolveHub(c, null), token: null };
      }
      const skills = await core.listSkills(c, s, query);
      const lines = skills.length ? [`스킬 ${skills.length}개`] : ["찾은 스킬이 없습니다."];
      for (const k of skills.slice(0, 30)) {
        lines.push(`- ${String(k.name)}: ${String(k.title ?? "")} — ${String(k.description ?? "")}`);
        if (k.installCommand) lines.push(`  설치: ${String(k.installCommand)}`);
      }
      return { text: lines.join("\n"), data: { ok: true, skills } };
    },

    async dandi_get_skill(args) {
      const name = /** @type {string} */ (stringArg(args.name, "name", 64, true));
      if (!isValidSkillName(name)) {
        throw new core.CliError("invalid_argument", "스킬 이름은 소문자·숫자·하이픈 64자 이하입니다.", { exitCode: EXIT.USAGE });
      }
      const c = ctx();
      let s;
      try {
        s = await core.trySession(c);
      } catch {
        s = { hub: await core.resolveHub(c, null), token: null };
      }
      const skill = await core.getSkill(c, s, name);
      const lines = [`${name}: ${String(skill.title ?? "")}`, String(skill.description ?? "")];
      if (skill.installCommand) lines.push(`설치: ${String(skill.installCommand)}`);
      if (typeof skill.skillMd === "string") lines.push("", "--- SKILL.md ---", skill.skillMd);
      return { text: lines.join("\n"), data: { ok: true, skill } };
    },
  };

  /** @param {Record<string, unknown>} params */
  async function callTool(params) {
    const name = typeof params.name === "string" ? params.name : "";
    if (!Object.hasOwn(tools, name)) throw new RpcError(-32602, `Unknown tool: ${name}`);
    const args = isRecord(params.arguments) ? params.arguments : {};
    try {
      return toolResult(await tools[name](args));
    } catch (err) {
      if (err instanceof core.CliError) return toolError(err);
      log(`도구 ${name} 실행 중 오류: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return toolError(new core.CliError("internal_error", "도구를 실행하지 못했습니다.", { hint: core.errText(err) }));
    }
  }

  /**
   * @param {unknown} msg
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function handle(msg) {
    if (!isRecord(msg) || msg.jsonrpc !== "2.0") {
      return rpcError(isRecord(msg) && validId(msg.id) ? /** @type {string | number} */ (msg.id) : null, -32600, "Invalid Request");
    }
    if (typeof msg.method !== "string") {
      // 클라이언트가 보낸 응답(서버는 요청을 보내지 않으므로 무시)
      if ("result" in msg || "error" in msg) return null;
      return rpcError(validId(msg.id) ? /** @type {string | number} */ (msg.id) : null, -32600, "Invalid Request");
    }
    const params = isRecord(msg.params) ? msg.params : {};
    const meta = isRecord(params._meta) ? params._meta : {};
    const metaClient = meta[CLIENT_INFO_META_KEY];
    if (isRecord(metaClient) && typeof metaClient.name === "string") state.clientName = metaClient.name;
    if (!("id" in msg)) return null; // 알림(notifications/initialized, notifications/cancelled 등)
    if (!validId(msg.id)) return rpcError(null, -32600, "Invalid Request");
    const id = /** @type {string | number} */ (msg.id);
    const modern = typeof meta[PROTOCOL_VERSION_META_KEY] === "string";
    /** @param {Record<string, unknown>} result */
    const ok = (result) => ({
      jsonrpc: "2.0",
      id,
      result: modern ? { ...result, _meta: { [SERVER_INFO_META_KEY]: SERVER_INFO } } : result,
    });
    try {
      switch (msg.method) {
        case "initialize": {
          const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
          if (isRecord(params.clientInfo) && typeof params.clientInfo.name === "string") state.clientName = params.clientInfo.name;
          return ok({
            protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: MCP_INSTRUCTIONS,
          });
        }
        case "server/discover":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              supportedVersions: MCP_DISCOVER_VERSIONS,
              capabilities: { tools: { listChanged: false } },
              instructions: MCP_INSTRUCTIONS,
              _meta: { [SERVER_INFO_META_KEY]: SERVER_INFO },
            },
          };
        case "ping":
          return ok({});
        case "tools/list":
          return ok({ tools: MCP_TOOLS });
        case "tools/call":
          return ok(await callTool(params));
        case "resources/list":
          return ok({ resources: [] });
        case "resources/templates/list":
          return ok({ resourceTemplates: [] });
        case "prompts/list":
          return ok({ prompts: [] });
        default:
          return rpcError(id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      if (err instanceof RpcError) return rpcError(id, err.rpcCode, err.message);
      log(`요청 처리 중 오류: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return rpcError(id, -32603, "Internal error");
    }
  }

  return { handle, tools: MCP_TOOLS };
}

/**
 * 표준입출력으로 MCP 서버를 실행한다. 입력이 끝나면 처리 중인 요청을 마치고 돌아온다.
 * @param {{ env?: Record<string, string | undefined>, cwd?: string, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [options]
 */
export async function runMcpStdio(options = {}) {
  const server = createMcpServer(options);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  /** @param {unknown} obj */
  const write = (obj) => {
    output.write(`${JSON.stringify(obj)}\n`);
  };
  const inflight = new Set();
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    if (line.length > 16 * 1024 * 1024) {
      write(rpcError(null, -32600, "Message too large"));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write(rpcError(null, -32700, "Parse error"));
      return;
    }
    const task = (async () => {
      if (Array.isArray(msg)) {
        const results = (await Promise.all(msg.map((m) => server.handle(m)))).filter(Boolean);
        if (results.length) write(results);
      } else {
        const res = await server.handle(msg);
        if (res) write(res);
      }
    })().catch((err) => {
      process.stderr.write(`${redactSecrets(String(err))}\n`);
    });
    inflight.add(task);
    task.finally(() => inflight.delete(task));
  });
  await new Promise((resolve) => rl.on("close", () => resolve(undefined)));
  await Promise.allSettled([...inflight]);
  await new Promise((resolve) => output.write("", () => resolve(undefined)));
}
