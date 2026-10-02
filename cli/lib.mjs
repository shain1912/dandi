// dandi CLI의 순수 도우미 모음. 네트워크 요청과 파일 쓰기를 하지 않으므로 단위 테스트할 수 있다.
// (예외: 시작할 때 같은 폴더의 build-info.json을 한 번 읽는다. pack-cli가 만든 빌드 태그를 알기 위해서다.)
// 허브(Next.js) 코드와 독립적으로 배포되는 CLI이므로 학교급·분류·업로드 한도를 여기에 따로 둔다.
// 목록을 바꿀 때는 src/lib/constants.ts, src/lib/sites.ts(SITE_LIMITS, SITE_ALLOWED_EXT)와 함께 바꾼다.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLI_NAME = "dandi";
/** cli/package.json의 version과 같아야 한다(테스트가 확인). */
export const CLI_VERSION = "0.2.0";
export const DEFAULT_HUB = "http://localhost:3000";
export const MANIFEST_FILE = "dandi.json";
export const LLMS_FILE = "llms.txt";

/* ---------- 빌드 태그 (npx 캐시 문제 대응) ---------- */

// npx는 같은 tarball 주소로 이미 설치한 CLI를 계속 실행한다. 그래서 허브는 소스 해시를 붙인
// dandi-<version>-<sha8>.tgz로 CLI를 내놓고(scripts/pack-cli.mjs), CLI는 자기 태그를 build-info.json에서 읽어
// 안내 명령(next_step)을 그 이름으로 만든다.
const TAG_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TARBALL_NAME_RE = /^dandi-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/;

/**
 * build-info.json 내용(또는 허브의 /dandi-latest.json)을 확인한다. 형식이 맞지 않으면 버전만으로 만든 기본값.
 * @param {unknown} value
 * @param {string} [version]
 * @returns {{ version: string, tag: string, tarball: string }}
 */
export function parseBuildInfo(value, version = CLI_VERSION) {
  const fallback = { version, tag: version, tarball: `dandi-${version}.tgz` };
  if (!isRecord(value) || typeof value.tag !== "string") return fallback;
  const tag = value.tag;
  if (!TAG_RE.test(tag) || (tag !== version && !tag.startsWith(`${version}-`))) return fallback;
  const tarball = typeof value.tarball === "string" && TARBALL_NAME_RE.test(value.tarball) ? value.tarball : `dandi-${tag}.tgz`;
  return { version, tag, tarball };
}

/**
 * 허브의 /dandi-latest.json. 버전이 달라도 받아들인다(새 버전 안내용). 형식이 틀리면 null.
 * @param {unknown} value
 * @returns {{ version: string, tag: string, tarball: string } | null}
 */
export function parseLatestInfo(value) {
  if (!isRecord(value) || typeof value.version !== "string" || typeof value.tag !== "string") return null;
  if (!TAG_RE.test(value.version) || !TAG_RE.test(value.tag)) return null;
  const info = parseBuildInfo(value, value.version);
  return info.tag === value.tag ? info : null;
}

function loadBuildInfo() {
  try {
    return parseBuildInfo(JSON.parse(readFileSync(new URL("./build-info.json", import.meta.url), "utf8")));
  } catch {
    return parseBuildInfo(null);
  }
}

/** 이 CLI의 빌드 정보. build-info.json이 없으면(저장소에서 바로 실행) 태그 = 버전. */
export const CLI_BUILD = Object.freeze(loadBuildInfo());
export const CLI_TAG = CLI_BUILD.tag;

/** 종료 코드(계약 3-2). 에이전트가 원인별로 다음 행동을 정한다. */
export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  LOGIN_REQUIRED: 4,
  PENDING: 5,
  DENIED: 6,
  EXPIRED: 7,
  UPLOAD_REJECTED: 20,
  PUBLISH_INVALID: 21,
});

/** @type {{ id: string, label: string }[]} */
export const SCHOOL_LEVELS = [
  { id: "elem", label: "초" },
  { id: "middle", label: "중" },
  { id: "high", label: "고" },
  { id: "special", label: "특수" },
];

/** @type {{ id: string, label: string }[]} */
export const APP_CATEGORIES = [
  { id: "class", label: "수업" },
  { id: "work", label: "업무" },
  { id: "guidance", label: "학생지도" },
  { id: "etc", label: "기타" },
];

/** 허브 정적 호스팅 한도(계약 2-2). */
export const SITE_LIMITS = Object.freeze({ totalBytes: 20 * 1024 * 1024, fileCount: 1000, fileBytes: 5 * 1024 * 1024 });
export const SITE_ALLOWED_EXT = [
  "html", "htm", "css", "js", "mjs", "json", "txt", "md", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico",
  "avif", "woff", "woff2", "ttf", "mp3", "mp4", "webm", "wasm", "xml", "csv", "pdf",
];
/** 비밀값 검사를 하는 텍스트 파일 확장자 */
export const TEXT_EXT = ["html", "htm", "css", "js", "mjs", "json", "txt", "md", "svg", "xml", "csv"];
/** MCP dandi_deploy_files 한 번에 받을 수 있는 합계 크기 */
export const DEPLOY_FILES_MAX_BYTES = 5 * 1024 * 1024;
/** 스킬 폴더 한도(CLI 쪽 사전 검사, src/lib/skills.ts SKILL_LIMITS와 같게) */
export const SKILL_LIMITS = Object.freeze({ totalBytes: 10 * 1024 * 1024, fileCount: 200 });

// sk- 키: 영숫자 20자 이상(계약 2-2)과, 하이픈·밑줄이 섞인 새 형식(sk-proj-…, sk-ant-…).
// 허브(src/app/studio/sites/secret-scan.ts)와 같은 정규식이다. 규칙을 바꾸면 두 곳을 함께 바꾼다.
const SK_CLASSIC_RE = /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}/;
const SK_MODERN_RE = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g;

/**
 * 새 형식 sk- 키인가. CSS 클래스 이름(sk-folding-cube 등)과 구별하려고 대문자·소문자·숫자가 모두 있을 때만 인정한다.
 * @param {string} text
 */
function hasModernSkKey(text) {
  for (const m of text.matchAll(SK_MODERN_RE)) {
    const v = m[0];
    if (/[A-Z]/.test(v) && /[a-z]/.test(v.slice(3)) && /\d/.test(v)) return true;
  }
  return false;
}

/**
 * 업로드하면 안 되는 비밀값 패턴(계약 2-2). 허브도 finalize에서 같은 규칙으로 거부하지만,
 * CLI가 먼저 잡아 키가 허브 저장소에 올라가지 않게 한다.
 * @type {{ name: string, test: (text: string) => boolean }[]}
 */
export const SECRET_PATTERNS = [
  { name: "Dandi CLI 토큰", test: (t) => /dd_cli_/.test(t) },
  { name: "Dandi 프로젝트 API 키", test: (t) => /dd_sk_/.test(t) },
  { name: "Dandi MCP 접근 토큰", test: (t) => /dd_mat_/.test(t) },
  { name: "AI API 키(sk-...)", test: (t) => SK_CLASSIC_RE.test(t) || hasModernSkKey(t) },
  { name: "Supabase service_role 키", test: (t) => /service_role/.test(t) },
  { name: "개인 키(PRIVATE KEY)", test: (t) => /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/.test(t) },
];

/** 에이전트 환경 변수(계약 3-2). 하나라도 있으면 2단계 로그인(JSON 출력 후 종료)을 쓴다. */
export const AGENT_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "AI_AGENT",
  "CODEX_SANDBOX",
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "CURSOR_AGENT",
  "GEMINI_CLI",
  // Antigravity CLI(agy)와 Grok이 셸 명령에 넣어 주는 변수(agy 1.2.12, grok 1.0.30에서 확인)
  "ANTIGRAVITY_AGENT",
  "GROK_SESSION_ID",
];

export const AGENT_INSTRUCTIONS_LOGIN =
  "Show verification_uri_complete and user_code to the user exactly as given and ask them to approve in the browser. Then, in the same turn, run next_step in the foreground (not as a background task; do not end your turn to wait for a reply). It waits up to 90 seconds for the approval by itself. Repeat next_step while status is pending.";

/* ---------- 명령줄 인자 ---------- */

const VALUE_FLAGS = new Set(["hub", "url", "title", "dir", "site", "slug", "timeout", "agent", "project"]);
const BOOLEAN_FLAGS = new Set(["help", "json", "wait", "token-stdin", "vercel", "version", "global", "force", "new-site", "allow-source"]);
/** @type {Record<string, string>} */
const SHORT_FLAGS = { h: "help", g: "global", v: "version" };

/**
 * 명령줄 인자를 해석한다. `--name value`, `--name=value`, 불리언 `--json`, 짧은 `-h -g -v`를 지원한다.
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ command: string, args: string[], flags: Record<string, string | boolean>, errors: string[] }}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const positionals = [];
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  /** @type {string[]} */
  const errors = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (/^-[A-Za-z]$/.test(arg)) {
      const name = SHORT_FLAGS[arg.slice(1)];
      if (name) flags[name] = true;
      else errors.push(`알 수 없는 옵션입니다: ${arg}`);
      continue;
    }
    if (!arg.startsWith("--") || arg === "--") {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq >= 0) errors.push(`--${name} 옵션에는 값을 붙이지 않습니다.`);
      else flags[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      errors.push(`알 수 없는 옵션입니다: --${name}`);
      continue;
    }
    if (eq >= 0) {
      flags[name] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      errors.push(`--${name} 옵션에 값이 필요합니다.`);
      continue;
    }
    flags[name] = next;
    i++;
  }

  const [command = "", ...args] = positionals;
  return { command, args, flags, errors };
}

/** 명령별로 받을 수 있는 옵션과 위치 인자 수. hub·json·help는 모든 명령에서 받는다. */
export const COMMAND_SPECS = Object.freeze({
  login: { flags: ["wait", "timeout", "token-stdin", "force"], maxArgs: 0 },
  logout: { flags: [], maxArgs: 0 },
  whoami: { flags: [], maxArgs: 0 },
  init: { flags: ["dir", "title"], maxArgs: 0 },
  deploy: { flags: ["dir", "site", "slug", "title", "vercel", "new-site", "project", "allow-source"], maxArgs: 1 },
  publish: { flags: ["dir", "url", "title"], maxArgs: 0 },
  guide: { flags: [], maxArgs: 0 },
  mcp: { flags: [], maxArgs: 0 },
  skill: { flags: ["agent", "global", "title"], maxArgs: 50 },
  setup: { flags: ["agent", "global"], maxArgs: 0 },
  help: { flags: [], maxArgs: 1 },
  version: { flags: [], maxArgs: 0 },
});
const COMMON_FLAGS = ["hub", "json", "help", "version"];

/** login에 토큰을 위치 인자로 넘겼을 때의 오류 문장(사용법은 tokenStdinUsage로 따로 보여 준다). */
export const LOGIN_TOKEN_ARG_ERROR =
  "토큰을 명령줄 인자로 넘기지 마십시오(셸 기록과 프로세스 목록에 남습니다). 보통은 인자 없이 login을 실행해 브라우저에서 승인하고, CI에서는 --token-stdin으로 표준입력에서 넘기십시오.";

