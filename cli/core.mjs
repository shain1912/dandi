// dandi CLI와 stdio MCP 서버가 함께 쓰는 입출력(설정 파일, 허브 HTTP API, 폴더 읽기, 업로드).
// 허브와는 HTTP로만 이야기한다(계약 2-3, 3-1, 6). 토큰은 Authorization 헤더로만 보내고 어떤 출력에도 넣지 않는다.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVAL_RULE,
  BUILD_DIRS,
  CLI_NAME,
  CLI_TAG,
  DEFAULT_HUB,
  DEPLOY_FILES_MAX_BYTES,
  EXIT,
  MANIFEST_FILE,
  POWERSHELL_UTF8_HINT,
  PRIVACY_QUESTIONS,
  REPLACEMENT_CHAR,
  SECRET_AGENT_INSTRUCTIONS,
  SITE_LIMITS,
  SKILL_LIMITS,
  buildFileManifest,
  clampInterval,
  commandWithFolder,
  configPath,
  decodeJsonBytes,
  defaultManifest,
  detectAgent,
  displayPath,
  exitCodeFor,
  formatBytes,
  hubFromInstallSpec,
  isBuildConfigFile,
  isExcludedPath,
  isRecord,
  manifestString,
  normalizeApiError,
  normalizeHub,
  npxPrefix,
  nextStep,
  packageBuildSignals,
  parseConfig,
  parseLatestInfo,
  parsePending,
  pendingPath,
  savedAnswers,
  scanSecrets,
  secretGuidance,
  shellArg,
  siteFolderCandidates,
  siteLimitProblems,
  sitePathProblem,
  sourceModuleReference,
  splitAllowedFiles,
  titleFromHtml,
  validateManifest,
  withSecretGuidance,
} from "./lib.mjs";

/**
 * 사용자에게 보여 줄 예상된 오류. code·hint·다음 명령·종료 코드를 함께 담는다.
 * nextStep이 null이면 "다음 실행" 명령을 내지 않는다(그대로 실행할 수 있는 명령이 없을 때).
 */
export class CliError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ hint?: string, nextStep?: string | null, nextStepTemplate?: string, exitCode?: number, extra?: Record<string, unknown> }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.code = code;
    this.hint = options.hint;
    /** @type {string | null | undefined} */
    this.nextStep = options.nextStep;
    this.nextStepTemplate = options.nextStepTemplate;
    this.exitCode = options.exitCode ?? exitCodeFor(code);
    /** @type {Record<string, unknown> | undefined} */
    this.extra = options.extra;
  }
}

/** @param {unknown} err */
export function errCode(err) {
  return typeof err === "object" && err !== null && "code" in err ? String(/** @type {{code: unknown}} */ (err).code) : "";
}

/** @param {unknown} err */
export function errText(err) {
  if (err instanceof Error) {
    const cause = /** @type {{ cause?: unknown }} */ (err).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return err.message;
  }
  return String(err);
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/* ---------- 실행 맥락 ---------- */

/**
 * @typedef {object} Ctx
 * @property {Record<string, string | undefined>} env
 * @property {string} cwd
 * @property {string | undefined} flagHub --hub 값
 * @property {boolean} agent 에이전트·비대화형 환경인가
 * @property {string} client device 로그인 요청에 적을 도구 이름
 */

/**
 * @param {{ env?: Record<string, string | undefined>, cwd?: string, flagHub?: string, stdinIsTTY?: boolean, client?: string }} [options]
 * @returns {Ctx}
 */
export function createCtx(options = {}) {
  const env = options.env ?? process.env;
  const detected = detectAgent(env, options.stdinIsTTY ?? Boolean(process.stdin.isTTY));
  return {
    env,
    cwd: options.cwd ?? process.cwd(),
    flagHub: options.flagHub,
    agent: detected.agent,
    client: options.client ?? detected.client,
  };
}

let installHubCache = /** @type {string | null | undefined} */ (undefined);

/**
 * npx·npm으로 tarball을 설치해 실행했다면 설치 폴더의 package.json에서 허브 주소를 읽는다.
 * (…/node_modules/dandi/ 의 두 단계 위 package.json)
 */
export async function installHub() {
  if (installHubCache !== undefined) return installHubCache;
  installHubCache = null;
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (path.basename(path.dirname(here)) !== "node_modules") return null;
  try {
    const pkg = JSON.parse(await fs.readFile(path.resolve(here, "..", "..", "package.json"), "utf8"));
    installHubCache = hubFromInstallSpec(pkg);
  } catch {
    installHubCache = null;
  }
  return installHubCache;
}

/**
 * 허브 주소를 정한다. --hub > DANDI_HUB > 실행한 tarball의 허브 > 저장된 설정 > 기본값.
 * @param {Ctx} ctx
 * @param {{ hub: string, token: string } | null} saved
 */
export async function resolveHub(ctx, saved) {
  const explicit = ctx.flagHub ?? (ctx.env.DANDI_HUB?.trim() || undefined);
  if (explicit) {
    const hub = normalizeHub(explicit);
    if (!hub) {
      throw new CliError("usage", `허브 주소가 올바르지 않습니다: ${explicit}`, {
        hint: `http:// 또는 https://로 시작하는 주소를 쓰십시오. 예: ${DEFAULT_HUB}`,
        exitCode: EXIT.USAGE,
      });
    }
    return hub;
  }
  return (await installHub()) ?? saved?.hub ?? DEFAULT_HUB;
}

/**
 * 안내 명령 접두어(현재 허브와 이 빌드의 npx tarball 형식).
 * @param {Ctx} ctx
 * @param {string} hub
 */
export function prefixFor(ctx, hub) {
  return npxPrefix(hub, ctx.env);
}

/** @param {Ctx} ctx @param {string} hub */
export function loginNextStep(ctx, hub) {
  return nextStep(prefixFor(ctx, hub), ctx.agent ? "login --json" : "login");
}

/* ---------- 설정 파일 (~/.dandi, 0700 / 0600) ---------- */

const RETRY_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * rename을 재시도한다. Windows에서는 백신·색인 프로그램이 막 만든 파일을 잠깐 잠가 EPERM/EACCES/EBUSY가 난다.
 * @param {string} from
 * @param {string} to
 * @param {(from: string, to: string) => Promise<void>} [rename]
 * @param {number} [attempts]
 */
export async function renameWithRetry(from, to, rename = fs.rename, attempts = 8) {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (!RETRY_RENAME_CODES.has(errCode(err)) || i >= attempts - 1) throw err;
      await sleep(Math.min(1000, 25 * 2 ** i));
    }
  }
}

/**
 * @param {string} file
 * @param {unknown} value
 */