/**
 * 해석한 인자가 명령에 맞는지 확인한다. 문제가 있으면 사람이 읽을 문장 목록을 돌려준다.
 * @param {{ command: string, args: string[], flags: Record<string, string | boolean> }} parsed
 * @returns {string[]}
 */
export function validateCommand(parsed) {
  const spec = Object.hasOwn(COMMAND_SPECS, parsed.command)
    ? COMMAND_SPECS[/** @type {keyof typeof COMMAND_SPECS} */ (parsed.command)]
    : null;
  if (!spec) return [`알 수 없는 명령입니다: ${parsed.command}`];
  /** @type {string[]} */
  const errors = [];
  const allowed = new Set([...COMMON_FLAGS, ...spec.flags]);
  for (const name of Object.keys(parsed.flags)) {
    if (!allowed.has(name)) errors.push(`${parsed.command} 명령에서 쓰지 않는 옵션입니다: --${name}`);
  }
  if (parsed.command === "login" && parsed.args.length > 0) {
    errors.push(LOGIN_TOKEN_ARG_ERROR);
    return errors;
  }
  if (parsed.args.length > spec.maxArgs) {
    errors.push(`이 명령에서 쓰지 않는 인자가 있습니다: ${parsed.args.slice(spec.maxArgs).join(" ")}`);
    if (parsed.command === "publish" && /^https?:\/\//.test(parsed.args[0] ?? "")) {
      errors.push(`배포 주소는 --url 옵션으로 넘기십시오. 예: publish --url ${parsed.args[0]}`);
    }
  }
  if (parsed.command === "deploy" && parsed.flags["new-site"] && parsed.flags.site !== undefined) {
    errors.push("--new-site와 --site는 함께 쓸 수 없습니다.");
  }
  if (parsed.command === "deploy" && parsed.flags.vercel) {
    for (const name of ["project", "allow-source"]) {
      if (parsed.flags[name] !== undefined) errors.push(`--${name} 옵션은 --vercel과 함께 쓰지 않습니다.`);
    }
  }
  if (parsed.command === "deploy" && typeof parsed.flags.project === "string" && !isValidSiteId(parsed.flags.project.trim())) {
    errors.push(`프로젝트 ID 형식이 올바르지 않습니다: ${parsed.flags.project} (허브의 /studio/projects에 보이는 prj_로 시작하는 ID)`);
  }
  if (parsed.command === "skill") {
    const [sub, ...rest] = parsed.args;
    if (!sub) errors.push("skill 다음에 add, publish, list 중 하나를 적으십시오.");
    else if (sub === "add") {
      if (rest.length !== 1) errors.push("설치할 스킬 이름을 하나 적으십시오. 예: skill add quiz-maker");
      else if (!isValidSkillName(rest[0])) errors.push(`스킬 이름 형식이 올바르지 않습니다: ${rest[0]} (소문자·숫자·하이픈 64자 이하)`);
    } else if (sub === "publish") {
      if (rest.length > 1) errors.push("skill publish에는 폴더를 하나만 적으십시오.");
    } else if (sub !== "list") {
      errors.push(`알 수 없는 skill 명령입니다: ${sub} (add, publish, list)`);
    }
    for (const name of ["agent", "global"]) {
      if (parsed.flags[name] !== undefined && sub !== "add") errors.push(`--${name} 옵션은 skill add에서만 씁니다.`);
    }
    if (parsed.flags.title !== undefined && sub !== "publish") errors.push("--title 옵션은 skill publish에서만 씁니다.");
  }
  if (parsed.command === "login") {
    if (parsed.flags.timeout !== undefined && !parsed.flags.wait) errors.push("--timeout 옵션은 --wait와 함께 씁니다.");
    if (parsed.flags.wait && parsed.flags["token-stdin"]) errors.push("--wait와 --token-stdin은 함께 쓸 수 없습니다.");
    if (parsed.flags.force && parsed.flags.wait) errors.push("--force는 새 로그인을 시작할 때만 씁니다(--wait와 함께 쓰지 않음).");
    if (parsed.flags.timeout !== undefined && parseTimeout(parsed.flags.timeout) === null) {
      errors.push("--timeout은 1~600 사이의 초 단위 정수여야 합니다.");
    }
  }
  return errors;
}

/**
 * --token-stdin 사용법(bash와 PowerShell). 설치하지 않은 dandi 대신 실행 접두어를 쓴다.
 * 접두어가 npx(또는 npx.cmd)로 시작하면 셸마다 맞는 이름으로 바꾼다(bash는 npx, Windows PowerShell은 npx.cmd).
 * @param {string} prefix
 * @param {string} [platform]
 * @returns {string[]}
 */
export function tokenStdinUsage(prefix, platform = process.platform) {
  return [
    `bash: printf %s "$DANDI_TOKEN" | ${withNpxCommand(prefix, "npx")} login --token-stdin`,
    `PowerShell: $env:DANDI_TOKEN | ${withNpxCommand(prefix, platform === "win32" ? "npx.cmd" : "npx")} login --token-stdin`,
  ];
}

/**
 * --timeout 값(초). 올바르지 않으면 null.
 * @param {string | boolean | undefined} value
 * @returns {number | null}
 */