async function writePrivateJson(file, value) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // 권한 비트를 지원하지 않는 파일 시스템(Windows 등)에서는 사용자 프로필 권한에 맡긴다.
  }
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, text, { mode: 0o600 });
    try {
      await fs.chmod(tmp, 0o600);
    } catch {
      // 위와 같음
    }
    await renameWithRetry(tmp, file);
  } catch (err) {
    // 임시 파일이 잠겨 옮기지 못했으면 제자리에 한 번 더 써 본다.
    try {
      await fs.writeFile(file, text, { mode: 0o600 });
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw new CliError("config_save_failed", `설정 파일을 저장하지 못했습니다: ${file}`, {
        hint: `원인: ${errText(err)}. 백신 프로그램이나 다른 프로그램이 파일을 잠갔을 수 있습니다. 잠시 뒤 다시 실행하십시오.`,
        exitCode: EXIT.ERROR,
        nextStep: null,
      });
    }
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * JSON \uD30C\uC77C\uC744 \uC77D\uB294\uB2E4. UTF-8(BOM \uD3EC\uD568)\uACFC UTF-16LE/BE(Windows PowerShell 5.1\uC758 Out-File\u00B7>)\uB97C \uC77D\uACE0,
 * UTF-8\uB85C \uC77D\uC744 \uC218 \uC5C6\uB294 \uBC14\uC774\uD2B8(ANSI\u00B7CP949\uB85C \uC800\uC7A5\uD55C \uD30C\uC77C)\uB098 \uAE68\uC9C4 \uAE00\uC790(U+FFFD)\uAC00 \uC788\uC73C\uBA74 encodingProblem\uC73C\uB85C \uC54C\uB824 \uC900\uB2E4.
 * @param {string} file
 * @returns {Promise<{ exists: boolean, value: unknown, encodingProblem: null | "invalid_utf8" | "replacement_char" }>}
 */
async function readJsonFile(file) {
  let bytes;
  try {
    bytes = await fs.readFile(file);
  } catch (err) {
    if (errCode(err) === "ENOENT") return { exists: false, value: null, encodingProblem: null };
    throw err;
  }
  const decoded = decodeJsonBytes(new Uint8Array(bytes));
  let value;
  try {
    value = JSON.parse(decoded.text);
  } catch {
    value = undefined;
  }
  return { exists: true, value, encodingProblem: decoded.problem };
}

/** @param {Ctx} ctx */
export async function loadConfig(ctx) {
  const file = configPath(ctx.env);
  const { exists, value } = await readJsonFile(file);
  if (!exists) return null;
  const parsed = parseConfig(value);
  if (!parsed) {
    throw new CliError("config_invalid", `설정 파일을 읽을 수 없습니다: ${file}`, {
      hint: "파일을 지우거나 로그인을 다시 하십시오.",
      exitCode: EXIT.LOGIN_REQUIRED,
    });
  }
  return parsed;
}

/**
 * @param {Ctx} ctx
 * @param {{ hub: string, token: string, user?: unknown }} config
 */
export async function saveConfig(ctx, config) {
  const file = configPath(ctx.env);
  await writePrivateJson(file, { hub: config.hub, token: config.token, user: config.user ?? null, savedAt: new Date().toISOString() });
  return file;
}

/** @param {Ctx} ctx @returns {Promise<boolean>} 지운 파일이 있었는가 */
export async function deleteConfig(ctx) {
  let removed = false;
  for (const file of [configPath(ctx.env), pendingPath(ctx.env)]) {
    try {
      await fs.unlink(file);
      if (file === configPath(ctx.env)) removed = true;
    } catch (err) {
      if (errCode(err) !== "ENOENT") throw err;
    }
  }
  return removed;
}

/** @param {Ctx} ctx */
export async function loadPending(ctx) {
  const { value } = await readJsonFile(pendingPath(ctx.env));
  return value ? parsePending(value) : null;
}

/**
 * @param {Ctx} ctx
 * @param {Record<string, unknown>} pending
 */
export async function savePending(ctx, pending) {
  await writePrivateJson(pendingPath(ctx.env), pending);
}

/** @param {Ctx} ctx */
export async function deletePending(ctx) {
  try {
    await fs.unlink(pendingPath(ctx.env));
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
}

/**
 * 토큰이 있는 세션. DANDI_TOKEN이 있으면 그것을, 없으면 같은 허브로 저장된 토큰을 쓴다.
 * @param {Ctx} ctx
 * @returns {Promise<{ hub: string, token: string | null }>}
 */
export async function trySession(ctx) {
  const envToken = ctx.env.DANDI_TOKEN?.trim() || null;
  /** @type {{ hub: string, token: string } | null} */
  let saved = null;
  try {
    saved = await loadConfig(ctx);
  } catch (err) {
    if (!envToken) throw err;
  }
  const hub = await resolveHub(ctx, saved);
  const token = envToken ?? (saved && saved.hub === hub ? saved.token : null);
  return { hub, token };
}

/**
 * 로그인이 필요한 명령용. 토큰이 없으면 종료 코드 4.
 * @param {Ctx} ctx
 * @returns {Promise<{ hub: string, token: string }>}
 */
export async function requireSession(ctx) {
  const s = await trySession(ctx);
  if (!s.token) {
    throw new CliError("login_required", `${s.hub}에 로그인되어 있지 않습니다.`, {
      hint: "브라우저 승인으로 로그인하십시오. 토큰을 대화창에 붙여 넣을 필요는 없습니다.",
      nextStep: loginNextStep(ctx, s.hub),
    });
  }
  return { hub: s.hub, token: s.token };
}

/* ---------- 허브 HTTP ---------- */

/**
 * @typedef {{ status: number, ok: boolean, data: unknown, text: string }} HubResponse
 */

/**
 * 허브에 연결하지 못했을 때의 오류. 죽은 허브에서 tarball을 받아야 하는 명령은 안내하지 않는다.
 * @param {string} hub
 * @param {unknown} err
 */
export function networkError(hub, err) {
  return new CliError("network_error", `허브(${hub})에 연결할 수 없습니다.`, {
    hint: `허브가 실행 중인지, 주소가 맞는지 확인하십시오. 원인: ${errText(err)}`,
    exitCode: EXIT.ERROR,
    nextStep: null,
    extra: {
      agent_instructions: `The Dandi hub at ${hub} is not reachable. Do not retry on your own. Tell the teacher and ask them to start the hub or check the hub address, then try again after they confirm.`,
    },
  });
}

/**
 * 허브 API를 부른다. 연결 자체가 실패하면 CliError(network_error).
 * @param {string} hub
 * @param {string} method
 * @param {string} pathname
 * @param {{ token?: string | null, json?: unknown, body?: Uint8Array, contentType?: string, accept?: string, timeoutMs?: number }} [options]
 * @returns {Promise<HubResponse>}
 */
export async function hubRequest(hub, method, pathname, options = {}) {
  /** @type {Record<string, string>} */
  const headers = { Accept: options.accept ?? "application/json", "User-Agent": `${CLI_NAME}/${CLI_TAG}` };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  /** @type {BodyInit | undefined} */
  let body;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.body) {
    headers["Content-Type"] = options.contentType ?? "application/octet-stream";
    body = /** @type {BodyInit} */ (/** @type {unknown} */ (options.body));
  }
  let res;
  try {
    res = await fetch(`${hub}${pathname}`, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw networkError(hub, err);
  }
  if (res.status >= 300 && res.status < 400) {
    // 토큰이 다른 주소로 따라가지 않게 리다이렉트는 따르지 않는다.
    throw new CliError("hub_redirect", `허브가 다른 주소로 보내려고 합니다: ${res.headers.get("location") ?? "(주소 없음)"}`, {
      hint: "--hub 또는 DANDI_HUB에 최종 허브 주소(https 포함)를 적으십시오.",
      exitCode: EXIT.ERROR,
    });
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, data, text };
}

/**
 * 허브 오류 응답을 CliError로 바꾼다.
 * @param {Ctx} ctx
 * @param {string} hub
 * @param {HubResponse} res
 * @param {"login" | "deploy" | "publish" | "skill_publish" | "other"} phase
 * @param {{ nextStep?: string | null, nextStepTemplate?: string, hint?: string }} [defaults]
 */
export function apiFailure(ctx, hub, res, phase, defaults = {}) {
  const e = normalizeApiError(res.status, res.data);
  let exitCode = exitCodeFor(e.code, phase);
  if (res.status === 401) exitCode = EXIT.LOGIN_REQUIRED;
  if (res.status >= 500) exitCode = EXIT.ERROR;
  if (phase === "publish" && res.status === 422) exitCode = EXIT.PUBLISH_INVALID;
  const login = exitCode === EXIT.LOGIN_REQUIRED;
  let hint =
    login && res.status === 401
      ? "로그인이 만료되었거나 토큰이 폐기되었습니다. 브라우저 승인으로 다시 로그인하십시오."
      : e.hint ?? defaults.hint;
  /** @type {Record<string, unknown> | undefined} */
  let extra;
  if (e.code === "secret_detected") {
    // 허브가 이미 같은 안내를 넣었으면 다시 붙이지 않는다.
    hint = withSecretGuidance(hint, hub);
    extra = { agent_instructions: SECRET_AGENT_INSTRUCTIONS };
  }
  return new CliError(e.code, e.message, {
    hint,
    nextStep: login ? loginNextStep(ctx, hub) : defaults.nextStep,
    nextStepTemplate: login ? undefined : defaults.nextStepTemplate,
    exitCode,
    extra,
  });
}

const SITE_FORBIDDEN_CODES = new Set(["site_forbidden", "not_owner", "site_not_owned"]);

/**
 * 요청한 사이트가 이 계정에 없다는 응답인가(없는 사이트·다른 사람의 사이트).
 * JSON 오류가 아닌 404(예: 허브에 API가 없음)는 사이트 문제로 보지 않는다.
 * @param {HubResponse} res
 */
export function isSiteNotFound(res) {
  const e = normalizeApiError(res.status, res.data);
  if (e.code === "site_not_found" || SITE_FORBIDDEN_CODES.has(e.code)) return true;
  const jsonError = isRecord(res.data) && isRecord(res.data.error);
  return res.status === 404 && jsonError && e.code === "not_found";
}

/** @param {HubResponse} res */
function badResponse(res) {
  return new CliError("bad_response", `허브 응답 형식이 예상과 다릅니다(상태 코드 ${res.status}).`, {
    hint: "허브 버전이 CLI와 맞는지 확인하십시오.",
    exitCode: EXIT.ERROR,
  });
}

/* ---------- 계정 ---------- */

/**
 * @param {Ctx} ctx
 * @param {{ hub: string, token: string }} session
 * @returns {Promise<{ name: string | null, role: string, schoolLevel: string | null }>}
 */
export async function whoami(ctx, session) {
  const res = await hubRequest(session.hub, "GET", "/api/cli/whoami", { token: session.token });
  if (!res.ok) throw apiFailure(ctx, session.hub, res, "login");
  if (!isRecord(res.data)) throw badResponse(res);
  const d = res.data;
  return {
    name: typeof d.name === "string" ? d.name : null,
    role: typeof d.role === "string" ? d.role : "teacher",
    schoolLevel: typeof d.schoolLevel === "string" ? d.schoolLevel : null,
  };
}

/* ---------- CLI 새 빌드 확인 ---------- */

/**
 * 허브가 내놓은 최신 CLI(/dandi-latest.json). 받지 못하면 null.
 * @param {string} hub
 * @returns {Promise<{ version: string, tag: string, tarball: string } | null>}
 */
export async function fetchLatestInfo(hub) {
  try {
    const res = await fetch(`${hub}/dandi-latest.json`, {
      headers: { Accept: "application/json", "User-Agent": `${CLI_NAME}/${CLI_TAG}` },
      redirect: "manual",
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    return parseLatestInfo(JSON.parse(await res.text()));
  } catch {
    return null;
  }
}

/**
 * 실행 중인 CLI가 허브의 최신 CLI와 다르면 새 실행 접두어를 알려 준다(npx는 같은 주소면 예전 설치를 계속 쓴다).
 * DANDI_NPX로 접두어를 직접 정했으면 확인하지 않는다.
 * @param {Ctx} ctx
 * @param {string} hub
 * @returns {Promise<{ current: string, latest: string, prefix: string, message: string } | null>}
 */
export async function cliUpdateNotice(ctx, hub) {
  if (ctx.env.DANDI_NPX?.trim()) return null;
  const latest = await fetchLatestInfo(hub);
  if (!latest || latest.tag === CLI_TAG) return null;
  const prefix = npxPrefix(hub, ctx.env, latest.tarball);
  return {
    current: CLI_TAG,
    latest: latest.tag,
    prefix,
    message: `지금 실행한 CLI(${CLI_TAG})는 허브의 최신 CLI(${latest.tag})와 다릅니다. 앞으로는 이 접두어로 실행하십시오: ${prefix}`,
  };
}

export const CLI_UPDATE_INSTRUCTIONS =
  "The hub offers a different (newer) CLI build. From now on run every Dandi command with cli_update.prefix instead of the npx prefix you used, including next_step commands.";

/* ---------- 브라우저 승인 로그인 (device code) ---------- */

/**
 * @typedef {{ hub: string, device_code: string, user_code: string, verification_uri: string, verification_uri_complete: string, interval: number, expires_at: string }} Pending
 */

/**
 * 로그인을 시작하고 pending.json에 저장한다.
 * @param {Ctx} ctx
 * @param {string} hub
 * @returns {Promise<Pending & { expires_in: number }>}
 */
export async function deviceStart(ctx, hub) {
  const res = await hubRequest(hub, "POST", "/api/cli/device/start", {
    json: { client: ctx.client, hostname: os.hostname().slice(0, 128), os: `${os.platform()} ${os.release()}`.slice(0, 64) },
  });
  if (!res.ok) throw apiFailure(ctx, hub, res, "login", { nextStep: loginNextStep(ctx, hub) });
  const d = isRecord(res.data) ? res.data : {};
  const ok =
    typeof d.device_code === "string" &&
    typeof d.user_code === "string" &&
    typeof d.verification_uri === "string" &&
    typeof d.verification_uri_complete === "string" &&
    /^https?:\/\//.test(d.verification_uri_complete) &&
    typeof d.expires_in === "number";
  if (!ok) throw badResponse(res);
  const expiresIn = Math.max(1, Math.min(3600, Math.round(/** @type {number} */ (d.expires_in))));
  /** @type {Pending} */
  const pending = {
    hub,
    device_code: /** @type {string} */ (d.device_code),
    user_code: /** @type {string} */ (d.user_code),
    verification_uri: /** @type {string} */ (d.verification_uri),
    verification_uri_complete: /** @type {string} */ (d.verification_uri_complete),
    interval: clampInterval(d.interval),
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
  await savePending(ctx, { ...pending, client: ctx.client, created_at: new Date().toISOString() });
  return { ...pending, expires_in: expiresIn };
}

/**
 * token 엔드포인트를 한 번 부른다.
 * @param {Ctx} ctx
 * @param {Pending} pending
 * @returns {Promise<{ status: "approved", token: string, user: Record<string, unknown> } | { status: "pending" | "slow_down" | "denied" | "expired" }>}
 */
export async function devicePollOnce(ctx, pending) {
  const res = await hubRequest(pending.hub, "POST", "/api/cli/device/token", {
    json: { device_code: pending.device_code },
  });
  if (res.ok) {
    const d = isRecord(res.data) ? res.data : {};
    if (typeof d.token !== "string" || !d.token.startsWith("dd_cli_")) throw badResponse(res);
    return { status: "approved", token: d.token, user: isRecord(d.user) ? d.user : {} };
  }
  const e = normalizeApiError(res.status, res.data);
  if (res.status === 400 || res.status === 401) {
    if (e.code === "authorization_pending") return { status: "pending" };
    if (e.code === "slow_down") return { status: "slow_down" };
    if (e.code === "access_denied") return { status: "denied" };
    if (e.code === "expired_token" || e.code === "invalid_grant") return { status: "expired" };
  }
  throw apiFailure(ctx, pending.hub, res, "login", { nextStep: loginNextStep(ctx, pending.hub) });
}

/**
 * 승인을 기다린다. 승인되면 설정을 저장하고 pending.json을 지운다.
 * 설정을 저장하지 못하면 pending.json을 남기고 분명한 오류를 낸다(허브는 이미 토큰을 발급했다).
 * @param {Ctx} ctx
 * @param {Pending} pending
 * @param {{ timeoutMs: number, onWait?: () => void }} options
 * @returns {Promise<{ status: "logged_in", hub: string, user: { name: string | null, role: string, schoolLevel: string | null } } | { status: "pending" | "denied" | "expired" }>}
 */
export async function waitForApproval(ctx, pending, options) {
  const deadline = Math.min(Date.now() + options.timeoutMs, Date.parse(pending.expires_at) + 5_000);
  let intervalMs = clampInterval(pending.interval) * 1000;
  for (;;) {
    const r = await devicePollOnce(ctx, pending);
    if (r.status === "approved") {
      const user = {
        name: typeof r.user.name === "string" ? r.user.name : null,
        role: typeof r.user.role === "string" ? r.user.role : "teacher",
        schoolLevel: typeof r.user.schoolLevel === "string" ? r.user.schoolLevel : null,
      };
      try {
        await saveConfig(ctx, { hub: pending.hub, token: r.token, user });
      } catch (err) {
        const reason = err instanceof CliError ? err.hint ?? err.message : errText(err);
        throw new CliError("config_save_failed", "승인은 되었지만 이 컴퓨터에 로그인 정보를 저장하지 못했습니다.", {
          hint: `${reason} 허브의 ${pending.hub}/studio/cli(로그인된 기기)에서 방금 로그인한 기기를 폐기한 뒤 로그인을 다시 하십시오.`,
          exitCode: EXIT.ERROR,
          nextStep: null,
          extra: {
            agent_instructions:
              "Login was approved but the token could not be saved on this computer (the file may be locked by antivirus software). Tell the teacher, ask them to revoke the newest device in the hub's logged-in devices page, and start the login again only after they agree.",
          },
        });
      }
      await deletePending(ctx);
      return { status: "logged_in", hub: pending.hub, user };
    }
    if (r.status === "denied" || r.status === "expired") {
      await deletePending(ctx);
      return { status: r.status };
    }
    if (r.status === "slow_down") intervalMs += 5_000;
    if (Date.now() + intervalMs > deadline) return { status: "pending" };
    options.onWait?.();
    await sleep(intervalMs);
  }
}

/** @param {Pending} pending */
export function remainingSeconds(pending) {
  return Math.max(0, Math.round((Date.parse(pending.expires_at) - Date.now()) / 1000));
}

/* ---------- dandi.json ---------- */

/**
 * @param {string} dir
 * @returns {Promise<{ file: string, exists: boolean, manifest: Record<string, unknown> | null }>}
 */
export async function readManifest(dir) {
  const file = path.join(dir, MANIFEST_FILE);
  const { exists, value, encodingProblem } = await readJsonFile(file);
  if (!exists) return { file, exists: false, manifest: null };
  if (encodingProblem) throw manifestEncodingError(file, encodingProblem);
  if (!isRecord(value)) {
    throw new CliError("manifest_parse_error", `${MANIFEST_FILE}의 JSON 형식이 올바르지 않습니다: ${file}`, {
      hint: `쉼표·따옴표·중괄호를 확인해 고치십시오. siteId 같은 기록이 사라지므로 파일을 지우지 마십시오. ${POWERSHELL_UTF8_HINT}.`,
      nextStep: null,
      extra: {
        agent_instructions:
          "dandi.json is not valid JSON. Fix the syntax in place (commas, quotes, braces) and keep every existing value, especially siteId, lastDeployId and projectId. Never delete the file or run init to replace it. Then run the same command again.",
      },
    });
  }
  return { file, exists: true, manifest: value };
}

/**
 * dandi.json 인코딩 문제(종료 코드 2). 파일을 지우라고 하지 않는다(siteId가 들어 있다).
 * @param {string} file
 * @param {"invalid_utf8" | "replacement_char"} problem
 */
function manifestEncodingError(file, problem) {
  const message =
    problem === "invalid_utf8"
      ? `${MANIFEST_FILE}이 UTF-8이 아닌 인코딩(ANSI·CP949 등)으로 저장되어 한글을 읽을 수 없습니다: ${file}`
      : `${MANIFEST_FILE}에 깨진 글자(${REPLACEMENT_CHAR})가 있습니다: ${file}`;
  return new CliError("manifest_encoding", message, {
    hint: `${POWERSHELL_UTF8_HINT}. 파일을 지우지 마십시오(siteId 같은 기록이 사라집니다). 깨진 제목·설명·셀프점검 답은 교사가 답한 원래 문장으로 다시 적으십시오.`,
    nextStep: null,
    exitCode: EXIT.USAGE,
    extra: {
      agent_instructions:
        "dandi.json is not valid UTF-8 (or contains U+FFFD replacement characters), so its Korean text is garbled. Rewrite the file as UTF-8 (PowerShell: Set-Content -Encoding UTF8, or [IO.File]::WriteAllText with the full path) using the teacher's original answers, and keep siteId, lastDeployId and projectId as they are. Never delete the file. If you do not know the original answers, ASK the teacher again. Then run the same command again.",
    },
  });
}

/**
 * dandi.json의 일부 칸만 바꿔 저장한다(다른 칸과 순서는 그대로).
 * @param {string} file
 * @param {Record<string, unknown>} base 없으면 새로 만들 내용
 * @param {Record<string, unknown>} patch
 */
export async function writeManifestPatch(file, base, patch) {
  const current = await readJsonFile(file);
  const manifest = isRecord(current.value) ? current.value : { ...base };
  Object.assign(manifest, patch);
  await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/* ---------- 폴더 읽기 ---------- */

/**
 * 폴더의 파일 목록(상대 경로는 슬래시 구분). 제외 규칙(isExcludedPath)에 걸리는 폴더는 들어가지 않고,
 * 심볼릭 링크는 따라가지 않는다(폴더 밖 파일이 올라가지 않게).
 * @param {string} root
 * @param {{ maxFiles?: number }} [options]
 * @returns {Promise<{ files: { path: string, abs: string, size: number }[], excluded: string[], symlinks: string[] }>}
 */
export async function walkFolder(root, options = {}) {
  const maxFiles = options.maxFiles ?? SITE_LIMITS.fileCount * 5;
  /** @type {{ path: string, abs: string, size: number }[]} */
  const files = [];
  /** @type {string[]} */
  const excluded = [];
  /** @type {string[]} */
  const symlinks = [];
  /** @param {string} dir @param {string} rel @param {number} depth */
  async function visit(dir, rel, depth) {
    if (depth > 32 || files.length > maxFiles) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (isExcludedPath(relPath)) {
        excluded.push(entry.isDirectory() ? `${relPath}/` : relPath);
        continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(relPath);
        continue;
      }
      if (entry.isDirectory()) await visit(abs, relPath, depth + 1);
      else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        files.push({ path: relPath, abs, size: stat.size });
      }
    }
  }
  await visit(root, "", 0);
  return { files, excluded, symlinks };
}

/** @param {string} p */
async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} p */
async function isFile(p) {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * 작은 텍스트 파일을 읽는다(없거나 크면 null).
 * @param {string} p
 * @param {number} [max]
 */
async function readSmallText(p, max = 2 * 1024 * 1024) {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile() || stat.size > max) return null;
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * 폴더의 index.html <title>. 없으면 null.
 * @param {string} folder
 */
export async function htmlTitleOf(folder) {
  const html = await readSmallText(path.join(folder, "index.html"));
  return html === null ? null : titleFromHtml(html);
}

/** @param {string} a @param {string} b */
export function samePath(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * @typedef {{ prefix: string, hub: string, retry: string | null }} Guide
 * 오류 안내에 쓰는 정보. retry는 그대로 다시 실행할 명령(적을 수 없으면 null → next_step_template).
 */

/**
 * @param {Guide | string} g
 * @returns {Guide}
 */
function toGuide(g) {
  return typeof g === "string" ? { prefix: g, hub: DEFAULT_HUB, retry: null } : g;
}

/**
 * 다시 실행할 명령 옵션. 명령을 적을 수 없으면 next_step 대신 틀(next_step_template)을 준다.
 * @param {Guide} guide
 */
function retryOptions(guide) {
  return guide.retry
    ? { nextStep: guide.retry }
    : { nextStep: /** @type {null} */ (null), nextStepTemplate: nextStep(guide.prefix, 'deploy "<폴더>" --json') };
}

/**
 * 올릴 폴더를 정한다. folder를 주면 그 폴더(맨 위에 index.html이 없으면 그 안의 dist·build·out),
 * 없으면 base 폴더에서 outputDir → dist → build → out → base 순으로 index.html이 있는 첫 곳.
 * 찾지 못하면 사용법 오류(종료 코드 2). 폴더를 모르므로 next_step 대신 next_step_template을 준다.
 * @param {string} base 기준 폴더(프로젝트 폴더)
 * @param {string | undefined} folder 사용자가 적은 폴더
 * @param {string | undefined} outputDir dandi.json의 outputDir(base 기준)
 * @param {string} prefix 안내 명령 접두어
 */
export async function resolveSiteFolder(base, folder, outputDir, prefix) {
  const template = nextStep(prefix, 'deploy "<폴더>" --json');
  const start = folder ? path.resolve(base, folder) : base;
  if (!(await isDir(start))) {
    throw new CliError("folder_not_found", `폴더를 찾을 수 없습니다: ${start}`, {
      hint: "index.html이 있는 사이트 폴더 경로를 적으십시오. Windows에서는 C:/Users/... 형식의 경로를 쓰십시오.",
      nextStep: null,
      nextStepTemplate: template,
      exitCode: EXIT.USAGE,
    });
  }
  const candidates = folder ? siteFolderCandidates(undefined).filter((c) => c !== ".") : siteFolderCandidates(outputDir);
  const checked = folder ? [start, ...candidates.map((c) => path.resolve(start, c))] : candidates.map((c) => path.resolve(start, c));
  for (const dir of checked) {
    if (await isFile(path.join(dir, "index.html"))) return dir;
  }
  const shown = checked.map((d) => {
    const rel = path.relative(base, d);
    return rel ? rel.split(path.sep).join("/") : "현재 폴더";
  });
  throw new CliError("missing_index", "올릴 폴더를 찾지 못했습니다. 맨 위에 index.html이 있는 폴더가 필요합니다.", {
    hint: `찾아본 곳: ${shown.join(", ")}. 빌드가 필요하면 먼저 빌드하고, index.html이 있는 결과 폴더를 적으십시오.`,
    nextStep: null,
    nextStepTemplate: template,
    exitCode: EXIT.USAGE,
  });
}

/**
 * @typedef {{ path: string, kind: string, message: string }} DeployNote
 * deploy 결과의 참고 사항(notes). 개인정보·건너뛴 파일 경고(warnings)와 따로 둔다.
 */

/**
 * 빌드하지 않은 소스 폴더를 올리려는지 확인한다. 맨 위에 package.json이 없는 평범한 정적 폴더는 거부하지 않는다.
 * package.json이 있을 때 거부(source_folder, 20)하는 경우:
 * - index.html이 실제로 불러오는 모듈이 .jsx/.ts/.tsx/.vue/.svelte이거나 루트 절대 경로 /src/의 모듈이다(빌드 전 Vite 등).
 * - 안에 빌드 결과(dist·build·out/index.html)가 따로 있다(그쪽을 올려야 한다).
 * - build 스크립트나 빌드 도구(vite·react-scripts·next·parcel·webpack 등) 의존성이 있는데 빌드 결과가 없다.
 * allowSource(--allow-source)면 거부하지 않고 notes에 남긴다.
 * @param {string} folder
 * @param {Guide} guide
 * @param {string} cwd 안내 명령의 폴더 표기 기준
 * @param {{ via?: "cli" | "mcp", allowSource?: boolean }} [options]
 * @returns {Promise<{ sourceRoot: boolean, notes: DeployNote[] }>}
 */
export async function checkSourceFolder(folder, guide, cwd, options = {}) {
  const via = options.via ?? "cli";
  const html = (await readSmallText(path.join(folder, "index.html"))) ?? "";
  const ref = sourceModuleReference(html);
  const pkgText = await readSmallText(path.join(folder, "package.json"), 1024 * 1024);
  /** @type {DeployNote[]} */
  const notes = [];
  if (pkgText === null) {
    if (ref) {
      notes.push({
        path: "index.html",
        kind: "source_module",
        message: `index.html이 빌드 전 소스(${ref})를 불러옵니다. 미리보기가 빈 화면이면 빌드한 결과 폴더(dist 등)를 올리십시오.`,
      });
    }
    return { sourceRoot: false, notes };
  }
  /** @type {{ buildScript: boolean, tools: string[] }} */
  let signals = { buildScript: false, tools: [] };
  try {
    signals = packageBuildSignals(JSON.parse(pkgText.replace(/^﻿/, "")));
  } catch {
    // package.json을 읽지 못하면 빌드 여부를 모르는 것으로 본다.
  }
  /** @type {string | null} */
  let built = null;
  for (const d of BUILD_DIRS) {
    const dir = path.join(folder, d);
    if (await isFile(path.join(dir, "index.html"))) {
      built = dir;
      break;
    }
  }
  const needsBuild = signals.buildScript || signals.tools.length > 0;
  if (!ref && !built && !needsBuild) return { sourceRoot: true, notes };
  if (options.allowSource) {
    notes.push({
      path: ref ? "index.html" : "package.json",
      kind: "source_allowed",
      message: "빌드 전 소스 폴더로 보이지만 요청대로 그대로 올렸습니다. 미리보기가 빈 화면이면 먼저 빌드한 뒤 결과 폴더(dist 등)를 올리십시오.",
    });
    return { sourceRoot: true, notes };
  }

  const builtShown = built ? displayPath(built, cwd) : null;
  const next = via === "cli" && builtShown ? commandWithFolder(guide.prefix, "deploy", builtShown, "--json") : null;
  const why = [signals.buildScript ? "build 스크립트" : "", ...signals.tools.map((t) => `${t} 의존성`)].filter(Boolean).join(", ");
  const message = ref
    ? `index.html이 빌드하지 않은 소스 파일(${ref})을 불러옵니다. 이 폴더를 그대로 올리면 빈 화면이 됩니다.`
    : builtShown
      ? `빌드 전 소스 폴더입니다(package.json이 있고 빌드 결과 ${builtShown}가 따로 있습니다).`
      : `빌드가 필요한 프로젝트인데 빌드 결과(dist·build·out)가 없습니다(package.json: ${why}). 이 폴더를 그대로 올리면 빈 화면이 됩니다.`;
  const allowHow = via === "mcp" ? "allowSource: true" : "--allow-source";
  const hint = builtShown
    ? `빌드 결과 폴더(${builtShown})를 올리십시오. 소스를 고친 뒤라면 먼저 빌드(예: npm run build)하십시오. package.json·vite.config 같은 소스 파일은 공개하지 마십시오. 빌드 없이 이 폴더를 그대로 올려야 하는 것이 확실하면 ${allowHow}을 붙이십시오.`
    : `먼저 빌드(예: npm run build)한 뒤 index.html이 있는 결과 폴더(dist 등)를 올리십시오. 빌드 없이 이 폴더를 그대로 올려야 하는 것이 확실하면 ${allowHow}을 붙이십시오.`;
  /** @type {string} */
  let instructions;
  if (via === "mcp") {
    instructions = built
      ? `This is a source folder. Rebuild if the source changed (e.g. npm run build), then call dandi_deploy_folder with path set to build_folder (${built}).`
      : "This is an unbuilt source folder. Build the project first (e.g. npm run build), then call dandi_deploy_folder with the path of the build output folder (e.g. dist) that has index.html at its root. Pass allowSource: true only if the teacher confirms this folder must be uploaded as is.";
  } else {
    instructions = built
      ? `This is a source folder. Rebuild if the source changed (e.g. npm run build), then deploy the build output folder with ${next ? "next_step" : "next_step_template (use build_folder as the folder)"}.`
      : "This is an unbuilt source folder. Build the project first (e.g. npm run build), then deploy the build output folder (e.g. dist) that has index.html at its root, using next_step_template. Use --allow-source only if the teacher confirms this folder must be uploaded as is.";
  }
  throw new CliError("source_folder", message, {
    hint,
    nextStep: next,
    nextStepTemplate: next || via === "mcp" ? undefined : nextStep(guide.prefix, 'deploy "<폴더>" --json'),
    exitCode: EXIT.UPLOAD_REJECTED,
    extra: { ...(built ? { build_folder: built } : {}), agent_instructions: instructions },
  });
}

/**
 * @typedef {{ path: string, bytes: Uint8Array }} FileBytes
 */

/**
 * 올릴 파일을 검사한다: 허용 확장자(나머지는 건너뜀), 한도, 비밀값. 문제가 있으면 CliError(업로드 거부, 20).
 * @param {FileBytes[]} files
 * @param {Guide | string} guideIn
 * @param {{ skipDisallowed?: boolean }} [options]
 */
export function checkSiteFiles(files, guideIn, options = {}) {
  const guide = toGuide(guideIn);
  const retry = retryOptions(guide);
  const bad = files.map((f) => ({ path: f.path, problem: sitePathProblem(f.path) })).filter((x) => x.problem);
  if (bad.length) {
    throw new CliError("invalid_path", "올릴 수 없는 파일 경로가 있습니다.", {
      hint: bad.slice(0, 5).map((b) => `${b.path}: ${b.problem}`).join("; "),
      ...retry,
      exitCode: EXIT.UPLOAD_REJECTED,
    });
  }
  const { keep, skipped } = splitAllowedFiles(files);
  if (skipped.length && !options.skipDisallowed) {
    throw new CliError("disallowed_extension", "허용되지 않는 확장자의 파일이 있습니다.", {
      hint: `${skipped.slice(0, 10).map((s) => `${s.path}(${s.reason})`).join(", ")}. 문서 파일은 허브 자료실(${guide.hub}/files)에 올리거나 PDF로 바꾸십시오.`,
      ...retry,
      exitCode: EXIT.UPLOAD_REJECTED,
    });
  }
  const problems = siteLimitProblems(keep.map((f) => ({ path: f.path, size: f.bytes.byteLength })));
  if (problems.length) {
    throw new CliError("bundle_rejected", problems[0], {
      hint: problems.slice(1).join(" ") || "한도: 합계 20MB, 파일 1,000개, 파일당 5MB, 맨 위에 index.html",
      ...retry,
      exitCode: EXIT.UPLOAD_REJECTED,
    });
  }
  const secrets = scanSecrets(keep);
  if (secrets.length) {
    throw new CliError("secret_detected", "비밀값(토큰·API 키)으로 보이는 내용이 있어 올리지 않았습니다.", {
      hint: `${secrets.map((s) => `${s.path}(${s.kind})`).join(", ")}. ${secretGuidance(guide.hub)}`,
      ...retry,
      exitCode: EXIT.UPLOAD_REJECTED,
      extra: { agent_instructions: SECRET_AGENT_INSTRUCTIONS },
    });
  }
  return { keep, skipped };
}

/**
 * 폴더의 파일을 읽어 검사한다. 맨 위에 package.json이 있는 폴더(소스 폴더)이면
 * package.json·vite.config.* 같은 빌드 설정 파일은 올리지 않고 withheld로 알려 준다.
 * @param {string} folder
 * @param {Guide | string} guideIn
 */
export async function collectSiteFolder(folder, guideIn) {
  const guide = toGuide(guideIn);
  const walked = await walkFolder(folder);
  if (walked.files.length > SITE_LIMITS.fileCount * 5) {
    throw new CliError("bundle_rejected", `파일이 너무 많습니다(${SITE_LIMITS.fileCount}개 이하).`, {
      hint: "빌드 결과 폴더(dist 등)만 올리십시오.",
      ...retryOptions(guide),
      exitCode: EXIT.UPLOAD_REJECTED,
    });
  }
  const sourceRoot = walked.files.some((f) => f.path === "package.json");
  /** @type {string[]} */
  const withheld = [];
  const candidates = walked.files.filter((f) => {
    if (sourceRoot && isBuildConfigFile(f.path)) {
      withheld.push(f.path);
      return false;
    }
    return true;
  });
  // 허용 확장자만 읽는다(건너뛸 큰 파일을 메모리에 올리지 않게).
  const { keep: toRead, skipped } = splitAllowedFiles(candidates);
  const tooBig = toRead.find((f) => f.size > SITE_LIMITS.fileBytes);
  const total = toRead.reduce((s, f) => s + f.size, 0);
  if (tooBig || total > SITE_LIMITS.totalBytes) {
    const problems = siteLimitProblems(toRead);
    throw new CliError("bundle_rejected", problems.find((p) => !p.includes("index.html")) ?? problems[0], {
      hint: "한도: 합계 20MB, 파일 1,000개, 파일당 5MB. 큰 동영상·이미지는 줄이거나 외부 주소로 바꾸십시오.",
      ...retryOptions(guide),
      exitCode: EXIT.UPLOAD_REJECTED,
    });
  }
  /** @type {FileBytes[]} */
  const files = [];
  // 허브는 경로를 NFC로 저장한다(macOS는 한글 파일 이름을 NFD로 줄 수 있다).
  for (const f of toRead) files.push({ path: f.path.normalize("NFC"), bytes: new Uint8Array(await fs.readFile(f.abs)) });
  const checked = checkSiteFiles(files, guide, { skipDisallowed: true });
  // 참고 사항(notes): 개인정보 경고(warnings)와 섞지 않는다.
  /** @type {DeployNote[]} */
  const notes = withheld.map((p) => ({
    path: p,
    kind: "source_file",
    message: "빌드 설정 파일이라 공개하지 않았습니다. 이 폴더가 빌드 전 소스라면 빌드 결과 폴더(dist 등)를 올리십시오.",
  }));
  return {
    files: checked.keep,
    skipped: [...skipped, ...walked.symlinks.map((p) => ({ path: p, reason: "심볼릭 링크" }))],
    withheld,
    notes,
    excluded: walked.excluded,
  };
}

/**
 * MCP dandi_deploy_files 입력을 파일로 바꾼다.
 * @param {unknown} input
 * @param {Guide | string} guideIn
 * @returns {FileBytes[]}
 */
export function decodeInlineFiles(input, guideIn) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new CliError("invalid_argument", "files는 { path, content, encoding } 객체 배열이어야 합니다.", { exitCode: EXIT.USAGE });
  }
  if (input.length > SITE_LIMITS.fileCount) {
    throw new CliError("bundle_rejected", `파일은 ${SITE_LIMITS.fileCount}개 이하여야 합니다.`, { exitCode: EXIT.UPLOAD_REJECTED });
  }
  // 길이를 먼저 확인한다(base64는 원본보다 약 4/3 길다).
  const rawLength = input.reduce((s, f) => s + (isRecord(f) && typeof f.content === "string" ? f.content.length : 0), 0);
  if (rawLength > Math.ceil((DEPLOY_FILES_MAX_BYTES * 4) / 3) + 1024) {
    throw new CliError("bundle_rejected", `파일 합계는 ${formatBytes(DEPLOY_FILES_MAX_BYTES)} 이하여야 합니다.`, {
      hint: "더 큰 사이트는 dandi_deploy_folder(로컬 폴더)나 CLI deploy를 쓰십시오.",
      exitCode: EXIT.UPLOAD_REJECTED,
    });
  }
  /** @type {FileBytes[]} */
  const files = [];
  const seen = new Set();
  for (const f of input) {
    if (!isRecord(f) || typeof f.path !== "string" || typeof f.content !== "string") {
      throw new CliError("invalid_argument", "각 파일은 문자열 path와 content가 있어야 합니다.", { exitCode: EXIT.USAGE });
    }
    const encoding = f.encoding ?? "utf8";
    if (encoding !== "utf8" && encoding !== "base64") {
      throw new CliError("invalid_argument", `${f.path}: encoding은 "utf8" 또는 "base64"여야 합니다.`, { exitCode: EXIT.USAGE });
    }
    const p = f.path.replace(/^\.\//, "").normalize("NFC");
    if (seen.has(p)) throw new CliError("invalid_argument", `같은 경로가 두 번 있습니다: ${p}`, { exitCode: EXIT.USAGE });
    seen.add(p);
    const bytes = encoding === "base64" ? new Uint8Array(Buffer.from(f.content, "base64")) : new TextEncoder().encode(f.content);
    files.push({ path: p, bytes });
  }
  const total = files.reduce((s, f) => s + f.bytes.byteLength, 0);
  if (total > DEPLOY_FILES_MAX_BYTES) {
    throw new CliError("bundle_rejected", `파일 합계는 ${formatBytes(DEPLOY_FILES_MAX_BYTES)} 이하여야 합니다.`, {
      hint: "더 큰 사이트는 dandi_deploy_folder(로컬 폴더)나 CLI deploy를 쓰십시오.",
      exitCode: EXIT.UPLOAD_REJECTED,
    });
  }
  return checkSiteFiles(files, guideIn, { skipDisallowed: false }).keep;
}

/* ---------- 3단계 업로드 (계약 2-3) ---------- */

/**
 * @typedef {{ siteId: string, deployId: string, slug: string, projectId: string | null, previewUrl: string, status: string, warnings: { path: string, kind: string, message: string }[], uploaded: number, reused: number }} DeployResult
 */

/**
 * 1) 파일 목록 → 2) 없는 파일만 전송 → 3) 확정.
 * 1단계 응답을 받자마자 onCreated를 부른다(업로드가 뒤에서 실패해도 siteId를 기록해 같은 사이트로 다시 올리게).
 * @param {Ctx} ctx
 * @param {{ hub: string, token: string }} session
 * projectId(계약 F-31): 새 사이트를 만들 때의 프로젝트이거나, moveToProject와 함께 줄 때만 기존 사이트를 그 프로젝트로 옮긴다.
 * 기존 사이트에 moveToProject 없이 projectId를 보내지 않는다(허브에서 옮긴 프로젝트를 되돌리지 않게).
 * @param {FileBytes[]} files
 * @param {{ siteId?: string, slug?: string, title?: string, projectId?: string, moveToProject?: boolean }} target
 * @param {{ onProgress?: (done: number, total: number) => void, onCreated?: (created: { siteId: string, deployId: string, slug: string, projectId: string | null }) => Promise<void> | void, guide?: Guide }} [options]
 * @returns {Promise<DeployResult>}
 */
export async function uploadSite(ctx, session, files, target, options = {}) {
  const guide = options.guide ?? { prefix: prefixFor(ctx, session.hub), hub: session.hub, retry: null };
  const retry = retryOptions(guide);
  const manifest = buildFileManifest(files);
  const sendProject = Boolean(target.projectId) && (!target.siteId || target.moveToProject === true);
  const created = await hubRequest(session.hub, "POST", "/api/sites/deploys", {
    token: session.token,
    json: {
      ...(target.siteId ? { siteId: target.siteId } : {}),
      ...(target.slug ? { slug: target.slug } : {}),
      ...(target.title ? { title: target.title } : {}),
      ...(sendProject ? { projectId: target.projectId } : {}),
      ...(sendProject && target.siteId ? { moveToProject: true } : {}),
      files: manifest,
    },
  });
  if (!created.ok) {
    if (target.siteId && isSiteNotFound(created)) {
      throw new CliError("site_not_found", `사이트(${target.siteId})를 지금 로그인한 계정에서 찾을 수 없습니다.`, {
        hint: "다른 계정으로 로그인했거나 사이트가 지워졌을 수 있습니다.",
        nextStep: null,
        exitCode: EXIT.UPLOAD_REJECTED,
        extra: { siteId: target.siteId },
      });
    }
    throw apiFailure(ctx, session.hub, created, "deploy", retry);
  }
  const d = isRecord(created.data) ? created.data : {};
  if (typeof d.deployId !== "string" || typeof d.siteId !== "string" || !Array.isArray(d.upload)) throw badResponse(created);
  const deployId = d.deployId;
  const createdProjectId = typeof d.projectId === "string" && d.projectId ? d.projectId : null;
  await options.onCreated?.({ siteId: d.siteId, deployId, slug: typeof d.slug === "string" ? d.slug : "", projectId: createdProjectId });
  const byPath = new Map(files.map((f) => [f.path.normalize("NFC"), f]));
  const toUpload = d.upload.filter((p) => typeof p === "string" && byPath.has(p.normalize("NFC")));
  const unknown = d.upload.filter((p) => !toUpload.includes(p));
  if (unknown.length) {
    throw new CliError("bad_response", "허브가 보낸 파일 목록에 없는 파일을 요청했습니다.", {
      hint: `경로: ${unknown.slice(0, 5).map(String).join(", ")}. CLI와 허브 버전을 확인하십시오.`,
      exitCode: EXIT.ERROR,
    });
  }

  let done = 0;
  const queue = [...toUpload];
  const worker = async () => {
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
      const file = /** @type {FileBytes} */ (byPath.get(p.normalize("NFC")));
      const res = await hubRequest(
        session.hub,
        "PUT",
        `/api/sites/deploys/${encodeURIComponent(deployId)}/files?path=${encodeURIComponent(p)}`,
        { token: session.token, body: file.bytes, timeoutMs: 120_000 },
      );
      if (!res.ok) throw apiFailure(ctx, session.hub, res, "deploy", retry);
      done++;
      options.onProgress?.(done, toUpload.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, toUpload.length) }, worker));

  const fin = await hubRequest(session.hub, "POST", `/api/sites/deploys/${encodeURIComponent(deployId)}/finalize`, {
    token: session.token,
    json: {},
    timeoutMs: 120_000,
  });
  if (!fin.ok) throw apiFailure(ctx, session.hub, fin, "deploy", retry);
  const f = isRecord(fin.data) ? fin.data : {};
  if (typeof f.previewUrl !== "string") throw badResponse(fin);
  const warnings = Array.isArray(f.warnings)
    ? f.warnings.filter(isRecord).map((w) => ({
        path: String(w.path ?? ""),
        kind: String(w.kind ?? ""),
        message: String(w.message ?? ""),
      }))
    : [];
  return {
    siteId: typeof f.siteId === "string" ? f.siteId : d.siteId,
    deployId: typeof f.deployId === "string" ? f.deployId : deployId,
    slug: typeof f.slug === "string" ? f.slug : typeof d.slug === "string" ? d.slug : "",
    projectId: typeof f.projectId === "string" && f.projectId ? f.projectId : createdProjectId,
    previewUrl: f.previewUrl,
    status: typeof f.status === "string" ? f.status : "preview",
    warnings,
    uploaded: toUpload.length,
    reused: files.length - toUpload.length,
  };
}

/**
 * 폴더 인자를 주었을 때 쓸 dandi.json 위치. 폴더 안, 없으면 바로 위 폴더(프로젝트 폴더의 dist 등).
 * 위 폴더의 dandi.json이 다른 폴더를 올리던 것(outputDir이 다름)이면 쓰지 않는다
 * (홈 폴더 같은 곳의 dandi.json이 엉뚱한 사이트를 덮어쓰지 않게).
 * 위 폴더의 dandi.json에 siteId는 있고 outputDir이 비어 있으면(예전 CLI가 현재 폴더에 남긴 파일):
 * - 그 폴더가 adoptFrom(현재 폴더·--dir) 가운데 하나면 이어서 쓴다(deploy가 outputDir을 기록한다).
 * - explicitSite(--site·--new-site)면 쓰지 않는다(새 dandi.json).
 * - 그 밖에는 조용히 새 사이트를 만들지 않고 manifest_in_parent(종료 코드 2)로 멈춰 교사에게 묻게 한다.
 * @param {string} folder 올릴 폴더(절대 경로)
 * @param {{ adoptFrom?: string[], explicitSite?: boolean }} [options]
 * @returns {Promise<string | null>}
 */
export async function findManifestDir(folder, options = {}) {
  if (await isFile(path.join(folder, MANIFEST_FILE))) return folder;
  const parent = path.dirname(folder);
  if (samePath(parent, folder)) return null;
  /** @type {Awaited<ReturnType<typeof readManifest>> | null} */
  let read = null;
  try {
    read = await readManifest(parent);
  } catch (err) {
    // 글자가 깨진 dandi.json은 조용히 건너뛰지 않는다(건너뛰면 새 사이트가 생긴다).
    if (err instanceof CliError && err.code === "manifest_encoding") throw err;
    read = null;
  }
  const manifest = read?.manifest ?? null;
  if (!read || !manifest) return null;
  const outputDir = manifestString(manifest, "outputDir");
  if (outputDir) return samePath(path.resolve(parent, outputDir), folder) ? parent : null;
  const siteId = manifestString(manifest, "siteId");
  if (BUILD_DIRS.includes(path.basename(folder).toLowerCase()) || !siteId) return parent;
  if ((options.adoptFrom ?? []).some((d) => samePath(d, parent))) return parent;
  if (options.explicitSite) return null;
  throw new CliError(
    "manifest_in_parent",
    `위 폴더의 ${MANIFEST_FILE}(${read.file})에 사이트 ${siteId}가 기록되어 있지만, 이 폴더(${path.basename(folder)})를 올리던 것인지 알 수 없습니다.`,
    {
      hint: `예전 CLI가 실행한 폴더에 남긴 파일일 수 있습니다. 같은 사이트라면 그 폴더(${parent})에서 실행하거나 --dir로 그 폴더를 적고, 다른 사이트라면 --new-site를 붙여 새 사이트로 올리십시오.`,
      nextStep: null,
      exitCode: EXIT.USAGE,
      extra: { parent_manifest: read.file, parent_siteId: siteId, parent_title: manifestString(manifest, "title") ?? null },
    },
  );
}

/**
 * 로그인한 계정 이름(확인하지 못하면 null). site_not_found 안내에 넣는다.
 * @param {Ctx} ctx
 * @param {{ hub: string, token: string }} session
 */
async function accountName(ctx, session) {
  try {
    return (await whoami(ctx, session)).name;
  } catch {
    return null;
  }
}

/**
 * site_not_found 오류에 로그인한 계정·다음 행동을 붙인다. dandi.json은 비우지 않는다.
 * 교사가 계정을 확인하기 전에는 새 사이트를 만들지 않도록 next_step 대신 next_step_template(새 사이트 명령)만 준다.
 * @param {Ctx} ctx
 * @param {{ hub: string, token: string }} session
 * @param {CliError} err
 * @param {{ siteId: string, fromManifest: boolean, via: "cli" | "mcp", newSiteStep?: string | null, newSiteAction?: string }} info
 *   newSiteStep: CLI에서 새 사이트로 올리는 명령 / newSiteAction: MCP에서 새 사이트로 올리는 방법(영어 문장)
 */
export async function explainSiteNotFound(ctx, session, err, info) {
  const prefix = prefixFor(ctx, session.hub);
  const name = await accountName(ctx, session);
  const who = name ? `'${name}'` : "(이름을 확인하지 못함)";
  const relogin = nextStep(prefix, "login --force --json");
  const reloginHow = info.via === "cli" ? "login --force" : "dandi_login force: true";
  const newSiteHow = info.via === "cli" ? "--new-site를 붙이십시오" : "newSite: true로 다시 올리십시오";
  err.hint = info.fromManifest
    ? `${MANIFEST_FILE}의 siteId(${info.siteId})는 지금 로그인한 계정 ${who}의 사이트가 아닙니다. 다른 계정으로 로그인했거나 사이트가 지워졌을 수 있습니다. ${MANIFEST_FILE}은 바꾸지 않았습니다. 계정이 다르면 다시 로그인(${reloginHow})하고, 계정이 맞고 새 사이트로 올리려면 ${newSiteHow}(이전 siteId는 previousSiteId에 남습니다).`
    : `사이트(${info.siteId})가 지금 로그인한 계정 ${who}에 없습니다. 계정이 다르면 다시 로그인(${reloginHow})하고, 올바른 siteId를 적거나 새 사이트로 올리십시오.`;
  err.nextStep = null;
  err.nextStepTemplate = info.via === "cli" ? info.newSiteStep ?? nextStep(prefix, 'deploy "<폴더>" --new-site --json') : undefined;
  const ask = `ASK the teacher in Korean: "지금 Dandi에 ${name ? `'${name}'` : "이 계정"}으로 로그인되어 있습니다. 이 사이트를 올렸던 계정이 맞습니까?"`;
  const wrong =
    info.via === "cli"
      ? "If it is the wrong account, run relogin_step (a new browser login), let the teacher approve with the right account, then run the same command again."
      : "If it is the wrong account, call dandi_login with force: true (a new browser login), let the teacher approve with the right account, then call the same tool again.";
  const fresh =
    info.via === "cli"
      ? "Only if the teacher confirms the account is right and wants a new site, run next_step_template (it creates a new site and keeps the old id in previousSiteId)."
      : `Only if the teacher confirms the account is right and wants a new site, ${info.newSiteAction ?? "upload it again as a new site"}.`;
  err.extra = {
    ...(err.extra ?? {}),
    siteId: info.siteId,
    account: name,
    manifest_cleared: false,
    ...(info.via === "cli" ? { relogin_step: relogin } : {}),
    agent_instructions: `The site ${info.siteId} was not found in the logged-in account${name ? ` "${name}"` : ""}. Do not create a new site yet. ${ask} ${wrong} ${fresh}`,
  };
  return err;
}

/**
 * dandi.json이 없을 때 새로 만들 위치: 빌드 결과 폴더(dist·build·out)면 그 위(프로젝트 폴더), 아니면 그 폴더.
 * @param {string} folder
 */
export function newManifestDir(folder) {
  return BUILD_DIRS.includes(path.basename(folder).toLowerCase()) ? path.dirname(folder) : folder;
}

/**
 * @typedef {{ appId: string, appUrl: string, liveUrl: string | null, approvalStatus: string | null }} PublishedInfo
 */

/**
 * 이 사이트가 이미 허브에 등록(publish)되었는지 확인한다. 확인하지 못하면 null.
 * @param {Ctx} ctx
 * @param {{ hub: string, token: string }} session
 * @param {string} siteId
 * @returns {Promise<PublishedInfo | null>}
 */
export async function publishedInfo(ctx, session, siteId) {
  let sites;
  try {
    sites = await listMySites(ctx, session);
  } catch {
    return null;
  }
  const site = sites.find((s) => s.id === siteId);
  if (!site || typeof site.appId !== "string" || !site.appId) return null;
  return {
    appId: site.appId,
    appUrl: `${session.hub}/apps/${site.appId}`,
    liveUrl: typeof site.liveUrl === "string" ? site.liveUrl : null,
    approvalStatus: typeof site.approvalStatus === "string" ? site.approvalStatus : null,
  };
}

/**
 * 폴더를 올리고 dandi.json에 siteId·lastDeployId·outputDir·projectId를 기록한다.
 * - 폴더를 주지 않으면 projectDir의 dandi.json(outputDir)로 폴더를 정한다.
 * - 폴더를 주면 그 폴더(또는 바로 위)의 dandi.json을 쓰고, 없으면 새로 만든다(manifestMode "create").
 * - siteId는 1단계 응답을 받자마자 기록한다. dandi.json의 siteId가 이 계정에 없으면 dandi.json은 그대로 두고
 *   교사에게 계정을 확인하게 한다(site_not_found). --new-site면 이전 siteId를 previousSiteId에 남긴다.
 * - projectId: dandi.json의 값은 새 사이트를 만들 때만 보낸다. 이미 있는 사이트는 opts.projectId(--project)를 줄 때만 옮기고,
 *   허브가 알려 준 지금 프로젝트를 dandi.json에 기록한다.
 * @param {Ctx} ctx
 * @param {{ hub: string, token: string }} session
 * @param {{ folder?: string, projectDir: string, siteId?: string, newSite?: boolean, projectId?: string, slug?: string, title?: string, manifestMode: "create" | "update", manifestDir?: string, via?: "cli" | "mcp", allowSource?: boolean }} opts
 * @param {{ onProgress?: (done: number, total: number) => void, onInfo?: (text: string) => void }} [hooks]
 */
export async function deployFolder(ctx, session, opts, hooks = {}) {
  const via = opts.via ?? "cli";
  const prefix = prefixFor(ctx, session.hub);
  const projectDir = opts.projectDir;
  // 다시 실행할 명령에 적을 폴더(사용자가 적은 폴더 또는 --dir).
  const argAbs = opts.folder ? path.resolve(projectDir, opts.folder) : null;
  const dirAbs = !argAbs && !samePath(projectDir, ctx.cwd) ? projectDir : null;
  const retryFor = (/** @type {string} */ rest) => {
    if (argAbs) return commandWithFolder(prefix, "deploy", displayPath(argAbs, ctx.cwd), rest);
    if (dirAbs) {
      const dir = shellArg(displayPath(dirAbs, ctx.cwd));
      return dir ? nextStep(prefix, `deploy --dir ${dir} ${rest}`) : null;
    }
    return nextStep(prefix, `deploy ${rest}`);
  };
  /** @type {Guide} */
  const guide = { prefix, hub: session.hub, retry: retryFor("--json") };

  const explicitSite = Boolean(opts.siteId || opts.newSite);
  let folder;
  let manifestDir;
  /** @type {Awaited<ReturnType<typeof readManifest>>} */
  let read;
  if (!argAbs) {
    manifestDir = opts.manifestDir ?? projectDir;
    read = await readManifest(manifestDir);
    folder = await resolveSiteFolder(projectDir, undefined, manifestString(read.manifest, "outputDir"), prefix);
  } else {
    folder = await resolveSiteFolder(projectDir, opts.folder, undefined, prefix);
    try {
      manifestDir =
        opts.manifestDir ?? (await findManifestDir(folder, { adoptFrom: [projectDir, ctx.cwd], explicitSite })) ?? newManifestDir(folder);
    } catch (err) {
      if (err instanceof CliError && err.code === "manifest_in_parent") throw explainParentManifest(ctx, err, folder, prefix, via, retryFor);
      throw err;
    }
    read = await readManifest(manifestDir);
  }
  const { file: manifestFile, manifest } = read;
  const writable = Boolean(manifest) || opts.manifestMode === "create";

  const source = await checkSourceFolder(folder, guide, ctx.cwd, { via, allowSource: opts.allowSource === true });
  const collected = await collectSiteFolder(folder, guide);
  const total = collected.files.reduce((s, f) => s + f.bytes.byteLength, 0);
  hooks.onInfo?.(`올릴 폴더: ${folder} (파일 ${collected.files.length}개, ${formatBytes(total)})`);

  const htmlTitle = await htmlTitleOf(folder);
  const manifestSiteId = manifestString(manifest, "siteId");
  const manifestProjectId = manifestString(manifest, "projectId");
  const siteId = opts.newSite ? undefined : opts.siteId ?? manifestSiteId;
  const siteTitle =
    opts.title ?? manifestString(manifest, "title") ?? (siteId ? undefined : htmlTitle ?? (path.basename(manifestDir) || "새 사이트"));
  const base = /** @type {Record<string, unknown>} */ (defaultManifest(htmlTitle ?? ""));
  // dandi.json의 projectId는 새 사이트를 만들 때의 기본값일 뿐이다. 이미 있는 사이트는 --project를 줄 때만 옮긴다.
  const projectId = opts.projectId ?? (siteId ? undefined : manifestProjectId);
  const moveToProject = Boolean(opts.projectId && siteId);

  /** @type {DeployNote[]} */
  const notes = [...collected.notes, ...source.notes];
  const adopted =
    Boolean(argAbs && manifest && manifestSiteId && !manifestString(manifest, "outputDir")) &&
    !opts.newSite &&
    (!opts.siteId || opts.siteId === manifestSiteId) &&
    !samePath(manifestDir, folder) &&
    !BUILD_DIRS.includes(path.basename(folder).toLowerCase());
  if (adopted) {
    notes.push({
      path: MANIFEST_FILE,
      kind: "manifest_adopted",
      message: `${manifestFile}에 기록된 사이트(${manifestSiteId})를 이어서 올리고, 이 폴더를 outputDir로 기록했습니다.`,
    });
  }

  let result;
  try {
    result = await uploadSite(
      ctx,
      session,
      collected.files,
      { siteId, slug: opts.slug, title: siteTitle, projectId, moveToProject },
      {
        guide,
        onProgress: hooks.onProgress,
        onCreated: async (c) => {
          if (!writable) return;
          /** @type {Record<string, unknown>} */
          const patch = { siteId: c.siteId };
          if (c.projectId) patch.projectId = c.projectId;
          if (c.siteId !== manifestSiteId) {
            // 다른 사이트가 되었으면 예전 배포 ID는 쓸 수 없다. --new-site면 예전 siteId를 남겨 둔다.
            patch.lastDeployId = "";
            if (opts.newSite && manifestSiteId) patch.previousSiteId = manifestSiteId;
          }
          await writeManifestPatch(manifestFile, base, patch);
        },
      },
    );
  } catch (err) {
    if (err instanceof CliError && err.code === "site_not_found" && siteId) {
      const fromManifest = !opts.siteId && Boolean(manifest) && siteId === manifestSiteId;
      const folderCmd = retryFor("--new-site --json");
      throw await explainSiteNotFound(ctx, session, err, {
        siteId,
        fromManifest,
        via,
        newSiteStep: folderCmd ?? nextStep(prefix, 'deploy "<폴더>" --new-site --json'),
        newSiteAction: "call dandi_deploy_folder again with the same path and newSite: true (the old id is kept as previousSiteId in dandi.json)",
      });
    }
    throw err;
  }

  if (result.projectId && !opts.projectId && manifestProjectId && result.projectId !== manifestProjectId && siteId) {
    notes.push({
      path: MANIFEST_FILE,
      kind: "project_synced",
      message: `이 사이트는 허브에서 프로젝트 ${result.projectId}에 연결되어 있어 ${MANIFEST_FILE}의 projectId(${manifestProjectId})를 ${result.projectId}로 맞췄습니다. 프로젝트를 옮기려면 ${via === "cli" ? "deploy --project <id>를 쓰거나 " : ""}허브의 사이트 관리 화면에서 옮기십시오.`,
    });
  }
  if (opts.projectId && moveToProject && result.projectId === opts.projectId && manifestProjectId !== opts.projectId) {
    notes.push({ path: MANIFEST_FILE, kind: "project_moved", message: `사이트를 프로젝트 ${opts.projectId}로 옮겼습니다.` });
  }

  /** @type {string | null} */
  let manifestWritten = null;
  const outputDir = path.relative(manifestDir, folder).split(path.sep).join("/") || ".";
  if (writable) {
    /** @type {Record<string, unknown>} */
    const patch = { siteId: result.siteId, lastDeployId: result.deployId, outputDir };
    if (result.projectId) patch.projectId = result.projectId;
    await writeManifestPatch(manifestFile, base, patch);
    manifestWritten = manifestFile;
  }

  const published = await publishedInfo(ctx, session, result.siteId);
  const after = writable ? (await readManifest(manifestDir)).manifest : manifest;
  const check = validateManifest(after, { requireUrl: false });
  return {
    ...result,
    folder,
    manifestDir,
    skipped: collected.skipped,
    withheld: collected.withheld,
    notes,
    excluded: collected.excluded,
    manifestFile: manifestWritten,
    outputDir: manifestWritten ? outputDir : null,
    totalBytes: total,
    htmlTitle,
    published,
    answers: check.ok
      ? { complete: true, saved: savedAnswers(check.value), missing: [], needsSchoolApproval: check.value.privacyCheck.needsSchoolApproval }
      : { complete: false, saved: null, missing: check.missing, needsSchoolApproval: undefined },
  };
}

/**
 * manifest_in_parent 오류에 고를 수 있는 명령(같은 사이트 / 새 사이트)과 교사에게 물을 문장을 붙인다.
 * @param {Ctx} ctx
 * @param {CliError} err
 * @param {string} folder 올릴 폴더(절대 경로)
 * @param {string} prefix
 * @param {"cli" | "mcp"} via
 * @param {(rest: string) => string | null} retryFor 사용자가 적은 폴더로 다시 실행할 명령
 */
function explainParentManifest(ctx, err, folder, prefix, via, retryFor) {
  const extra = err.extra ?? {};
  const parent = path.dirname(folder);
  const siteId = String(extra.parent_siteId ?? "");
  const title = typeof extra.parent_title === "string" && extra.parent_title ? ` "${extra.parent_title}"` : "";
  const ask = `ASK the teacher in Korean whether this folder (${path.basename(folder)}) is the same site as the one recorded in ${String(extra.parent_manifest)} (site ${siteId}${title}). Do not guess.`;
  if (via === "mcp") {
    err.extra = {
      ...extra,
      agent_instructions: `${ask} If it is the same site, call dandi_deploy_folder again with the same path and siteId: "${siteId}". If it is a different site, call it again with newSite: true.`,
    };
    return err;
  }
  const dirArg = shellArg(displayPath(parent, ctx.cwd));
  const folderArg = shellArg(displayPath(folder, parent));
  const sameSite = dirArg && folderArg ? nextStep(prefix, `deploy ${folderArg} --dir ${dirArg} --json`) : null;
  const newSite = retryFor("--new-site --json");
  err.extra = {
    ...extra,
    choices: {
      same_site: sameSite ?? nextStep(prefix, `deploy "<폴더>" --dir "<${MANIFEST_FILE}이 있는 폴더>" --json`),
      new_site: newSite ?? nextStep(prefix, 'deploy "<폴더>" --new-site --json'),
    },
    agent_instructions: `${ask} If it is the same site, run choices.same_site (it keeps using that dandi.json and records outputDir). If it is a different site, run choices.new_site.`,
  };
  return err;
}

/**
 * deploy 결과를 교사·에이전트용 안내로 만든다(CLI와 stdio MCP가 함께 쓴다).
 * @param {DeployResult & {
 *   skipped?: { path: string, reason: string }[],
 *   withheld?: string[],
 *   notes?: DeployNote[],
 *   htmlTitle?: string | null,
 *   published?: PublishedInfo | null,
 *   answers?: { complete: boolean, saved: ReturnType<typeof savedAnswers> | null, missing: string[], needsSchoolApproval?: boolean } | null,
 * }} r
 * @param {string} hub
 * @param {{ publishHow: string }} how 등록할 때 할 일(예: "run next_step", "call dandi_publish_site")
 */
export function describeDeploy(r, hub, how) {
  const published = r.published ?? null;
  const skipped = r.skipped ?? [];
  const notes = r.notes ?? [];
  const answers = r.answers ?? null;
  // ⑤(학교 내부 승인)가 "예"인 앱: 셀프점검 답이 바뀌면 승인 완료를 표시할 때까지 이전 공개 버전이 유지된다.
  const approvalApp = published?.approvalStatus === "approved" || (published !== null && answers?.needsSchoolApproval === true);
  let message;
  if (!published) {
    message = "비공개 미리보기를 만들었습니다. 링크를 아는 사람만 볼 수 있고, 아직 허브에 공개되지 않았습니다.";
  } else if (published.approvalStatus === "pending") {
    message =
      "새 버전의 비공개 미리보기를 만들었습니다. 이 앱은 학교 내부 승인 대기 중이라, 허브에 다시 등록해도 학교 내부 승인 완료를 표시하기 전까지 공개 주소는 바뀌지 않습니다.";
  } else if (approvalApp) {
    message =
      "새 버전의 비공개 미리보기를 만들었습니다. 지금 공개된 버전은 허브에 다시 등록하기 전까지 그대로 유지됩니다. 셀프점검 답이 승인받을 때와 달라지면 학교 내부 승인 완료를 표시하기 전까지 유지됩니다.";
  } else {
    message = "새 버전의 비공개 미리보기를 만들었습니다. 지금 공개된 버전은 허브에 다시 등록하기 전까지 그대로 유지됩니다.";
  }
  const skippedWarnings = skipped.map((s) => ({
    path: s.path,
    kind: "skipped",
    message: `${s.reason}라서 올리지 않았습니다. 자료실(${hub}/files)에 올리거나 PDF로 바꾸어 링크하십시오.`,
  }));
  // warnings: 개인정보로 보이는 내용(허브 검사)과 올리지 않은 파일만. 참고 사항은 notes에 따로 둔다.
  const warnings = [...r.warnings, ...skippedWarnings];

  /** @type {string[]} */
  const parts = ["Show previewUrl to the teacher on its own line and say the message field in Korean."];
  if (skipped.length) {
    parts.push(
      `These files were NOT uploaded: ${skipped.map((s) => s.path).join(", ")}. Name them to the teacher and suggest uploading them to the hub 자료실 (${hub}/files) or converting them to PDF, then linking them from the site.`,
    );
  }
  if (r.warnings.length) parts.push("warnings with kind other than skipped point to files that may contain personal information; name those files to the teacher.");
  if (notes.length) parts.push("notes are information only (not personal data); mention them briefly if relevant.");
  if (notes.some((n) => n.kind === "source_module" || n.kind === "source_allowed")) {
    parts.push("index.html seems to load unbuilt source code. Open previewUrl yourself if you can; if the page is blank, build the project and deploy the build output folder instead.");
  }
  if ((r.withheld ?? []).length) parts.push("Build config files (package.json etc.) were withheld; if this is an unbuilt source folder, build it and deploy the output folder instead.");
  const stays = approvalApp
    ? `the current public version stays live until you ${how.publishHow} (and, if the privacy answers change, until the school approval is marked)`
    : published?.approvalStatus === "pending"
      ? "the app is waiting for school approval, so the public address does not change until the approval is marked"
      : `the current public version stays live until you ${how.publishHow}`;
  // 교사가 요청에 등록 정보·셀프점검 답을 이미 적었으면 다시 묻지 않고 그 답을 쓴다(허브 런북 5단계와 같은 규칙).
  const given = "If the teacher's request already gave these answers, use them as given without asking again and list them in your final report.";
  if (published && answers?.complete) {
    parts.push(
      `This site is already published (appUrl in published); ${stays}. List saved_answers to the teacher and ASK them to confirm or change them (skip the question if the request already said to keep or change them). Update dandi.json only with what they change, then ${how.publishHow}.`,
    );
  } else if (published && answers) {
    parts.push(
      `This site is already published; ${stays}. ${given} Otherwise ASK the teacher in ONE message for the empty items in missing (and to confirm the others), write the answers into dandi.json, then ${how.publishHow}. Never answer the privacy questions yourself.`,
    );
  } else if (published) {
    parts.push(
      `This site is already published; ${stays}. ASK the teacher to confirm (or change) the title, description, school levels, category and the 5 privacy answers used last time, then ${how.publishHow}. Never answer the privacy questions yourself.`,
    );
  } else {
    parts.push(
      `Title${r.htmlTitle ? ` (suggested: ${r.htmlTitle})` : ""}, a one-line description, schoolLevels (초/중/고/특수), category (수업/업무/학생지도/기타) and the 5 privacy questions in privacy_questions are needed to publish. ${given} Otherwise ASK the teacher in ONE message to confirm or answer them. Write the teacher's answers into dandi.json, then ${how.publishHow}. Never answer the privacy questions yourself.`,
    );
  }
  /** @type {string[]} */
  const lines = [message, r.previewUrl];
  if (published) {
    lines.push(`지금 공개된 주소: ${published.liveUrl ?? published.appUrl}`);
    if (answers?.saved) {
      lines.push("저장된 등록 정보와 셀프점검 답(바뀐 것이 없는지 교사에게 확인하십시오):");
      lines.push(`  제목: ${answers.saved.title}`, `  설명: ${answers.saved.description}`);
      lines.push(`  학교급: ${answers.saved.schoolLevels.join(", ")} · 분류: ${answers.saved.category}`);
      for (const p of answers.saved.privacy) lines.push(`  ${p}`);
    }
  }
  if (skipped.length) {
    lines.push(`올리지 않은 파일 ${skipped.length}개: ${skipped.slice(0, 10).map((s) => `${s.path}(${s.reason})`).join(", ")}`);
    lines.push(`  문서 파일은 허브 자료실(${hub}/files)에 올리거나 PDF로 바꾸어 링크하십시오.`);
  }
  if ((r.withheld ?? []).length) lines.push(`공개하지 않은 빌드 설정 파일: ${(r.withheld ?? []).join(", ")}`);
  for (const n of notes) if (n.kind !== "source_file") lines.push(`참고: ${n.message}`);
  if (r.warnings.length) {
    lines.push("개인정보로 보이는 내용이 있습니다. 공개 전에 확인하십시오:");
    for (const w of r.warnings) lines.push(`  - ${w.path}: ${w.message || w.kind}`);
  }
  return {
    message,
    warnings,
    notes,
    lines,
    agent_instructions: parts.join(" "),
    privacy_questions: answers?.complete ? undefined : PRIVACY_QUESTIONS.map((q) => `${q.mark} ${q.question} (${q.answer})`),
  };
}

/* ---------- 허브 등록 (publish) ---------- */

/**
 * deploy로 올린 사이트를 미니앱으로 공개 등록한다(POST /api/sites/{siteId}/publish).
 * @param {Ctx} ctx
 * @param {{ hub: string, token: string }} session
 * @param {string} siteId
 * @param {import("./lib.mjs").AppPayload} payload
 * @param {string | undefined} deployId
 * @param {{ retry?: string, deploy?: string | null }} [commands] 다시 실행할 publish·deploy 명령(null이면 적을 수 없음)
 */
export async function publishSite(ctx, session, siteId, payload, deployId, commands = {}) {
  const prefix = prefixFor(ctx, session.hub);
  const body = {
    title: payload.title,
    description: payload.description,
    schoolLevels: payload.schoolLevels,
    category: payload.category,
    privacyCheck: payload.privacyCheck,
  };
  const res = await hubRequest(session.hub, "POST", `/api/sites/${encodeURIComponent(siteId)}/publish`, {
    token: session.token,
    json: { ...(deployId ? { deployId } : {}), ...body },
  });
  if (!res.ok) {
    if (isSiteNotFound(res)) {
      // 호출한 쪽이 explainSiteNotFound로 계정 확인 안내를 붙인다. dandi.json은 바꾸지 않는다.
      throw new CliError("site_not_found", `사이트(${siteId})를 지금 로그인한 계정에서 찾을 수 없습니다.`, {
        hint: "다른 계정으로 로그인했거나 사이트가 지워졌을 수 있습니다.",
        nextStep: null,
        exitCode: EXIT.UPLOAD_REJECTED,
        extra: { siteId },
      });
    }
    if (res.status === 404) {
      const next = commands.deploy === undefined ? nextStep(prefix, "deploy --json") : commands.deploy;
      throw apiFailure(ctx, session.hub, res, "publish", {
        nextStep: next,
        nextStepTemplate: next ? undefined : nextStep(prefix, 'deploy "<폴더>" --json'),
        hint: "dandi.json의 lastDeployId가 이 사이트의 배포가 아닙니다. deploy를 다시 실행하십시오.",
      });
    }
    throw apiFailure(ctx, session.hub, res, "publish", { nextStep: commands.retry ?? nextStep(prefix, "publish --json") });
  }
  const d = isRecord(res.data) ? res.data : {};
  if (typeof d.appId !== "string") throw badResponse(res);
  return {
    ...d,
    appId: d.appId,
    appUrl: typeof d.appUrl === "string" ? d.appUrl : `${session.hub}/apps/${d.appId}`,
    liveUrl: typeof d.liveUrl === "string" ? d.liveUrl : null,
    // 이번에 등록한 버전의 미리보기 주소(승인 대기 중에도 작성자가 볼 수 있다)
    previewUrl: typeof d.previewUrl === "string" ? d.previewUrl : null,
    // "approved": 승인받은 셀프점검 답과 같아 승인 완료를 유지했다 / "not_required" / "pending"
    approvalStatus: typeof d.approvalStatus === "string" ? d.approvalStatus : "not_required",
    // "updated": 공개 주소가 이 버전을 보여 준다 / "kept_until_approval": 승인 완료를 표시할 때까지 이 버전은 공개되지 않는다
    liveVersion: typeof d.liveVersion === "string" ? d.liveVersion : null,
    message: typeof d.message === "string" && d.message.trim() ? d.message : null,
  };
}

/**
 * publish 결과를 교사·에이전트용 안내로 만든다(CLI와 stdio MCP가 함께 쓴다). 허브가 준 message를 그대로 쓰고,
 * 없을 때(예전 허브)만 approvalStatus·liveVersion으로 문장을 만든다.
 * @param {{ approvalStatus: string, liveVersion: string | null, message: string | null, appUrl: string, liveUrl: string | null, previewUrl?: unknown }} r
 */
export function describePublish(r) {
  const pending = r.approvalStatus === "pending";
  // 새 버전이 승인 완료 표시 전까지 공개되지 않는다(이미 공개한 앱이면 이전 버전이 공개 주소에 남는다).
  const keepsLive = r.liveVersion === "kept_until_approval";
  const approvalKept = r.approvalStatus === "approved";
  let fallback;
  if (pending && keepsLive) {
    fallback =
      "학교 내부 승인이 필요하다고 답했으므로 새 버전은 승인 대기 상태입니다. 승인 완료를 표시할 때까지 공개 주소는 이전에 공개한 버전(처음 등록이면 승인 대기 안내)을 보여 주고, 그동안 허브 목록에서 빠집니다. 승인을 받은 뒤 허브의 /studio/apps에서 내부 승인 완료를 표시하십시오.";
  } else if (pending) {
    fallback =
      "학교 내부 승인이 필요하다고 답했으므로 승인 대기 상태로 등록했습니다. 승인을 받은 뒤 허브의 /studio/apps에서 내부 승인 완료를 표시하면 공개됩니다.";
  } else if (approvalKept) {
    fallback = "셀프점검 답이 학교 내부 승인을 받을 때와 같아 승인 완료 상태를 유지했습니다. 공개 주소를 새 버전으로 바꿨습니다.";
  } else {
    fallback = "허브에 공개했습니다.";
  }
  const message = r.message ?? fallback;
  /** @type {string[]} */
  const parts = ["Say the message field to the teacher in Korean (it comes from the hub) and report appUrl on its own line."];
  if (keepsLive) {
    parts.push(
      "liveVersion is kept_until_approval: the new version is NOT public yet. Until the school approval is marked, liveUrl keeps showing the previously published version (or the approval-waiting notice if the app was never public) and the app is hidden from the hub listing, so appUrl is not visible to visitors. Report liveUrl as the address that still shows the old version, and previewUrl for checking the new version.",
    );
  } else if (approvalKept) {
    parts.push("approvalStatus approved: the privacy answers did not change, so the school approval was kept and the new version is live now at liveUrl.");
  }
  parts.push(`${APPROVAL_RULE}.`);
  return { message, keepsLive, agent_instructions: parts.join(" ") };
}

/**
 * 이미 다른 곳에 배포한 앱 주소를 등록한다(v0.1 방식, POST /api/cli/apps).
 * @param {Ctx} ctx
 * @param {{ hub: string, token: string }} session
 * @param {import("./lib.mjs").AppPayload} payload
 * @param {{ projectId?: string, retry?: string }} [extra]
 */
export async function publishExternalApp(ctx, session, payload, extra = {}) {
  const prefix = prefixFor(ctx, session.hub);
  const res = await hubRequest(session.hub, "POST", "/api/cli/apps", {
    token: session.token,
    json: { ...payload, ...(extra.projectId ? { projectId: extra.projectId } : {}) },
  });
  if (!res.ok) {
    const f = apiFailure(ctx, session.hub, res, "publish", { nextStep: extra.retry ?? nextStep(prefix, "publish --json") });
    // v0.1 API는 검증 오류를 400으로 돌려준다.
    if (res.status === 400) f.exitCode = EXIT.PUBLISH_INVALID;
    if (res.status === 400) f.code = "invalid_publish";
    throw f;
  }
  const d = isRecord(res.data) ? res.data : {};
  if (typeof d.id !== "string") throw badResponse(res);
  return {
    appId: d.id,
    appUrl: `${session.hub}${typeof d.url === "string" ? d.url : `/apps/${d.id}`}`,
    title: typeof d.title === "string" ? d.title : payload.title,
    approvalStatus: typeof d.approvalStatus === "string" ? d.approvalStatus : "not_required",
    ...(typeof d.projectId === "string" ? { projectId: d.projectId } : {}),
  };
}

/**
 * dandi.json 검사 실패를 종료 코드 21 오류로 만든다.
 * - missing: 비어 있음 → 교사에게 묻는다(한 번에).
 * - invalid_format: 교사는 답했고 형식만 틀림 → 에이전트가 허용값으로 고친다(다시 묻지 않음).
 * - conflicts: 서로 맞지 않는 답(①=예, ⑤=아니요) → 교사에게 다시 확인한다.
 * @param {Extract<import("./lib.mjs").ManifestCheck, { ok: false }>} check
 * @param {string} prefix
 * @param {{ retry?: string }} [options]
 */
export function manifestInvalid(check, prefix, options = {}) {
  const { missing, invalid, conflicts, errors } = check;
  const garbled = check.garbled ?? [];
  const firstTime = missing.some((f) => f === "privacyCheck" || f.startsWith("privacyCheck."));
  const ask = [...missing, ...conflicts.map((c) => c.field)];
  // 처음 등록이면(셀프점검이 비어 있음) 이미 적힌 제목·설명·학교급·분류도 교사에게 확인받는다.
  const confirm = firstTime ? ["title", "description", "schoolLevels", "category"].filter((f) => !ask.includes(f)) : [];
  /** @type {string[]} */
  const parts = [];
  if (ask.length) {
    parts.push(
      `ASK the teacher in ONE message about every item in missing${conflicts.length ? " and conflicts" : ""}${
        confirm.length ? `, and ask them to confirm the current ${confirm.join(", ")}` : ""
      }. You may suggest answers from the code, but the teacher must answer. Never answer the privacy questions yourself.`,
    );
  }
  if (invalid.some((i) => !garbled.includes(i.field))) {
    parts.push(
      "The items in invalid_format were already answered; do not ask the teacher again. Fix only their format in dandi.json using the allowed values named in each problem.",
    );
  }
  if (garbled.length) {
    parts.push(
      `The values of ${garbled.join(", ")} contain garbled characters (U+FFFD) from a wrong file encoding. Rewrite them with the teacher's original wording and save dandi.json as UTF-8 (PowerShell: Set-Content -Encoding UTF8). If you do not know the original wording, ASK the teacher again.`,
    );
  }
  parts.push("Then write the answers into dandi.json and run next_step.");
  const onlyFormat = ask.length === 0;
  return new CliError(
    "invalid_publish",
    onlyFormat ? "dandi.json의 일부 값 형식이 올바르지 않습니다." : "등록 정보나 셀프점검 항목이 비었거나 올바르지 않습니다.",
    {
      hint: errors.join(" / "),
      nextStep: options.retry ?? nextStep(prefix, "publish --json"),
      exitCode: EXIT.PUBLISH_INVALID,
      extra: {
        missing,
        invalid_format: invalid,
        conflicts,
        ...(garbled.length ? { garbled } : {}),
        ...(confirm.length ? { confirm } : {}),
        problems: errors,
        ...(firstTime ? { privacy_questions: PRIVACY_QUESTIONS.map((q) => `${q.mark} ${q.question} (${q.answer})`) } : {}),
        agent_instructions: parts.join(" "),
      },
    },
  );
}

/**
 * @param {unknown} manifest
 * @param {string} prefix
 * @param {{ requireUrl: boolean, retry?: string }} options
 */
export function checkManifest(manifest, prefix, options) {
  const checked = validateManifest(manifest, { requireUrl: options.requireUrl });
  if (!checked.ok) throw manifestInvalid(checked, prefix, { retry: options.retry });
  return checked.value;
}

/* ---------- 사이트 목록·스킬·런북 ---------- */

/**
 * @param {Ctx} ctx
 * @param {{ hub: string, token: string }} session
 */
export async function listMySites(ctx, session) {
  const res = await hubRequest(session.hub, "GET", "/api/sites", { token: session.token });
  if (!res.ok) throw apiFailure(ctx, session.hub, res, "other");
  const d = isRecord(res.data) ? res.data : {};
  return Array.isArray(d.sites) ? d.sites.filter(isRecord) : [];
}

/**
 * @param {Ctx} ctx
 * @param {{ hub: string, token: string | null }} session
 * @param {string} query
 */
export async function listSkills(ctx, session, query) {
  const q = query ? `?q=${encodeURIComponent(query)}` : "";
  const res = await hubRequest(session.hub, "GET", `/api/skills${q}`, { token: session.token });
  if (!res.ok) throw apiFailure(ctx, session.hub, res, "other");
  const d = isRecord(res.data) ? res.data : {};
  if (!Array.isArray(d.skills)) throw badResponse(res);
  return d.skills.filter(isRecord);
}

/**
 * @param {Ctx} ctx
 * @param {{ hub: string, token: string | null }} session
 * @param {string} name
 */
export async function getSkill(ctx, session, name) {
  const res = await hubRequest(session.hub, "GET", `/api/skills/${encodeURIComponent(name)}`, { token: session.token });
  if (!res.ok) throw apiFailure(ctx, session.hub, res, "other");
  if (!isRecord(res.data)) throw badResponse(res);
  return isRecord(res.data.skill) ? res.data.skill : res.data;
}

/**
 * 스킬 폴더를 게시한다(POST /api/skills, 계약 6).
 * @param {Ctx} ctx
 * @param {{ hub: string, token: string }} session
 * @param {string} folder
 * @param {{ title?: string }} [meta]
 */
export async function publishSkillFolder(ctx, session, folder, meta = {}) {
  const prefix = prefixFor(ctx, session.hub);
  const retry = commandWithFolder(prefix, "skill publish", displayPath(folder, ctx.cwd), "--json");
  const retryOpts = retry
    ? { nextStep: retry }
    : { nextStep: /** @type {null} */ (null), nextStepTemplate: nextStep(prefix, 'skill publish "<폴더>" --json') };
  if (!(await isDir(folder))) {
    throw new CliError("folder_not_found", `폴더를 찾을 수 없습니다: ${folder}`, {
      nextStep: null,
      nextStepTemplate: nextStep(prefix, 'skill publish "<폴더>" --json'),
    });
  }
  if (!(await isFile(path.join(folder, "SKILL.md")))) {
    throw new CliError("invalid_skill", "폴더 맨 위에 SKILL.md가 없습니다.", {
      hint: "SKILL.md 앞부분에 name(소문자·하이픈), description, license를 적으십시오.",
      ...retryOpts,
      exitCode: EXIT.PUBLISH_INVALID,
    });
  }
  const walked = await walkFolder(folder, { maxFiles: SKILL_LIMITS.fileCount });
  const total = walked.files.reduce((s, f) => s + f.size, 0);
  if (walked.files.length > SKILL_LIMITS.fileCount || total > SKILL_LIMITS.totalBytes) {
    throw new CliError("bundle_rejected", `스킬 폴더는 파일 ${SKILL_LIMITS.fileCount}개, 합계 ${formatBytes(SKILL_LIMITS.totalBytes)} 이하여야 합니다.`, {
      hint: `지금: 파일 ${walked.files.length}개, ${formatBytes(total)}`,
      ...retryOpts,
      exitCode: EXIT.UPLOAD_REJECTED,
    });
  }
  /** @type {FileBytes[]} */
  const files = [];
  for (const f of walked.files) files.push({ path: f.path, bytes: new Uint8Array(await fs.readFile(f.abs)) });
  const secrets = scanSecrets(files, { allText: true });
  if (secrets.length) {
    throw new CliError("secret_detected", "비밀값(토큰·API 키)으로 보이는 내용이 있어 게시하지 않았습니다.", {
      hint: `${secrets.map((s) => `${s.path}(${s.kind})`).join(", ")}. 키를 지우고 다시 게시하십시오. 키를 숨기거나 나눠서 검사를 피하지 마십시오.`,
      ...retryOpts,
      exitCode: EXIT.UPLOAD_REJECTED,
    });
  }
  const res = await hubRequest(session.hub, "POST", "/api/skills", {
    token: session.token,
    json: {
      files: files.map((f) => ({ path: f.path, contentBase64: Buffer.from(f.bytes).toString("base64") })),
      ...(meta.title ? { title: meta.title } : {}),
    },
    timeoutMs: 120_000,
  });
  if (!res.ok) {
    const failure = apiFailure(ctx, session.hub, res, "skill_publish", retryOpts);
    if (res.status === 422) failure.exitCode = EXIT.PUBLISH_INVALID;
    throw failure;
  }
  const d = isRecord(res.data) ? res.data : {};
  if (typeof d.name !== "string") throw badResponse(res);
  return {
    name: d.name,
    version: typeof d.version === "string" ? d.version : "",
    status: typeof d.status === "string" ? d.status : "",
    findings: Array.isArray(d.findings) ? d.findings.map(String) : [],
    url: typeof d.url === "string" ? d.url : `${session.hub}/skills/${d.name}`,
    files: files.length,
  };
}

/**
 * 허브의 /llms.txt 원문. 받지 못하면 null.
 * @param {string} hub
 * @returns {Promise<string | null>}
 */
export async function fetchGuide(hub) {
  try {
    const res = await fetch(`${hub}/llms.txt`, {
      headers: { Accept: "text/markdown, text/plain;q=0.9, */*;q=0.1", "User-Agent": `${CLI_NAME}/${CLI_TAG}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}