export function parseTimeout(value) {
  if (typeof value !== "string" || !/^\d{1,4}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n >= 1 && n <= 600 ? n : null;
}

/**
 * 문자열 플래그 값만 꺼낸다(불리언 플래그나 빈 값은 undefined).
 * @param {Record<string, string | boolean>} flags
 * @param {string} name
 * @returns {string | undefined}
 */
export function stringFlag(flags, name) {
  const v = flags[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/* ---------- 경로·셸 인자 ---------- */

/**
 * Git Bash(MSYS)·Cygwin 형식 경로(/c/Users/..., /cygdrive/c/...)를 Windows 경로(C:/Users/...)로 바꾼다.
 * Windows가 아니거나 해당 형식이 아니면 그대로 돌려준다.
 * @param {string} p
 * @param {string} [platform]
 */
export function fromMsysPath(p, platform = process.platform) {
  if (platform !== "win32" || typeof p !== "string") return p;
  const m = /^\/(?:cygdrive\/)?([A-Za-z])(?:\/(.*))?$/.exec(p);
  if (!m) return p;
  return `${m[1].toUpperCase()}:/${m[2] ?? ""}`;
}

/**
 * 안내 명령에 적을 폴더 표기. 현재 폴더 안이면 상대 경로, 밖이면 절대 경로. 구분자는 항상 /.
 * @param {string} abs
 * @param {string} cwd
 */
export function displayPath(abs, cwd) {
  const rel = path.relative(cwd, abs);
  let shown = rel === "" ? "." : rel.startsWith("..") || path.isAbsolute(rel) ? abs : rel;
  shown = shown.split(path.sep).join("/").replace(/\\/g, "/");
  return shown.startsWith("-") ? `./${shown}` : shown;
}

/**
 * bash와 PowerShell 양쪽에서 그대로 실행되는 인자 표기. 필요하면 큰따옴표로 감싼다.
 * 두 셸 모두에서 안전하게 적을 수 없는 문자($ ` " \ 제어 문자)가 있으면 null.
 * @param {string} value
 * @returns {string | null}
 */
export function shellArg(value) {
  if (typeof value !== "string" || value === "") return null;
  if (/[\u0000-\u001f\u007f"`$\\]/.test(value)) return null;
  if (/^[A-Za-z0-9._/:=+-]+$/.test(value) && !value.startsWith("-")) return value;
  return `"${value}"`;
}

/**
 * 폴더를 넣은 명령. 폴더를 안전하게 적을 수 없으면 null(안내 명령을 만들지 않음).
 * @param {string} prefix
 * @param {string} command 예: "deploy"
 * @param {string | undefined} folder 표기할 폴더(없으면 폴더 없이)
 * @param {string} rest 예: "--json"
 * @returns {string | null}
 */
export function commandWithFolder(prefix, command, folder, rest) {
  if (folder === undefined) return nextStep(prefix, `${command} ${rest}`);
  const arg = shellArg(folder);
  return arg ? nextStep(prefix, `${command} ${arg} ${rest}`) : null;
}

/* ---------- 설정·주소 ---------- */

/**
 * 설정 폴더. DANDI_CONFIG_DIR 환경 변수가 있으면 그 폴더를 사용한다(테스트·CI용).
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function configDir(env = process.env, home = os.homedir()) {
  const override = env.DANDI_CONFIG_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(home, ".dandi");
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function configPath(env = process.env, home = os.homedir()) {
  return path.join(configDir(env, home), "config.json");
}

/**
 * 승인 대기 중인 로그인(device code) 정보 파일.
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function pendingPath(env = process.env, home = os.homedir()) {
  return path.join(configDir(env, home), "pending.json");
}

/**
 * 허브 주소를 정리한다. http(s)가 아니면 null을 돌려준다. 끝의 /는 뗀다.
 * @param {string | undefined | null} input
 * @returns {string | null}
 */
export function normalizeHub(input) {
  if (!input || !input.trim()) return null;
  let u;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash) return null;
  const pathname = u.pathname.replace(/\/+$/, "");
  return `${u.origin}${pathname}`;
}

/**
 * 저장된 설정 파일 내용이 올바른지 확인한다.
 * @param {unknown} value
 * @returns {{ hub: string, token: string } | null}
 */
export function parseConfig(value) {
  if (!isRecord(value)) return null;
  const { hub, token } = value;
  if (typeof hub !== "string" || typeof token !== "string") return null;
  const normalized = normalizeHub(hub);
  if (!normalized || !token.startsWith("dd_cli_")) return null;
  return { hub: normalized, token };
}

/**
 * pending.json 내용 확인.
 * @param {unknown} value
 * @returns {{ hub: string, device_code: string, user_code: string, verification_uri: string, verification_uri_complete: string, interval: number, expires_at: string } | null}
 */
export function parsePending(value) {
  if (!isRecord(value)) return null;
  const hub = typeof value.hub === "string" ? normalizeHub(value.hub) : null;
  const strings = ["device_code", "user_code", "verification_uri", "verification_uri_complete", "expires_at"];
  if (!hub || strings.some((k) => typeof value[k] !== "string" || !value[k])) return null;
  if (Number.isNaN(Date.parse(String(value.expires_at)))) return null;
  return {
    hub,
    device_code: String(value.device_code),
    user_code: String(value.user_code),
    verification_uri: String(value.verification_uri),
    verification_uri_complete: String(value.verification_uri_complete),
    interval: clampInterval(value.interval),
    expires_at: String(value.expires_at),
  };
}

/**
 * 폴링 간격(초). 허브가 준 값을 1~60초로 제한하고, 없으면 RFC 8628 기본값 5초.
 * @param {unknown} value
 */
export function clampInterval(value) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 5;
  return Math.min(60, Math.max(1, n));
}

const TARBALL_SPEC = /^(https?:\/\/[^\s?#]+?)\/dandi-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/;

/**
 * `npx -y <hub>/dandi-<ver>.tgz`로 실행했을 때 허브 주소를 알아낸다.
 * npx는 설치 폴더의 package.json(dependencies, _npx.packages)에 tarball 주소를 적어 둔다.
 * @param {unknown} pkg 설치 폴더의 package.json 내용
 * @returns {string | null}
 */
export function hubFromInstallSpec(pkg) {
  if (!isRecord(pkg)) return null;
  /** @type {string[]} */
  const specs = [];
  if (isRecord(pkg.dependencies) && typeof pkg.dependencies[CLI_NAME] === "string") {
    specs.push(/** @type {string} */ (pkg.dependencies[CLI_NAME]));
  }
  if (isRecord(pkg._npx) && Array.isArray(pkg._npx.packages)) {
    for (const s of pkg._npx.packages) if (typeof s === "string") specs.push(s);
  }
  for (const spec of specs) {
    const m = TARBALL_SPEC.exec(spec.trim());
    const hub = m ? normalizeHub(m[1]) : null;
    if (hub) return hub;
  }
  return null;
}

/**
 * 지금 셸에서 그대로 실행되는 npx 이름.
 * - Windows PowerShell·cmd: npx.cmd (PowerShell 기본 실행 정책은 npx.ps1을 막는다)
 * - Git Bash·MSYS(Windows의 Claude Code가 쓰는 셸, MSYSTEM이 있음)·macOS·Linux: npx
 *   (Git Bash에서 npx.cmd는 공백이 있는 인자를 cmd.exe가 망가뜨린다)
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 * @returns {"npx" | "npx.cmd"}
 */
export function npxCommand(env = process.env, platform = process.platform) {
  if (platform !== "win32") return "npx";
  return typeof env.MSYSTEM === "string" && env.MSYSTEM.trim() !== "" ? "npx" : "npx.cmd";
}

/**
 * 접두어 맨 앞의 npx·npx.cmd를 주어진 이름으로 바꾼다(npx로 시작하지 않으면 그대로).
 * @param {string} prefix
 * @param {"npx" | "npx.cmd"} command
 */
export function withNpxCommand(prefix, command) {
  return prefix.replace(/^npx(?:\.cmd)?(?=\s)/, command);
}

/**
 * 안내 명령의 실행 접두어. 기본은 허브가 제공하는 이 빌드의 tarball(dandi-<tag>.tgz)을 npx로 실행하는 형식이고,
 * npx 이름은 지금 셸에 맞춘다(npxCommand). DANDI_NPX 환경 변수로 바꿀 수 있다(예: "node cli/dandi.mjs").
 * @param {string} hub
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [spec] tarball 파일 이름(dandi-….tgz) 또는 버전·태그(예: "0.2.0", "0.2.0-1a2b3c4d")
 * @param {string} [platform]
 */
export function npxPrefix(hub, env = process.env, spec = CLI_BUILD.tarball, platform = process.platform) {
  const override = env.DANDI_NPX?.trim();
  if (override) return override;
  const file = spec.endsWith(".tgz") ? spec : `dandi-${spec}.tgz`;
  return `${npxCommand(env, platform)} -y ${hub}/${file}`;
}

/**
 * @param {string} prefix
 * @param {string} rest
 */
export function nextStep(prefix, rest) {
  return `${prefix} ${rest}`.trim();
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 */
function envSet(env, name) {
  const v = env[name];
  return typeof v === "string" && v.trim() !== "" && v.trim() !== "0" && v.trim().toLowerCase() !== "false";
}

/**
 * 에이전트·비대화형 환경인지 판단하고, device 로그인 요청에 적을 도구 이름을 정한다.
 * @param {Record<string, string | undefined>} env
 * @param {boolean} stdinIsTTY
 * @returns {{ agent: boolean, client: string }}
 */
export function detectAgent(env, stdinIsTTY) {
  /** @type {string | null} */
  let name = null;
  if (envSet(env, "CLAUDECODE") || envSet(env, "CLAUDE_CODE_ENTRYPOINT")) name = "claude-code";
  else if (envSet(env, "CODEX_SANDBOX") || envSet(env, "CODEX_CI") || envSet(env, "CODEX_THREAD_ID")) name = "codex";
  else if (envSet(env, "CURSOR_AGENT")) name = "cursor";
  else if (envSet(env, "ANTIGRAVITY_AGENT")) name = "antigravity";
  else if (envSet(env, "GROK_SESSION_ID")) name = "grok";
  else if (envSet(env, "GEMINI_CLI")) name = "gemini-cli";
  else if (envSet(env, "AI_AGENT")) name = sanitizeClientName(String(env.AI_AGENT)) || "ai-agent";
  if (name) return { agent: true, client: name };
  return stdinIsTTY ? { agent: false, client: "terminal" } : { agent: true, client: "non-interactive" };
}

/**
 * 허브에 보낼 도구 이름. 영문·숫자·일부 기호만 남기고 40자로 자른다.
 * @param {string} value
 */
export function sanitizeClientName(value) {
  return value.replace(/[^A-Za-z0-9._:@ -]/g, "").trim().slice(0, 40);
}

/* ---------- 출력·오류 ---------- */

/**
 * 출력에 섞일 수 있는 비밀값(토큰·키·device code)을 가린다. 모든 출력의 마지막 방어선이다.
 * @param {string} text
 */
export function redactSecrets(text) {
  return text.replace(/\bdd_(cli|sk|mat|mrt|dev)_[A-Za-z0-9_-]+/g, "dd_$1_***");
}

/**
 * ASCII만 쓴 JSON 문자열. 한글 등 ASCII가 아닌 문자는 \uXXXX로 적는다(formatJsonOutput이 필요할 때만 쓴다).
 * Windows PowerShell(콘솔 코드 페이지 949)이 출력을 받아 ConvertFrom-Json 해도 글자가 깨지지 않게 하기 위해서다.
 * @param {unknown} value
 */
export function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * --json 출력의 한글을 \uXXXX로 적을 것인가. 기본은 UTF-8 그대로다(에이전트가 한국어 안내를 그대로 읽는다).
 * Windows PowerShell·cmd(MSYSTEM 없음)는 콘솔 코드 페이지(949)로 출력을 읽어 한글이 깨지므로 ASCII로 적는다.
 * DANDI_JSON_ASCII=1이면 어디서나 ASCII로 적는다.
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 */
export function jsonAsciiWanted(env = process.env, platform = process.platform) {
  if (env.DANDI_JSON_ASCII?.trim() === "1") return true;
  return platform === "win32" && !(typeof env.MSYSTEM === "string" && env.MSYSTEM.trim() !== "");
}

/**
 * --json 출력 문자열(jsonAsciiWanted에 따라 UTF-8 그대로 또는 \uXXXX).
 * @param {unknown} value
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 */
export function formatJsonOutput(value, env = process.env, platform = process.platform) {
  return jsonAsciiWanted(env, platform) ? asciiJson(value) : JSON.stringify(value);
}

/**
 * --json 성공 출력.
 * @param {Record<string, unknown>} fields
 */
export function okJson(fields) {
  return { ok: true, ...fields };
}

/**
 * --json 실패 출력: { ok: false, error: { code, message, hint? }, next_step?, next_step_template?, ...extra }
 * @param {{ code: string, message: string, hint?: string, nextStep?: string | null, nextStepTemplate?: string, extra?: Record<string, unknown> }} e
 */
export function errorJson(e) {
  return {
    ok: false,
    error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) },
    ...(e.nextStep ? { next_step: e.nextStep } : {}),
    ...(e.nextStepTemplate ? { next_step_template: e.nextStepTemplate } : {}),
    ...(e.extra ?? {}),
  };
}

/**
 * 사람용 오류 출력 줄. 다음에 실행할 명령이 있으면 "다음 실행:" 한 줄을 붙인다.
 * @param {{ message: string, hint?: string, nextStep?: string | null, nextStepTemplate?: string }} e
 * @returns {string[]}
 */
export function humanErrorLines(e) {
  const lines = [`오류: ${e.message}`];
  if (e.hint) lines.push(`도움말: ${e.hint}`);
  if (e.nextStep) lines.push(`다음 실행: ${e.nextStep}`);
  else if (e.nextStepTemplate) {
    lines.push(
      e.nextStepTemplate.includes("<폴더>")
        ? `다음 실행(<폴더>를 실제 폴더로 바꾸어): ${e.nextStepTemplate}`
        : `확인한 뒤 실행할 명령: ${e.nextStepTemplate}`,
    );
  }
  return lines;
}

/**
 * login --json(대기 시작)과 login --wait의 대기 출력(계약 3-2의 예시 + done:false).
 * ok:true지만 아직 끝나지 않았다는 뜻으로 done:false를 붙인다(종료 코드 5).
 * @param {{ user_code: string, verification_uri: string, verification_uri_complete: string, expires_in: number }} start
 * @param {string} prefix
 */
export function loginPendingJson(start, prefix) {
  return {
    ok: true,
    status: "pending",
    done: false,
    user_code: start.user_code,
    verification_uri: start.verification_uri,
    verification_uri_complete: start.verification_uri_complete,
    expires_in: start.expires_in,
    next_step: nextStep(prefix, "login --wait --json"),
    agent_instructions: AGENT_INSTRUCTIONS_LOGIN,
  };
}

/** @param {number} status */
export function codeForStatus(status) {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status === 422) return "invalid";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "request_failed";
}

/**
 * 허브 API 오류 응답을 사람이 읽을 문장으로 바꾼다(구 형식 { error: "문장" } 포함).
 * @param {number} status
 * @param {unknown} data
 * @returns {string}
 */
export function apiErrorMessage(status, data) {
  if (isRecord(data) && typeof data.error === "string" && data.error) return data.error;
  if (isRecord(data) && isRecord(data.error) && typeof data.error.message === "string") return data.error.message;
  if (status === 401) return "토큰이 유효하지 않습니다. login을 다시 실행하십시오.";
  if (status === 403) return "이 토큰으로는 사용할 수 없는 기능입니다.";
  if (status === 404) return "허브에서 CLI API를 찾을 수 없습니다. --hub 주소를 확인하십시오.";
  if (status >= 500) return `허브 서버 오류입니다(상태 코드 ${status}). 잠시 뒤 다시 시도하십시오.`;
  return `허브가 요청을 처리하지 못했습니다(상태 코드 ${status}).`;
}

/** @type {Record<string, string>} */
const RFC_MESSAGES = {
  authorization_pending: "교사의 브라우저 승인을 기다리는 중입니다.",
  slow_down: "확인 요청이 너무 잦습니다.",
  access_denied: "브라우저에서 연결을 거부했습니다.",
  expired_token: "승인 코드가 만료되었습니다.",
  invalid_grant: "승인 코드를 찾을 수 없거나 이미 사용했습니다.",
  invalid_request: "요청 형식이 올바르지 않습니다.",
};

/**
 * 세 가지 오류 형식을 하나로 맞춘다.
 * - 새 API: { error: { code, message, hint? } }
 * - RFC 8628/6749: { error: "authorization_pending", error_description? }
 * - v0.1 CLI API: { error: "한국어 문장" }
 * @param {number} status
 * @param {unknown} data
 * @returns {{ code: string, message: string, hint?: string }}
 */
export function normalizeApiError(status, data) {
  if (isRecord(data) && isRecord(data.error)) {
    const e = data.error;
    const code = typeof e.code === "string" && e.code ? e.code : codeForStatus(status);
    const message = typeof e.message === "string" && e.message ? e.message : apiErrorMessage(status, null);
    return { code, message, ...(typeof e.hint === "string" && e.hint ? { hint: e.hint } : {}) };
  }
  if (isRecord(data) && typeof data.error === "string" && /^[a-z][a-z0-9_]*$/.test(data.error)) {
    const desc = typeof data.error_description === "string" && data.error_description ? data.error_description : null;
    return { code: data.error, message: desc ?? RFC_MESSAGES[data.error] ?? data.error };
  }
  if (isRecord(data) && typeof data.error === "string" && data.error) {
    return { code: codeForStatus(status), message: data.error };
  }
  return { code: codeForStatus(status), message: apiErrorMessage(status, data) };
}

const DEPLOY_PHASES = new Set(["deploy", "skill_publish"]);

/**
 * 오류 코드와 단계로 종료 코드를 정한다.
 * @param {string} code
 * @param {"login" | "deploy" | "publish" | "skill_publish" | "other"} [phase]
 * @returns {number}
 */
export function exitCodeFor(code, phase = "other") {
  switch (code) {
    case "usage":
    case "invalid_argument":
    case "folder_not_found":
    case "missing_index":
    case "manifest_missing":
    case "manifest_parse_error":
    case "manifest_encoding":
    case "manifest_in_parent":
    case "nothing_to_publish":
      return EXIT.USAGE;
    case "login_required":
    case "not_logged_in":
    case "no_pending_login":
    case "unauthorized":
    case "invalid_token":
    case "forbidden":
      return EXIT.LOGIN_REQUIRED;
    case "authorization_pending":
    case "slow_down":
      return EXIT.PENDING;
    case "access_denied":
      return EXIT.DENIED;
    case "expired_token":
    case "invalid_grant":
      return EXIT.EXPIRED;
    case "invalid_publish":
    case "invalid_skill":
      return EXIT.PUBLISH_INVALID;
    case "site_not_found":
    case "source_folder":
      return EXIT.UPLOAD_REJECTED;
    case "network_error":
    case "server_error":
    case "bad_response":
    case "config_save_failed":
      return EXIT.ERROR;
    default:
      return DEPLOY_PHASES.has(phase) ? EXIT.UPLOAD_REJECTED : EXIT.ERROR;
  }
}

/* ---------- 계정 표시 ---------- */

/** @param {string | null | undefined} id */
export function levelLabel(id) {
  return SCHOOL_LEVELS.find((l) => l.id === id)?.label ?? "미지정";
}

/** @param {string | null | undefined} role */
export function roleLabel(role) {
  if (role === "admin") return "교육청 관리자";
  if (role === "teacher") return "교사";
  return "방문자";
}

/**
 * whoami 응답을 한 줄로 만든다.
 * @param {{ name?: unknown, role?: unknown, schoolLevel?: unknown }} user
 * @returns {string}
 */
export function describeUser(user) {
  const role = typeof user.role === "string" ? user.role : null;
  const level = typeof user.schoolLevel === "string" ? user.schoolLevel : null;
  const parts = [roleLabel(role)];
  if (level) parts.push(levelLabel(level));
  return `${typeof user.name === "string" && user.name ? user.name : "이름 없음"} (${parts.join(" · ")})`;
}

/* ---------- 셀프점검 5문항 ---------- */

/**
 * 셀프점검 5문항(F-16). 에이전트가 교사에게 그대로 묻는 문장.
 * mark·question·answer는 src/lib/runbook.ts의 PRIVACY_QUESTIONS와 글자 하나까지 같아야 한다(테스트가 확인).
 */
export const PRIVACY_QUESTIONS = [
  {
    key: "collectsStudentData",
    mark: "①",
    question: "학생 개인정보(이름, 학번, 연락처, 상담 기록 등)를 수집하거나 처리합니까?",
    answer: "예/아니요",
    type: "boolean",
  },
  {
    key: "storageLocation",
    mark: "②",
    question: "데이터 저장 위치",
    answer: "예: 저장 안 함(브라우저 안에서만 처리), Supabase(서울 리전)",
    type: "text",
  },
  {
    key: "retention",
    mark: "③",
    question: "보관 기간",
    answer: "예: 저장 안 함, 학기 종료 시 삭제",
    type: "text",
  },
  {
    key: "externalTransfer",
    mark: "④",
    question: "입력 내용을 외부 서비스(해외 AI API 등)로 보냅니까?",
    answer: "예/아니요",
    type: "boolean",
  },
  {
    key: "needsSchoolApproval",
    mark: "⑤",
    question: "학교 내부 승인(운영위원회 등)이 필요합니까?",
    answer: '예/아니요, ①이 "예"면 반드시 "예"',
    type: "boolean",
  },
];

/** 승인 대기를 정하는 규칙(⑤가 정한다). 모든 안내문에 같은 문장을 쓴다. */
export const APPROVAL_RULE = '⑤가 "예"이면 승인 대기(①이 "예"면 ⑤도 반드시 "예")';

/** @param {string} key */
function questionLine(key) {
  const q = PRIVACY_QUESTIONS.find((x) => x.key === key);
  return q ? `${q.mark} ${q.question} (${q.answer})` : key;
}

export function privacyQuestionsText() {
  return [
    "아래 문항을 교사에게 한 번에 그대로 물으십시오. 코드를 보고 답을 제안할 수는 있지만, 모든 항목은 교사가 직접 확인해야 합니다.",
    "제목 / 한 줄 설명 / 학교급(초·중·고·특수 → elem·middle·high·special) / 분류(수업·업무·학생지도·기타 → class·work·guidance·etc)",
    ...PRIVACY_QUESTIONS.map((q) => `${q.mark} ${q.question} (${q.answer})`),
    "답은 privacyCheck { collectsStudentData ①, storageLocation ②, retention ③, externalTransfer ④, needsSchoolApproval ⑤ }에 적습니다(①④⑤는 true/false).",
    `${APPROVAL_RULE} 상태로 등록되어, 학교 내부 승인 완료를 표시하기 전까지 허브 목록에 보이지 않습니다.`,
  ].join("\n");
}

/* ---------- dandi.json ---------- */

/**
 * index.html 내용에서 <title>을 꺼낸다(80자 이하로 자름). 없으면 null.
 * @param {string} html
 * @returns {string | null}
 */
export function titleFromHtml(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!m) return null;
  const text = m[1]
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " })[/** @type {"amp"} */ (e)] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, TITLE_MAX) : null;
}

/**
 * dandi init·deploy가 만드는 dandi.json 기본값.
 * 제목은 index.html의 <title>(없으면 빈칸)을 제안값으로 넣고, 설명·학교급·분류·셀프점검 5항목은 비워 둔다.
 * 교사가 직접 확인해 채우기 전에는 publish가 통과하지 않는다.
 * @param {string} title
 */
export function defaultManifest(title) {
  /** @type {Record<string, string>} */
  const privacyHelp = {};
  for (const q of PRIVACY_QUESTIONS) {
    const format = q.type === "boolean" ? '예 → true, 아니요 → false(따옴표 없이)' : "교사가 답한 문장";
    privacyHelp[`privacyCheck.${q.key}`] = `${questionLine(q.key)} → ${format}`;
  }
  return {
    _help: {
      about: "dandi가 허브에 사이트를 올리고 등록할 때 읽는 정보입니다. _help 항목은 설명용이며 허브로 보내지 않습니다.",
      title: "허브에 표시할 앱 이름입니다(80자 이하). index.html의 <title>을 제안값으로 넣어 두었으니 교사에게 확인하십시오.",
      description: "앱이 하는 일을 한두 문장으로 적습니다. 학생 이름·연락처 같은 개인정보는 적지 마십시오.",
      url: "다른 곳(Vercel 등)에 이미 배포한 앱 주소입니다. 허브 호스팅(deploy)을 쓰면 비워 둡니다.",
      outputDir: "올릴 폴더(index.html이 있는 곳)입니다. 이 파일 기준 상대 경로이며 deploy가 기록합니다. 비워 두면 dist, build, out, 이 폴더 순으로 찾습니다.",
      siteId: "deploy가 기록하는 허브 사이트 ID입니다. 같은 사이트를 다시 올릴 때 사용합니다.",
      lastDeployId: "deploy가 기록하는 마지막 배포 ID입니다. publish가 이 배포를 공개합니다.",
      projectId:
        "사이트를 처음 만들 때 연결할 허브 프로젝트 ID입니다(비워 두면 기본 프로젝트). 이미 올린 사이트는 허브에 연결된 프로젝트를 따르고, deploy가 그 값을 여기에 기록합니다. 다른 프로젝트로 옮기려면 deploy --project <id>를 쓰거나 허브에서 옮기십시오.",
      previousSiteId: "deploy --new-site가 기록하는 이전 사이트 ID입니다. 예전 사이트로 되돌릴 때 참고합니다.",
      schoolLevels: "대상 학교급입니다. elem(초), middle(중), high(고), special(특수) 중 하나 이상을 교사에게 확인해 적습니다.",
      category: "분류입니다. class(수업), work(업무), guidance(학생지도), etc(기타) 중 하나를 교사에게 확인해 적습니다.",
      privacyCheck: `배포 전 개인정보 셀프점검 5항목입니다. 교사가 직접 답한 내용만 적으십시오. 비어 있으면 등록되지 않습니다. ${APPROVAL_RULE}.`,
      ...privacyHelp,
    },
    title,
    description: "",
    url: "",
    outputDir: "",
    siteId: "",
    lastDeployId: "",
    projectId: "",
    schoolLevels: [],
    category: "",
    privacyCheck: {
      collectsStudentData: null,
      storageLocation: "",
      retention: "",
      externalTransfer: null,
      needsSchoolApproval: null,
    },
  };
}

/**
 * dandi init이 만드는 llms.txt 뼈대. AI 코딩 도구에 프로젝트 맥락을 알려 준다.
 * @param {string} title
 */
export function llmsTxtSkeleton(title) {
  return `# ${title || "새 미니앱"}

> 이 미니앱이 무엇을 하는지 한 문장으로 적으십시오.

이 파일은 AI 코딩 도구에 프로젝트의 목적과 규칙을 알려 주는 명세입니다.
작업을 시작할 때 AI에게 "llms.txt를 먼저 읽고 따르십시오"라고 요청하십시오.

## 대상
- 학교급: (초·중·고·특수 중에서)
- 사용자: 교사, 학생
- 사용 장면: (예: 수업 도입 5분 퀴즈)

## 기능
- (기능 1)
- (기능 2)

## 화면
- (첫 화면에 보여 줄 내용)

## 개인정보 원칙
- 학생 이름, 학번, 연락처, 주민등록번호 등 개인정보를 입력받거나 저장하지 않습니다.
- 입력 내용을 외부 서비스로 보내지 않습니다.
- 꼭 필요하면 그 이유와 저장 위치·보관 기간을 dandi.json의 privacyCheck에 적습니다.

## 기술 조건
- 정적 사이트(HTML, CSS, JavaScript)로 만들고 별도 서버 없이 동작하게 합니다.
- 루트에 index.html이 있어야 합니다. 빌드 도구를 쓰면 빌드한 결과 폴더(dist 등)를 올립니다.
- 모바일 브라우저에서도 사용할 수 있게 합니다.
- API 키·토큰을 HTML이나 JavaScript에 넣지 않습니다. 넣으면 허브가 업로드를 거부합니다.

## 배포와 등록
- deploy: 허브에 비공개 미리보기로 올립니다(링크를 아는 사람만 봄).
- dandi.json의 제목·설명·학교급·분류와 셀프점검 5항목을 교사가 직접 확인해 채운 뒤 publish로 허브에 등록합니다.
- 이미 다른 곳에 배포했다면 publish --url <배포 URL>로 등록합니다.
`;
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
export function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** @param {string} url */
function isAllowedUrl(url) {
  if (url.startsWith("/examples/")) return true;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * @typedef {object} AppPayload
 * @property {string} title
 * @property {string} description
 * @property {string} url
 * @property {string[]} schoolLevels
 * @property {string} category
 * @property {{ collectsStudentData: boolean, storageLocation: string, retention: string, externalTransfer: boolean, needsSchoolApproval: boolean }} privacyCheck
 */

const TITLE_MAX = 80;
const DESCRIPTION_MAX = 2000;
const PRIVACY_TEXT_MAX = 200;

/** @type {Record<string, string>} */
const LEVEL_ALIASES = {
  초: "elem", 초등: "elem", 초등학교: "elem",
  중: "middle", 중등: "middle", 중학교: "middle",
  고: "high", 고등: "high", 고등학교: "high",
  특수: "special", 특수학교: "special",
};
/** @type {Record<string, string>} */
const CATEGORY_ALIASES = { 수업: "class", 업무: "work", 학생지도: "guidance", 생활지도: "guidance", 기타: "etc" };

const LEVEL_ALLOWED = "elem|middle|high|special (초/중/고/특수도 받음)";
const CATEGORY_ALLOWED = "class|work|guidance|etc (수업/업무/학생지도/기타도 받음)";

/**
 * 학교급 값(영문 id 또는 한국어 이름)을 id로 바꾼다. 모르면 null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeSchoolLevel(value) {
  if (typeof value !== "string") return null;
  const s = value.replace(/\s+/g, "");
  const lower = s.toLowerCase();
  if (SCHOOL_LEVELS.some((l) => l.id === lower)) return lower;
  return LEVEL_ALIASES[s] ?? null;
}

/**
 * 분류 값(영문 id 또는 한국어 이름)을 id로 바꾼다. 모르면 null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeCategory(value) {
  if (typeof value !== "string") return null;
  const s = value.replace(/\s+/g, "");
  const lower = s.toLowerCase();
  if (APP_CATEGORIES.some((c) => c.id === lower)) return lower;
  return CATEGORY_ALIASES[s] ?? null;
}

/** @param {unknown} v */
const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

/**
 * @typedef {{ ok: true, value: AppPayload } | { ok: false, errors: string[], fields: string[], missing: string[], invalid: { field: string, problem: string }[], conflicts: { field: string, problem: string }[], garbled: string[] }} ManifestCheck
 */

/** UTF-8로 읽지 못한 바이트 자리에 들어가는 대체 문자(U+FFFD) */
export const REPLACEMENT_CHAR = "�";

/** PowerShell에서 dandi.json을 UTF-8로 저장하는 방법(오류 안내에 넣는다) */
export const POWERSHELL_UTF8_HINT =
  "PowerShell에서는 Set-Content -Encoding UTF8 dandi.json 또는 [IO.File]::WriteAllText(\"$PWD\\dandi.json\", $json)처럼 UTF-8로 저장하십시오(Set-Content의 기본값·Out-File·> 는 UTF-8이 아닙니다)";

const GARBLED_PROBLEM = `깨진 글자(${REPLACEMENT_CHAR})가 있습니다. dandi.json을 UTF-8이 아닌 인코딩으로 저장했거나 깨진 출력을 옮겨 적은 것입니다. 교사가 답한 원래 문장을 UTF-8로 다시 적으십시오(원래 문장을 모르면 교사에게 다시 물으십시오). ${POWERSHELL_UTF8_HINT}.`;

/**
 * dandi.json 같은 JSON 파일의 바이트를 글자로 바꾼다.
 * UTF-8(BOM 있어도 됨), UTF-16LE/BE(BOM 있음, 또는 ASCII 첫 글자로 알아봄)를 읽는다.
 * UTF-8로 읽었는데 올바르지 않은 바이트(ANSI·CP949로 저장한 파일)나 깨진 글자(U+FFFD)가 있으면 problem을 알려 준다.
 * @param {Uint8Array} bytes
 * @returns {{ text: string, encoding: "utf8" | "utf16le" | "utf16be", problem: null | "invalid_utf8" | "replacement_char" }}
 */
export function decodeJsonBytes(bytes) {
  const b = bytes;
  /** @param {Uint8Array} body */
  const utf16be = (body) => {
    const swapped = new Uint8Array(body.length - (body.length % 2));
    for (let i = 0; i + 1 < body.length; i += 2) {
      swapped[i] = body[i + 1];
      swapped[i + 1] = body[i];
    }
    return new TextDecoder("utf-16le").decode(swapped);
  };
  /** @param {string} text @param {"utf8" | "utf16le" | "utf16be"} encoding */
  const done = (text, encoding) => ({
    text,
    encoding,
    problem: /** @type {null | "replacement_char"} */ (text.includes(REPLACEMENT_CHAR) ? "replacement_char" : null),
  });
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return done(new TextDecoder("utf-16le").decode(b.subarray(2)), "utf16le");
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return done(utf16be(b.subarray(2)), "utf16be");
  // BOM 없는 UTF-16: JSON은 ASCII({, 공백)로 시작하므로 둘째(첫째) 바이트가 0이다.
  if (b.length >= 4 && b[0] !== 0 && b[1] === 0 && b[3] === 0) return done(new TextDecoder("utf-16le").decode(b), "utf16le");
  if (b.length >= 4 && b[0] === 0 && b[1] !== 0 && b[2] === 0) return done(utf16be(b), "utf16be");
  const body = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b;
  try {
    return done(new TextDecoder("utf-8", { fatal: true }).decode(body), "utf8");
  } catch {
    return { text: new TextDecoder("utf-8").decode(body), encoding: "utf8", problem: "invalid_utf8" };
  }
}

/**
 * dandi.json을 검사하고 허브로 보낼 본문을 만든다. 허브도 같은 규칙으로 다시 검사한다.
 * 실패하면 빠진 항목(missing: 교사에게 물어야 함), 형식만 틀린 항목(invalid: 에이전트가 고침),
 * 서로 맞지 않는 답(conflicts: 교사에게 다시 확인)을 나누어 돌려준다. errors는 사람용 문장, fields는 전체 항목 이름.
 * 학교급·분류는 한국어 이름(초/중/고/특수, 수업/업무/학생지도/기타)도 받아 id로 바꾼다.
 * @param {unknown} manifest
 * @param {{ requireUrl?: boolean }} [options]
 * @returns {ManifestCheck}
 */
export function validateManifest(manifest, { requireUrl = true } = {}) {
  if (!isRecord(manifest)) {
    const problem = `${MANIFEST_FILE}은 JSON 객체여야 합니다.`;
    return { ok: false, errors: [problem], fields: ["(file)"], missing: [], invalid: [{ field: "(file)", problem }], conflicts: [], garbled: [] };
  }
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const missing = [];
  /** @type {{ field: string, problem: string }[]} */
  const invalid = [];
  /** @type {{ field: string, problem: string }[]} */
  const conflicts = [];
  /** @param {string} field @param {string} message */
  const need = (field, message) => {
    missing.push(field);
    errors.push(`${field}: ${message}`);
  };
  /** @param {string} field @param {string} message */
  const bad = (field, message) => {
    invalid.push({ field, problem: message });
    errors.push(`${field}: ${message}`);
  };
  const { title, url, schoolLevels, category, privacyCheck, description } = manifest;
  /** @type {Set<string>} */
  const garbledFields = new Set();
  /** 깨진 글자(U+FFFD)가 든 값. 파일을 UTF-8이 아닌 인코딩으로 저장했거나 깨진 출력을 옮겨 적은 것이다. @param {string} field @param {unknown} v */
  const garbled = (field, v) => {
    if (typeof v !== "string" || !v.includes(REPLACEMENT_CHAR)) return false;
    garbledFields.add(field);
    bad(field, GARBLED_PROBLEM);
    return true;
  };

  if (isBlank(title)) need("title", "앱 이름이 비었습니다. 교사에게 확인해 적으십시오.");
  else if (typeof title !== "string") bad("title", "문자열이어야 합니다.");
  else if (!garbled("title", title) && title.trim().length > TITLE_MAX) bad("title", `앱 이름은 ${TITLE_MAX}자 이하로 줄이십시오.`);

  if (isBlank(description)) need("description", "한 줄 설명이 비었습니다. 교사에게 확인해 적으십시오.");
  else if (typeof description !== "string") bad("description", "문자열이어야 합니다.");
  else if (!garbled("description", description) && description.length > DESCRIPTION_MAX) {
    bad("description", `설명은 ${DESCRIPTION_MAX}자 이하로 줄이십시오.`);
  }

  const urlText = url ?? "";
  if (typeof urlText !== "string") bad("url", "문자열이어야 합니다.");
  else if (requireUrl && !urlText.trim()) {
    need("url", "배포 URL이 없습니다. dandi.json의 url을 채우거나 --url 옵션을 사용하십시오.");
  } else if (urlText.trim() && !isAllowedUrl(urlText.trim())) {
    bad("url", "배포 URL은 http:// 또는 https://로 시작해야 합니다.");
  }

  /** @type {string[]} */
  let levels = [];
  if (isBlank(schoolLevels)) {
    need("schoolLevels", `학교급을 교사에게 확인해 하나 이상 적으십시오. (허용: ${LEVEL_ALLOWED})`);
  } else {
    const list = typeof schoolLevels === "string" ? schoolLevels.split(/[,/·\s]+/).filter(Boolean) : schoolLevels;
    if (!Array.isArray(list)) bad("schoolLevels", `배열로 적으십시오. 예: ["middle"] (허용: ${LEVEL_ALLOWED})`);
    else {
      const mapped = list.map((l) => ({ raw: l, id: normalizeSchoolLevel(l) }));
      const unknown = mapped.filter((m) => !m.id);
      if (unknown.length) {
        bad("schoolLevels", `알 수 없는 학교급입니다: ${unknown.map((m) => String(m.raw)).join(", ")} (허용: ${LEVEL_ALLOWED})`);
      } else {
        levels = [...new Set(mapped.map((m) => /** @type {string} */ (m.id)))];
      }
    }
  }

  let categoryId = "";
  if (isBlank(category)) need("category", `분류를 교사에게 확인해 적으십시오. (허용: ${CATEGORY_ALLOWED})`);
  else {
    const id = normalizeCategory(category);
    if (!id) bad("category", `알 수 없는 분류입니다: ${String(category)} (허용: ${CATEGORY_ALLOWED})`);
    else categoryId = id;
  }

  if (isBlank(privacyCheck)) {
    need("privacyCheck", "배포 전 개인정보 셀프점검 5항목이 필요합니다. 교사에게 5문항을 물어 답을 적으십시오.");
  } else if (!isRecord(privacyCheck)) {
    bad("privacyCheck", "{ collectsStudentData, storageLocation, retention, externalTransfer, needsSchoolApproval } 객체여야 합니다.");
  } else {
    for (const q of PRIVACY_QUESTIONS) {
      const field = `privacyCheck.${q.key}`;
      const v = privacyCheck[q.key];
      if (isBlank(v)) {
        need(field, `${q.mark} 교사에게 묻고 ${q.type === "boolean" ? "true 또는 false로" : "답한 문장을"} 적으십시오. (${q.question})`);
      } else if (garbled(field, v)) {
        continue;
      } else if (q.type === "boolean" && typeof v !== "boolean") {
        bad(field, `${q.mark} 따옴표 없는 true 또는 false로 적으십시오(지금 값: ${JSON.stringify(v)}). 교사가 이미 답했다면 다시 묻지 말고 형식만 고치십시오.`);
      } else if (q.type === "text" && typeof v !== "string") {
        bad(field, `${q.mark} 문자열로 적으십시오.`);
      } else if (q.type === "text" && String(v).length > PRIVACY_TEXT_MAX) {
        bad(field, `${q.mark} ${PRIVACY_TEXT_MAX}자 이하로 줄이십시오.`);
      }
    }
    if (privacyCheck.collectsStudentData === true && privacyCheck.needsSchoolApproval === false) {
      const problem = '①이 "예"이면 ⑤도 "예"여야 합니다. 교사에게 ⑤를 다시 물으십시오. 답을 대신 바꾸지 마십시오.';
      conflicts.push({ field: "privacyCheck.needsSchoolApproval", problem });
      errors.push(`privacyCheck.needsSchoolApproval: ${problem}`);
    }
  }

  if (errors.length) {
    const fields = [...new Set([...missing, ...invalid.map((i) => i.field), ...conflicts.map((c) => c.field)])];
    return { ok: false, errors, fields, missing: [...new Set(missing)], invalid, conflicts, garbled: [...garbledFields] };
  }

  const pc = /** @type {Record<string, unknown>} */ (privacyCheck);
  return {
    ok: true,
    value: {
      title: String(title).trim(),
      description: String(description).trim(),
      url: String(urlText).trim(),
      schoolLevels: levels,
      category: categoryId,
      privacyCheck: {
        collectsStudentData: pc.collectsStudentData === true,
        storageLocation: String(pc.storageLocation).trim(),
        retention: String(pc.retention).trim(),
        externalTransfer: pc.externalTransfer === true,
        needsSchoolApproval: pc.needsSchoolApproval === true,
      },
    },
  };
}

/**
 * 교사에게 보여 줄 저장된 답(다시 올릴 때 확인용). 셀프점검 문항은 원문과 함께.
 * @param {AppPayload} payload
 */
export function savedAnswers(payload) {
  /** @param {boolean} b */
  const yn = (b) => (b ? "예" : "아니요");
  const pc = payload.privacyCheck;
  return {
    title: payload.title,
    description: payload.description,
    schoolLevels: payload.schoolLevels.map((id) => `${id}(${levelLabel(id)})`),
    category: `${payload.category}(${APP_CATEGORIES.find((c) => c.id === payload.category)?.label ?? ""})`,
    privacy: [
      `${questionLine("collectsStudentData")}: ${yn(pc.collectsStudentData)}`,
      `${questionLine("storageLocation")}: ${pc.storageLocation}`,
      `${questionLine("retention")}: ${pc.retention}`,
      `${questionLine("externalTransfer")}: ${yn(pc.externalTransfer)}`,
      `${questionLine("needsSchoolApproval")}: ${yn(pc.needsSchoolApproval)}`,
    ],
  };
}

/**
 * --url, --title 옵션으로 dandi.json 값을 덮어쓴다(파일은 바꾸지 않는다).
 * @param {unknown} manifest
 * @param {{ url?: string, title?: string }} overrides
 * @returns {unknown}
 */
export function applyOverrides(manifest, overrides) {
  if (!isRecord(manifest)) return manifest;
  const out = { ...manifest };
  if (overrides.url !== undefined) out.url = overrides.url;
  if (overrides.title !== undefined) out.title = overrides.title;
  return out;
}

/**
 * dandi.json의 문자열 칸(빈 문자열은 없음으로 본다).
 * @param {unknown} manifest
 * @param {string} key
 * @returns {string | undefined}
 */
export function manifestString(manifest, key) {
  if (!isRecord(manifest)) return undefined;
  const v = manifest[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * vercel deploy 출력에서 마지막 https 주소를 꺼낸다(deploy --vercel).
 * @param {string} output
 * @returns {string | null}
 */
export function extractLastHttpsUrl(output) {
  const matches = output.match(/https:\/\/[^\s"'<>`]+/g);
  if (!matches) return null;
  return matches[matches.length - 1].replace(/[)\].,;:]+$/, "");
}

/* ---------- 사이트 파일 ---------- */

/**
 * 폴더를 올릴 때 빼는 항목인가. relPath는 슬래시로 구분한 상대 경로(파일 또는 폴더).
 * node_modules/, .git/, .env*, 점으로 시작하는 모든 파일·폴더, dandi.json을 뺀다.
 * @param {string} relPath
 */
export function isExcludedPath(relPath) {
  const segments = relPath.split("/").filter(Boolean);
  if (segments.some((s) => s === "node_modules" || s.startsWith("."))) return true;
  return segments[segments.length - 1] === MANIFEST_FILE;
}

/**
 * 소스 폴더(맨 위에 package.json이 있음)에서 올리지 않는 빌드 설정 파일인가(맨 위 파일만).
 * @param {string} relPath
 */
export function isBuildConfigFile(relPath) {
  if (relPath.includes("/")) return false;
  return /^(?:package(?:-lock)?\.json|(?:vite|webpack|rollup|svelte|astro|next|nuxt|tailwind|postcss)\.config\.[cm]?[jt]s|tsconfig(?:\.[^/]+)?\.json|jsconfig\.json)$/i.test(relPath);
}

/** 빌드 결과로 흔히 쓰는 폴더 이름 */
export const BUILD_DIRS = ["dist", "build", "out"];

/**
 * HTML 태그의 속성(이름은 소문자). 값이 없는 속성은 "".
 * @param {string} attrText 태그 이름 뒤의 속성 부분
 * @returns {Record<string, string>}
 */
function htmlAttributes(attrText) {
  /** @type {Record<string, string>} */
  const out = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of attrText.matchAll(re)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

/**
 * 화면에 글자로만 보이는 부분(주석, <pre>, <code>, <textarea>, <xmp>, <template>)을 지운다.
 * 수업 자료의 코드 예시가 실제로 불러오는 모듈로 오인되지 않게 한다.
 * @param {string} html
 */
function stripInertHtml(html) {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<(pre|code|textarea|xmp|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
}

const SOURCE_EXT_RE = /\.(?:jsx|tsx|ts|mts|cts|vue|svelte)$/i;

/**
 * 모듈 주소가 브라우저가 바로 실행할 수 없는 빌드 전 소스인가.
 * - .jsx/.ts/.tsx/.vue/.svelte 파일(.d.ts 제외)
 * - 루트 절대 경로 /src/… (Vite 등 개발 서버 전용 주소. 빌드 결과는 /assets/…를 쓴다)
 * @param {string} spec
 * @param {boolean} isModule type=module 스크립트·modulepreload·import인가
 */
function isSourceModule(spec, isModule) {
  const clean = spec.trim().replace(/[?#].*$/, "");
  if (!clean || /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(clean) || /^(?:data|blob|javascript):/i.test(clean)) return false;
  if (SOURCE_EXT_RE.test(clean) && !/\.d\.[cm]?ts$/i.test(clean)) return true;
  return isModule && /^\/src\//.test(clean);
}

/** 스크립트 type 중 브라우저가 JavaScript로 실행하는 것(빈 값 포함). text/babel 등은 브라우저 안에서 따로 변환하므로 보지 않는다. */
const JS_SCRIPT_TYPES = new Set(["", "module", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"]);

/**
 * index.html이 실제로 불러오는 모듈 가운데 빌드 전 소스(.jsx, .ts, .tsx, .vue, .svelte, 루트 절대 경로 /src/의 모듈)를 찾는다.
 * <script src>, type=module 인라인 스크립트의 import, <link rel=modulepreload>만 본다.
 * 주석·<pre>·<code>·<textarea> 안의 코드 예시와 <a href>는 보지 않는다. 찾으면 그 주소, 없으면 null.
 * (Vite 등 빌드 전 소스 폴더를 올리면 빈 화면이 된다.)
 * @param {string} html
 * @returns {string | null}
 */
export function sourceModuleReference(html) {
  const doc = stripInertHtml(html);
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)(?:<\/script\s*>|$)/gi;
  for (const m of doc.matchAll(scriptRe)) {
    const attrs = htmlAttributes(m[1]);
    const type = (attrs.type ?? "").trim().toLowerCase();
    if (!JS_SCRIPT_TYPES.has(type)) continue;
    const isModule = type === "module";
    if (attrs.src !== undefined) {
      if (isSourceModule(attrs.src, isModule)) return attrs.src.trim().replace(/[?#].*$/, "");
      continue;
    }
    if (!isModule) continue;
    const importRe = /(?:\bimport\s*\(\s*|\bfrom\s*|\bimport\s+)(["'])([^"'\n]+)\1/g;
    for (const im of m[2].matchAll(importRe)) {
      if (isSourceModule(im[2], true)) return im[2].trim().replace(/[?#].*$/, "");
    }
  }
  for (const m of doc.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = htmlAttributes(m[1]);
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("modulepreload") && attrs.href && isSourceModule(attrs.href, true)) return attrs.href.trim().replace(/[?#].*$/, "");
  }
  return null;
}

/** 빌드가 필요한 프로젝트임을 알려 주는 의존성(dependencies·devDependencies) */
export const BUILD_TOOL_DEPS = [
  "vite",
  "react-scripts",
  "next",
  "parcel",
  "parcel-bundler",
  "webpack",
  "webpack-cli",
  "@vue/cli-service",
  "@angular/cli",
  "@sveltejs/kit",
  "astro",
  "nuxt",
  "gatsby",
];

/**
 * package.json 내용에서 빌드가 필요한 프로젝트인지 알아본다(scripts.build 또는 빌드 도구 의존성).
 * @param {unknown} pkg
 * @returns {{ buildScript: boolean, tools: string[] }}
 */
export function packageBuildSignals(pkg) {
  if (!isRecord(pkg)) return { buildScript: false, tools: [] };
  const buildScript = isRecord(pkg.scripts) && typeof pkg.scripts.build === "string" && pkg.scripts.build.trim() !== "";
  const deps = new Set([
    ...(isRecord(pkg.dependencies) ? Object.keys(pkg.dependencies) : []),
    ...(isRecord(pkg.devDependencies) ? Object.keys(pkg.devDependencies) : []),
  ]);
  return { buildScript, tools: BUILD_TOOL_DEPS.filter((d) => deps.has(d)) };
}

/** @param {string} relPath */
export function extOf(relPath) {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * 사이트 경로 규칙(계약 2-2): 슬래시 구분 상대 경로, .. · 절대경로 · 역슬래시 · 제어문자 금지, 점으로 시작하는 세그먼트 금지.
 * @param {string} relPath
 * @returns {string | null} 문제가 있으면 이유
 */
export function sitePathProblem(relPath) {
  if (!relPath || relPath.length > 512) return "경로가 비었거나 너무 깁니다.";
  if (relPath.startsWith("/") || /^[A-Za-z]:/.test(relPath)) return "절대 경로는 쓸 수 없습니다.";
  if (relPath.includes("\\")) return "역슬래시(\\) 대신 슬래시(/)를 쓰십시오.";
  if (/[\u0000-\u001f\u007f]/.test(relPath)) return "경로에 제어 문자가 있습니다.";
  const segments = relPath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return "빈 경로 조각이나 . · .. 는 쓸 수 없습니다.";
  if (segments.some((s) => s.startsWith("."))) return "점(.)으로 시작하는 파일·폴더는 올릴 수 없습니다.";
  return null;
}

/**
 * 허용되지 않는 확장자는 올리지 않고 건너뛴다(허브가 어차피 거부한다).
 * @template {{ path: string }} T
 * @param {T[]} files
 * @returns {{ keep: T[], skipped: { path: string, reason: string }[] }}
 */
export function splitAllowedFiles(files) {
  /** @type {T[]} */
  const keep = [];
  /** @type {{ path: string, reason: string }[]} */
  const skipped = [];
  for (const f of files) {
    const ext = extOf(f.path);
    if (SITE_ALLOWED_EXT.includes(ext)) keep.push(f);
    else skipped.push({ path: f.path, reason: ext ? `허용되지 않는 확장자(.${ext})` : "확장자 없음" });
  }
  return { keep, skipped };
}

/**
 * 한도·루트 index.html 검사. 문제 문장 목록(없으면 빈 배열).
 * @param {{ path: string, size: number }[]} files
 * @param {{ totalBytes: number, fileCount: number, fileBytes: number }} [limits]
 * @returns {string[]}
 */
export function siteLimitProblems(files, limits = SITE_LIMITS) {
  /** @type {string[]} */
  const problems = [];
  if (!files.some((f) => f.path === "index.html")) problems.push("폴더 맨 위에 index.html이 없습니다.");
  if (files.length > limits.fileCount) problems.push(`파일이 ${files.length}개입니다. ${limits.fileCount}개 이하여야 합니다.`);
  const big = files.filter((f) => f.size > limits.fileBytes);
  if (big.length) {
    problems.push(
      `파일당 ${formatBytes(limits.fileBytes)} 이하여야 합니다: ${big.slice(0, 5).map((f) => `${f.path}(${formatBytes(f.size)})`).join(", ")}`,
    );
  }
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > limits.totalBytes) problems.push(`합계 ${formatBytes(total)}입니다. ${formatBytes(limits.totalBytes)} 이하여야 합니다.`);
  return problems;
}

/**
 * 텍스트 파일에서 비밀값 패턴을 찾는다.
 * @param {{ path: string, bytes: Uint8Array }[]} files
 * @param {{ allText?: boolean }} [options] allText: 확장자와 관계없이 NUL 바이트가 없는 파일을 모두 검사(스킬 폴더용)
 * @returns {{ path: string, kind: string }[]}
 */
export function scanSecrets(files, { allText = false } = {}) {
  /** @type {{ path: string, kind: string }[]} */
  const found = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (const f of files) {
    const text = allText ? !f.bytes.includes(0) : TEXT_EXT.includes(extOf(f.path));
    if (!text) continue;
    const content = decoder.decode(f.bytes);
    const hit = SECRET_PATTERNS.find((p) => p.test(content));
    if (hit) found.push({ path: f.path, kind: hit.name });
  }
  return found;
}

/**
 * 비밀값이 나왔을 때의 안내. 허브 사이트 호스팅은 정적 파일만 제공하므로 키를 둘 곳이 없다.
 * 허브(src/app/studio/sites/secret-scan.ts siteSecretGuidance)·런북과 글자 하나까지 같은 문장을 쓴다.
 * @param {string} hub
 */
export function secretGuidance(hub) {
  const h = hub.replace(/\/+$/, "");
  return `Dandi 사이트 호스팅은 정적 파일만 제공하므로 키를 보관할 수 없습니다. AI 기능은 서버 프록시(${h}/downloads/ai-proxy-example.md)를 따로 배포해 publish --url로 등록하거나, AI 호출을 빼십시오. 키를 숨기거나 나눠서 검사를 피하지 마십시오.`;
}

/**
 * 허브가 준 secret_detected hint에 공통 안내를 붙인다. 이미 들어 있으면 다시 붙이지 않는다.
 * @param {string | undefined} hint
 * @param {string} hub
 */
export function withSecretGuidance(hint, hub) {
  const guidance = secretGuidance(hub);
  const base = (hint ?? "").trim();
  if (!base) return guidance;
  if (base.includes("정적 파일만 제공") || base.includes("ai-proxy-example")) return base;
  return `${base.replace(/[.。\s]+$/, "")}. ${guidance}`;
}

export const SECRET_AGENT_INSTRUCTIONS =
  "A key or token was found in the files listed in error.hint. Dandi site hosting serves static files only and cannot keep keys. Tell the teacher. Either remove the AI/API call from the site, or deploy a separate server proxy that keeps the key (see the ai-proxy-example link in error.hint) and register that app with publish --url. Never obfuscate, encode or split the key to get past this check.";

/** @param {Uint8Array} bytes */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 업로드 1단계에 보낼 파일 목록(계약 2-3): [{ path, size, sha256 }], 경로순.
 * @param {{ path: string, bytes: Uint8Array }[]} files
 * @returns {{ path: string, size: number, sha256: string }[]}
 */
export function buildFileManifest(files) {
  return files
    .map((f) => ({ path: f.path, size: f.bytes.byteLength, sha256: sha256Hex(f.bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * deploy 폴더를 정하지 않았을 때 찾아볼 폴더 목록(계약 3-2): outputDir → dist → build → out → 현재 폴더.
 * @param {string | undefined} outputDir
 * @returns {string[]}
 */
export function siteFolderCandidates(outputDir) {
  const list = [outputDir, "dist", "build", "out", "."].filter((d) => typeof d === "string" && d.trim() !== "");
  return [...new Set(/** @type {string[]} */ (list))];
}

/** @param {number} n */
export function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/* ---------- 스킬 ---------- */

/**
 * skill add·setup이 기본으로 설치할 AI 도구(vercel-labs/skills의 agent id, src/lib/runbook.ts SKILL_AGENTS와 같게).
 * 프로젝트 설치 위치: claude-code → .claude/skills, cursor·codex·antigravity-cli → .agents/skills, grok → .grok/skills.
 */
export const DEFAULT_SKILL_AGENTS = ["claude-code", "cursor", "codex", "antigravity-cli", "grok"];

/**
 * npx로 실행할 skills CLI. -a grok은 skills 1.7.0부터 받는데, npx는 예전에 받아 둔 사본(예: 1.5.18)을 그대로 쓰고
 * 그 버전은 grok을 모르는 도구로 보고 설치 전체를 실패시킨다. 그래서 @latest로 최신판을 받게 한다.
 */
export const SKILLS_PACKAGE = "skills@latest";

/** setup이 설치하는 배포 스킬(허브의 시드 스킬). */
export const DEPLOY_SKILL = "dandi-deploy";

/** setup 뒤에 AI 코딩 도구에 보낼 문장. 스킬 이름을 적어 두면 스킬을 스스로 고르지 않는 도구도 찾아 쓴다. */
export const SETUP_PROMPT = `${DEPLOY_SKILL} 스킬로 이 폴더의 사이트를 Dandi에 올려 주십시오.`;

/** 등록 정보·셀프점검 답의 틀(src/lib/runbook.ts ANSWERS_TEMPLATE과 같은 문장). 괄호를 채워 보내면 AI가 다시 묻지 않는다. */
export const ANSWERS_TEMPLATE =
  "제목: (제목) / 설명: (한 줄 설명) / 학교급: (초·중·고·특수) / 분류: (수업·업무·학생지도·기타) / ① (예·아니요) ② (저장 위치) ③ (보관 기간) ④ (예·아니요) ⑤ (예·아니요)";

/** @param {string} name */
export function isValidSkillName(name) {
  return typeof name === "string" && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/**
 * --agent claude-code,cursor 값을 목록으로 바꾼다. 형식이 틀리면 null.
 * @param {string | undefined} value
 * @returns {string[] | null}
 */
export function parseAgentList(value) {
  if (value === undefined) return [...DEFAULT_SKILL_AGENTS];
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0 || list.length > 10) return null;
  if (!list.every((a) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(a))) return null;
  return [...new Set(list)];
}

/**
 * skill add·setup이 실행할 npx 인자: npx -y skills@latest add <hub>/.well-known/agent-skills/<name> --skill <name> -a <agent>... --copy [-g] [-y]
 * 범위 지정 소스라 고른 스킬 하나만 내려받고, 허브의 설치 수도 그 스킬에만 더해진다.
 * @param {string} hub
 * @param {string} name
 * @param {string[]} agents
 * @param {{ global?: boolean, yes?: boolean }} [options]
 * @returns {string[]}
 */
export function skillAddArgs(hub, name, agents, { global = false, yes = false } = {}) {
  const args = ["-y", SKILLS_PACKAGE, "add", `${hub.replace(/\/+$/, "")}/.well-known/agent-skills/${name}`, "--skill", name];
  for (const a of agents) args.push("-a", a);
  args.push("--copy");
  if (global) args.push("-g");
  if (yes) args.push("-y");
  return args;
}

/**
 * 셸을 거쳐 실행해도 안전한 인자인가(Windows의 npx.cmd는 셸이 필요하다).
 * @param {string} arg
 */
export function isShellSafeArg(arg) {
  // cmd.exe가 해석하는 % ^ & | < > " 와 공백은 받지 않는다.
  return /^[A-Za-z0-9._:/=@+~-]+$/.test(arg);
}

/* ---------- 사이트 식별자 ---------- */

const RESERVED_SLUGS = new Set(["www", "api", "admin", "hub", "mcp", "static", "app", "apps", "mail", "cdn", "assets", "login", "oauth"]);

/**
 * 사이트 주소 이름(계약 2-1): 소문자·숫자·하이픈 3~30자, 양 끝은 영숫자, "--" 금지, 예약어 금지.
 * 최종 판단은 허브가 한다(예약어 목록이 더 길 수 있음).
 * @param {string} slug
 */
export function isValidSlug(slug) {
  return /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/.test(slug) && !slug.includes("--") && !RESERVED_SLUGS.has(slug);
}

/** @param {string} id */
export function isValidSiteId(id) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/* ---------- 런북·도움말 ---------- */

/**
 * 허브의 /llms.txt를 받지 못했을 때 guide가 보여 주는 내장 요약 런북.
 * @param {string} hub
 * @param {string} prefix
 */
export function builtinRunbook(hub, prefix) {
  return `# Dandi (내장 요약 런북 · dandi ${CLI_TAG})
> 허브 ${hub}/llms.txt 를 받지 못해 CLI에 들어 있는 요약을 보여 줍니다. 원문을 받으면 원문을 따르십시오.

You are an AI agent. A teacher asked you to publish their site to Dandi. Run the commands yourself.
Run commands in the foreground and stop only at ASK. Talk to the teacher in Korean, in plain words. Follow next_step and agent_instructions in each JSON result.
Shell: Git Bash·macOS·Linux: \`npx\` / Windows PowerShell·cmd: \`npx.cmd\` (next_step already fits the shell it ran in).
PowerShell: run \`[Console]::OutputEncoding=[Text.Encoding]::UTF8\` first and read --json output with ConvertFrom-Json.

## Steps
1. \`${prefix} whoami --json\` → exit 0: go to 3. exit 4: go to 2. If cli_update is present, use its prefix from now on.
2. \`${prefix} login --json\` (exit 5 = waiting for approval, "done": false)
   Show verification_uri_complete on its own line, then say:
   "링크를 열고, 화면의 코드가 <user_code>와 같으면 [승인]을 눌러 주십시오."
   WAIT: don't end your turn; run \`${prefix} login --wait --json\` now (waits ≤90 s). exit 5 → run it again. exit 0 → step 3.
   exit 6 (denied): ASK whether the teacher wants to log in; start again only if they say yes. exit 7 (expired): step 2 once more.
3. Deploy now (build first if package.json has a build script): \`${prefix} deploy --json\`
   picks outputDir, dist/, build/, out/ or this folder. A folder the teacher named: \`${prefix} deploy "<folder>" --json\`
4. Private preview: show previewUrl on its own line.
   warnings = possible personal data or skipped files; notes = information only.
   If skipped is not empty, name those files to the teacher and suggest the 자료실 (${hub}/files) or a PDF.
   If the result says the site is already published, show saved_answers and ASK the teacher to confirm or change them.
5. If the teacher's request already gives 제목, 설명, 학교급, 분류 and ①~⑤, use those answers and do not ask again.
   Otherwise ASK in ONE message:
${privacyQuestionsText()
  .split("\n")
  .map((l) => `   ${l}`)
  .join("\n")}
6. Write the answers into dandi.json as UTF-8 (PowerShell: Set-Content -Encoding UTF8), then
   \`${prefix} publish --json\`. exit 21: ASK about items in missing/conflicts; fix items in invalid_format yourself.
7. Report only verified state: say the message field, app URL on its own line, and the answers used. approvalStatus: approved|not_required|pending.
   liveVersion kept_until_approval: the old version stays live at liveUrl until approval.

## Never
- Never ask the teacher to paste a token, password, or API key into chat. Login happens only in the browser.
- Never print, commit, or upload ~/.dandi/, .env*, or keys. Never obfuscate or split keys. Never shorten or edit URLs you show.
- Never answer the privacy questions yourself or run publish without the teacher's answers (in the request or to your ASK).
- Never put real student data in samples, file names, titles, or descriptions.

## Exit codes
0 ok · 1 error (network_error: ask the teacher to start the hub or check its URL) · 2 usage · 4 login required · 5 waiting for approval · 6 denied · 7 expired · 20 upload rejected (follow agent_instructions; site_not_found: ASK the teacher about the account first) · 21 publish check failed

## No shell?
Connect the MCP server: \`claude mcp add dandi -- ${prefix} mcp\` or open ${hub}/connect
If MCP stops starting after a hub update, recopy the line from ${hub}/connect.
`;
}

/** help --json과 help 문장이 함께 쓰는 명령 목록 */
export const HELP_COMMANDS = [
  { name: "login", usage: "login [--json] [--force]", description: "브라우저 승인으로 로그인합니다. 이미 로그인되어 있으면 그대로 알려 줍니다(--force면 새로 로그인)." },
  { name: "login --wait", usage: "login --wait [--timeout 90] [--json]", description: "앞에서 시작한 로그인의 승인을 이어서 기다립니다." },
  { name: "login --token-stdin", usage: "login --token-stdin", description: "표준입력으로 받은 CLI 토큰으로 로그인합니다(CI용)." },
  { name: "logout", usage: "logout", description: "이 컴퓨터에 저장된 로그인 정보를 지웁니다." },
  { name: "whoami", usage: "whoami [--json]", description: "로그인한 계정을 확인합니다." },
  { name: "init", usage: "init [--dir <폴더>]", description: "dandi.json과 llms.txt 뼈대를 만듭니다(덮어쓰지 않음)." },
  {
    name: "deploy",
    usage: "deploy [폴더] [--site <id>] [--new-site] [--project <id>] [--slug <이름>] [--title <제목>] [--allow-source] [--json]",
    description: "폴더를 허브에 비공개 미리보기로 올립니다.",
  },
  { name: "deploy --vercel", usage: "deploy --vercel", description: "(이전 방식) Vercel에 배포한 뒤 그 주소로 허브에 등록합니다." },
  { name: "publish", usage: "publish [--url <주소>] [--json]", description: "dandi.json의 등록 정보·셀프점검을 확인하고 허브에 미니앱으로 등록합니다." },
  {
    name: "setup",
    usage: `setup [--agent ${DEFAULT_SKILL_AGENTS.join(",")}] [-g]`,
    description: `배포 스킬(${DEPLOY_SKILL})을 이 프로젝트의 AI 코딩 도구에 설치하고, AI에게 보낼 문장을 보여 줍니다.`,
  },
  { name: "skill add", usage: `skill add <이름> [--agent ${DEFAULT_SKILL_AGENTS.join(",")}] [-g]`, description: "허브의 스킬을 AI 코딩 도구에 설치합니다." },
  { name: "skill publish", usage: "skill publish [폴더] [--title <제목>] [--json]", description: "SKILL.md가 있는 폴더를 허브에 게시합니다." },
  { name: "skill list", usage: "skill list [검색어] [--json]", description: "허브의 공개 스킬을 찾습니다." },
  { name: "guide", usage: "guide [--json]", description: "허브의 실행 런북(/llms.txt) 원문을 출력합니다." },
  { name: "mcp", usage: "mcp", description: "stdio MCP 서버를 실행합니다." },
  { name: "help", usage: "help [--json]", description: "도움말을 보여 줍니다." },
];

export const EXIT_CODE_TEXT = {
  0: "성공",
  1: "기타 오류(network_error면 허브 실행·주소 확인)",
  2: "사용법 오류(folder_not_found, missing_index, nothing_to_publish, manifest_encoding, manifest_in_parent 포함)",
  4: "로그인 필요",
  5: "승인 대기",
  6: "거부됨",
  7: "만료",
  20: "업로드 거부(secret_detected, source_folder, site_not_found 등)",
  21: "publish 검증 실패",
};

/**
 * help --json 출력.
 * @param {string} prefix
 * @param {string} hub
 */
export function helpJson(prefix, hub) {
  return okJson({
    name: CLI_NAME,
    version: CLI_VERSION,
    tag: CLI_TAG,
    hub,
    prefix,
    commands: HELP_COMMANDS.map((c) => ({ ...c, command: nextStep(prefix, c.usage) })),
    exit_codes: EXIT_CODE_TEXT,
    common_flags: ["--hub <주소>", "--json", "-h, --help"],
  });
}

/**
 * @param {string} [prefix]
 * @param {string} [hub] 이번 실행에서 쓰는 허브 주소
 */
export function helpText(prefix = "dandi", hub = DEFAULT_HUB) {
  return `dandi ${CLI_TAG}: Dandi 교사용 CLI

사용법
  ${prefix} <명령> [옵션]

로그인
  login [--force]              브라우저 승인으로 로그인합니다. 이미 로그인되어 있으면 그대로 알려 주고,
                               --force면 새로 로그인합니다. 터미널에서는 승인 주소와 코드를 보여 주고
                               그 자리에서 기다립니다. AI 에이전트·비대화형 환경에서는 JSON을 출력하고
                               종료 코드 5로 끝납니다.
  login --wait [--timeout 90]  앞에서 시작한 로그인의 승인을 이어서 기다립니다(기본 90초).
  login --token-stdin          표준입력으로 받은 CLI 토큰으로 로그인합니다(CI용).
                               ${tokenStdinUsage(prefix).join("\n                               ")}
  logout                       이 컴퓨터에 저장된 로그인 정보를 지웁니다.
  whoami                       로그인한 계정을 확인합니다.

사이트
  init [--dir <폴더>]          dandi.json(등록 정보·셀프점검)과 llms.txt 뼈대를 만듭니다(덮어쓰지 않음).
  deploy [폴더] [--site <id>] [--new-site] [--project <id>] [--slug <이름>] [--title <제목>] [--allow-source]
                               폴더를 허브에 비공개 미리보기로 올립니다. 폴더를 적지 않으면
                               dandi.json의 outputDir → dist → build → out → 현재 폴더 순으로
                               index.html이 있는 곳을 찾습니다. 올린 폴더는 outputDir에 기록합니다.
                               --new-site: dandi.json의 siteId를 쓰지 않고 새 사이트로 올립니다
                                           (이전 siteId는 previousSiteId에 남깁니다).
                               --project: 사이트를 그 프로젝트로 옮기거나 그 프로젝트에 만듭니다.
                               --allow-source: 빌드 전 소스 폴더로 보여도 그대로 올립니다.
  deploy --vercel              (이전 방식) Vercel에 배포한 뒤 그 주소로 허브에 등록합니다.
  publish [--url <주소>]       dandi.json의 등록 정보·셀프점검을 확인하고 허브에 미니앱으로 등록합니다.
                               deploy로 올린 사이트가 없으면 --url(또는 url)의 외부 주소를 등록합니다.

스킬
  setup [--agent <도구 목록>] [-g]
                               배포 스킬(${DEPLOY_SKILL})을 이 폴더의 AI 코딩 도구(${DEFAULT_SKILL_AGENTS.join(", ")})에
                               설치하고, AI에게 보낼 문장을 보여 줍니다. -g는 모든 프로젝트용(사용자 폴더)으로 설치합니다.
  skill add <이름> [--agent ${DEFAULT_SKILL_AGENTS.join(",")}] [-g]
                               허브의 스킬을 AI 코딩 도구에 설치합니다(npx ${SKILLS_PACKAGE} add).
  skill publish [폴더] [--title <제목>]
                               SKILL.md가 있는 폴더를 허브에 게시합니다.
  skill list [검색어]          허브의 공개 스킬을 찾습니다.

AI 에이전트
  guide                        허브의 실행 런북(/llms.txt) 원문을 출력합니다.
  mcp                          stdio MCP 서버를 실행합니다(Claude 데스크톱·Cursor 등 연결용).

기타
  help [--json], --version

공통 옵션
  --hub <주소>                 이번 실행에서 사용할 허브 주소
  --json                       결과를 JSON 한 개로 출력합니다({"ok": true, ...} 또는 {"ok": false, "error": {...}})
  -h, --help                   도움말

종료 코드
  0 성공 · 1 기타 오류 · 2 사용법 오류 · 4 로그인 필요 · 5 승인 대기 · 6 거부됨 · 7 만료
  20 업로드 거부(site_not_found 포함) · 21 publish 검증 실패

환경 변수
  DANDI_HUB, DANDI_TOKEN   허브 주소와 토큰(CI용, 저장된 설정보다 우선)
  DANDI_CONFIG_DIR           설정 폴더(기본값: 홈 폴더의 .dandi)
  DANDI_NPX                  안내 명령의 실행 접두어(기본값: npx -y <허브>/${CLI_BUILD.tarball},
                               Windows PowerShell·cmd에서는 npx.cmd, Git Bash·macOS·Linux에서는 npx)
  DANDI_JSON_ASCII=1         --json 출력의 한글을 \\uXXXX로 적습니다(Windows PowerShell·cmd에서는 기본)

허브: ${hub}
`;
}
