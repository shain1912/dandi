import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  AGENT_ENV_VARS,
  AGENT_INSTRUCTIONS_LOGIN,
  ANSWERS_TEMPLATE,
  APPROVAL_RULE,
  CLI_BUILD,
  CLI_TAG,
  CLI_VERSION,
  COMMAND_SPECS,
  DEFAULT_SKILL_AGENTS,
  DEPLOY_SKILL,
  EXIT,
  PRIVACY_QUESTIONS,
  SETUP_PROMPT,
  SITE_LIMITS,
  SKILLS_PACKAGE,
  apiErrorMessage,
  applyOverrides,
  asciiJson,
  buildFileManifest,
  builtinRunbook,
  clampInterval,
  commandWithFolder,
  configDir,
  decodeJsonBytes,
  configPath,
  defaultManifest,
  describeUser,
  detectAgent,
  displayPath,
  errorJson,
  exitCodeFor,
  extOf,
  extractLastHttpsUrl,
  formatJsonOutput,
  fromMsysPath,
  helpJson,
  helpText,
  hubFromInstallSpec,
  humanErrorLines,
  isBuildConfigFile,
  isExcludedPath,
  isShellSafeArg,
  isValidSkillName,
  isValidSlug,
  jsonAsciiWanted,
  loginPendingJson,
  normalizeApiError,
  normalizeCategory,
  normalizeHub,
  normalizeSchoolLevel,
  npxCommand,
  npxPrefix,
  okJson,
  packageBuildSignals,
  parseAgentList,
  parseArgs,
  parseBuildInfo,
  parseConfig,
  parseLatestInfo,
  parsePending,
  parseTimeout,
  pendingPath,
  privacyQuestionsText,
  redactSecrets,
  savedAnswers,
  scanSecrets,
  secretGuidance,
  sha256Hex,
  shellArg,
  siteFolderCandidates,
  siteLimitProblems,
  sitePathProblem,
  skillAddArgs,
  sourceModuleReference,
  splitAllowedFiles,
  titleFromHtml,
  tokenStdinUsage,
  validateCommand,
  validateManifest,
  withNpxCommand,
  withSecretGuidance,
} from "../cli/lib.mjs";
import { APPROVAL_RULE as RUNBOOK_APPROVAL_RULE, PRIVACY_QUESTIONS as RUNBOOK_QUESTIONS } from "../src/lib/runbook.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const enc = (s: string) => new TextEncoder().encode(s);

const validManifest = () => ({
  title: "수업 퀴즈",
  description: "도입 5분 퀴즈",
  url: "https://quiz.example.com",
  schoolLevels: ["middle"] as unknown,
  category: "class" as unknown,
  privacyCheck: {
    collectsStudentData: false as unknown,
    storageLocation: "저장 안 함",
    retention: "저장 안 함",
    externalTransfer: false,
    needsSchoolApproval: false as unknown,
  },
});

/* ---------- 인자 ---------- */

test("parseArgs: 명령, 위치 인자, 값 옵션(공백·= 형식), 도움말", () => {
  const r = parseArgs(["deploy", "dist", "--hub", "http://h:3000"]);
  assert.equal(r.command, "deploy");
  assert.deepEqual(r.args, ["dist"]);
  assert.equal(r.flags.hub, "http://h:3000");
  assert.deepEqual(r.errors, []);

  const r2 = parseArgs(["publish", "--url=https://a.example.com", "--title", "제목 있음"]);
  assert.equal(r2.flags.url, "https://a.example.com");
  assert.equal(r2.flags.title, "제목 있음");

  assert.equal(parseArgs(["-h"]).flags.help, true);
  assert.equal(parseArgs(["publish", "--help"]).flags.help, true);
  assert.equal(parseArgs([]).command, "");
});

test("parseArgs: 불리언 옵션과 짧은 옵션", () => {
  const r = parseArgs(["login", "--wait", "--json", "--timeout", "30"]);
  assert.equal(r.flags.wait, true);
  assert.equal(r.flags.json, true);
  assert.equal(r.flags.timeout, "30");
  const s = parseArgs(["skill", "add", "quiz-maker", "-g", "--agent", "claude-code,codex"]);
  assert.deepEqual(s.args, ["add", "quiz-maker"]);
  assert.equal(s.flags.global, true);
  assert.equal(s.flags.agent, "claude-code,codex");
  assert.equal(parseArgs(["--version"]).flags.version, true);
  assert.equal(parseArgs(["-v"]).flags.version, true);
  assert.equal(parseArgs(["login", "--token-stdin"]).flags["token-stdin"], true);
  assert.deepEqual(parseArgs(["login", "--force"]).flags, { force: true });
  assert.deepEqual(parseArgs(["deploy", "--new-site"]).flags, { "new-site": true });
  assert.match(parseArgs(["login", "--json=1"]).errors[0], /값을 붙이지/);
  assert.match(parseArgs(["deploy", "-x"]).errors[0], /알 수 없는 옵션/);
});

test("parseArgs: 알 수 없는 옵션과 값 없는 옵션은 오류", () => {
  assert.match(parseArgs(["publish", "--bogus"]).errors[0], /알 수 없는 옵션/);
  assert.match(parseArgs(["publish", "--url"]).errors[0], /값이 필요/);
  assert.match(parseArgs(["publish", "--url", "--title", "x"]).errors[0], /--url/);
});

test("validateCommand: login 토큰 인자는 거부하고, 사용법은 bash·PowerShell 두 형식(npx 접두어)", () => {
  const errors = validateCommand(parseArgs(["login", "dd_cli_abc"]));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /--token-stdin/);
  assert.doesNotMatch(errors[0], /dd_cli_abc/);
  assert.deepEqual(tokenStdinUsage("npx -y http://h/dandi-0.2.0.tgz", "linux"), [
    'bash: printf %s "$DANDI_TOKEN" | npx -y http://h/dandi-0.2.0.tgz login --token-stdin',
    "PowerShell: $env:DANDI_TOKEN | npx -y http://h/dandi-0.2.0.tgz login --token-stdin",
  ]);
  // Windows: bash 줄은 npx, PowerShell 줄은 npx.cmd(접두어가 어느 쪽이든)
  for (const prefix of ["npx -y http://h/v.tgz", "npx.cmd -y http://h/v.tgz"]) {
    assert.deepEqual(tokenStdinUsage(prefix, "win32"), [
      'bash: printf %s "$DANDI_TOKEN" | npx -y http://h/v.tgz login --token-stdin',
      "PowerShell: $env:DANDI_TOKEN | npx.cmd -y http://h/v.tgz login --token-stdin",
    ]);
  }
  assert.equal(tokenStdinUsage("node cli/dandi.mjs", "win32")[1], "PowerShell: $env:DANDI_TOKEN | node cli/dandi.mjs login --token-stdin");
});

test("validateCommand: 명령별 옵션·인자 수", () => {
  assert.deepEqual(validateCommand(parseArgs(["login", "--json"])), []);
  assert.deepEqual(validateCommand(parseArgs(["login", "--wait", "--timeout", "90", "--json"])), []);
  assert.deepEqual(validateCommand(parseArgs(["login", "--force", "--json"])), []);
  assert.match(validateCommand(parseArgs(["login", "--force", "--wait"]))[0], /--force/);
  assert.match(validateCommand(parseArgs(["login", "--timeout", "90"]))[0], /--wait/);
  assert.match(validateCommand(parseArgs(["login", "--wait", "--timeout", "0"]))[0], /1~600/);
  assert.match(validateCommand(parseArgs(["whoami", "--slug", "x"]))[0], /--slug/);
  assert.match(validateCommand(parseArgs(["deploy", "a", "b"]))[0], /인자/);
  assert.deepEqual(validateCommand(parseArgs(["deploy", "dist", "--site", "site_1", "--json"])), []);
  assert.deepEqual(validateCommand(parseArgs(["deploy", "dist", "--new-site", "--json"])), []);
  assert.match(validateCommand(parseArgs(["deploy", "--new-site", "--site", "site_1"]))[0], /--new-site/);
  assert.deepEqual(validateCommand(parseArgs(["deploy", "dist", "--project", "prj_abc", "--allow-source", "--json"])), []);
  assert.match(validateCommand(parseArgs(["deploy", "--project", "prj a"]))[0], /프로젝트 ID/);
  assert.match(validateCommand(parseArgs(["publish", "--project", "prj_abc"]))[0], /--project/);
  assert.match(validateCommand(parseArgs(["deploy", "--vercel", "--allow-source"]))[0], /--vercel/);
  assert.match(validateCommand(parseArgs(["publish", "--new-site"]))[0], /--new-site/);
  assert.match(validateCommand(parseArgs(["publish", "https://a.example.com"])).join(" "), /--url/);
  assert.match(validateCommand(parseArgs(["frob"]))[0], /알 수 없는 명령/);
  assert.deepEqual(validateCommand(parseArgs(["skill", "add", "quiz-maker", "-g"])), []);
  assert.match(validateCommand(parseArgs(["skill", "add"]))[0], /스킬 이름/);
  assert.match(validateCommand(parseArgs(["skill", "add", "Bad Name"]))[0], /형식/);
  assert.match(validateCommand(parseArgs(["skill", "remove", "x"]))[0], /알 수 없는 skill/);
  assert.match(validateCommand(parseArgs(["skill", "list", "-g"]))[0], /skill add에서만/);
  assert.deepEqual(validateCommand(parseArgs(["skill", "list", "퀴즈", "만들기", "--json"])), []);
});

test("parseTimeout / clampInterval", () => {
  assert.equal(parseTimeout("90"), 90);
  assert.equal(parseTimeout("600"), 600);
  assert.equal(parseTimeout("601"), null);
  assert.equal(parseTimeout("abc"), null);
  assert.equal(parseTimeout(true), null);
  assert.equal(clampInterval(5), 5);
  assert.equal(clampInterval(0), 1);
  assert.equal(clampInterval(1000), 60);
  assert.equal(clampInterval(undefined), 5);
});

/* ---------- 설정·주소 ---------- */

test("configDir: DANDI_CONFIG_DIR가 있으면 우선, 없으면 홈/.dandi", () => {
  const home = path.resolve("/home/t");
  assert.equal(configDir({}, home), path.join(home, ".dandi"));
  assert.equal(configPath({}, home), path.join(home, ".dandi", "config.json"));
  assert.equal(pendingPath({}, home), path.join(home, ".dandi", "pending.json"));
  const custom = path.resolve("/tmp/vh-test");
  assert.equal(configDir({ DANDI_CONFIG_DIR: custom }, home), custom);
  assert.equal(configDir({ DANDI_CONFIG_DIR: "  " }, home), path.join(home, ".dandi"));
});

test("normalizeHub: http(s)만 허용하고 끝의 /를 뗌", () => {
  assert.equal(normalizeHub("http://localhost:3000/"), "http://localhost:3000");
  assert.equal(normalizeHub("https://hub.example.com/sub/"), "https://hub.example.com/sub");
  assert.equal(normalizeHub("ftp://x"), null);
  assert.equal(normalizeHub("localhost:3000"), null);
  assert.equal(normalizeHub(""), null);
  assert.equal(normalizeHub("https://user:pw@hub.example.com"), null);
  assert.equal(normalizeHub("https://hub.example.com/?x=1"), null);
});

test("parseConfig: 형식이 맞는 설정만 받음", () => {
  assert.deepEqual(parseConfig({ hub: "http://h/", token: "dd_cli_x" }), { hub: "http://h", token: "dd_cli_x" });
  assert.equal(parseConfig({ hub: "http://h", token: "dd_sk_x" }), null);
  assert.equal(parseConfig({ token: "dd_cli_x" }), null);
  assert.equal(parseConfig(null), null);
});

test("parsePending: 필수 칸과 만료 시각", () => {
  const ok = {
    hub: "http://h:3000/",
    device_code: "dd_dev_x",
    user_code: "BCDF-GHJK",
    verification_uri: "http://h:3000/device",
    verification_uri_complete: "http://h:3000/device?code=BCDF-GHJK",
    interval: 5,
    expires_at: new Date().toISOString(),
  };
  assert.equal(parsePending(ok)?.hub, "http://h:3000");
  assert.equal(parsePending({ ...ok, device_code: "" }), null);
  assert.equal(parsePending({ ...ok, expires_at: "not-a-date" }), null);
  assert.equal(parsePending({ ...ok, interval: undefined })?.interval, 5);
});

test("hubFromInstallSpec: npx tarball 설치 폴더의 package.json에서 허브 주소를 찾음", () => {
  assert.equal(
    hubFromInstallSpec({
      dependencies: { "dandi": "http://localhost:3000/dandi-0.2.0.tgz" },
      _npx: { packages: ["http://localhost:3000/dandi-0.2.0.tgz"] },
    }),
    "http://localhost:3000",
  );
  assert.equal(hubFromInstallSpec({ _npx: { packages: ["https://hub.school.kr/dandi/dandi-0.3.1.tgz"] } }), "https://hub.school.kr/dandi");
  // 소스 해시를 붙인 이름(dandi-<version>-<sha8>.tgz)도 받는다.
  assert.equal(hubFromInstallSpec({ _npx: { packages: ["http://localhost:3100/dandi-0.2.0-1a2b3c4d.tgz"] } }), "http://localhost:3100");
  assert.equal(hubFromInstallSpec({ dependencies: { "dandi": "^0.2.0" } }), null);
  assert.equal(hubFromInstallSpec({ dependencies: { "other-cli": "http://h/other-0.1.0.tgz" } }), null);
  assert.equal(hubFromInstallSpec({ _npx: { packages: ["http://h/dandi-0.2.0.tgz?x=1"] } }), null);
  assert.equal(hubFromInstallSpec(null), null);
});

test("npxCommand: Windows PowerShell·cmd는 npx.cmd, Git Bash(MSYSTEM)·macOS·Linux는 npx", () => {
  assert.equal(npxCommand({}, "win32"), "npx.cmd");
  assert.equal(npxCommand({ MSYSTEM: "MINGW64" }, "win32"), "npx");
  assert.equal(npxCommand({ MSYSTEM: " " }, "win32"), "npx.cmd");
  assert.equal(npxCommand({}, "linux"), "npx");
  assert.equal(npxCommand({}, "darwin"), "npx");
  assert.equal(npxPrefix("http://h", {}, "0.2.0-1a2b3c4d", "win32"), "npx.cmd -y http://h/dandi-0.2.0-1a2b3c4d.tgz");
  assert.equal(npxPrefix("http://h", { MSYSTEM: "MINGW64" }, "0.2.0-1a2b3c4d", "win32"), "npx -y http://h/dandi-0.2.0-1a2b3c4d.tgz");
  assert.equal(npxPrefix("http://h", { MSYSTEM: "MINGW64", DANDI_NPX: "node x.mjs" }, "0.2.0", "win32"), "node x.mjs");
  assert.equal(withNpxCommand("npx.cmd -y http://h/v.tgz", "npx"), "npx -y http://h/v.tgz");
  assert.equal(withNpxCommand("npx -y http://h/v.tgz", "npx.cmd"), "npx.cmd -y http://h/v.tgz");
  assert.equal(withNpxCommand("node npx.mjs", "npx.cmd"), "node npx.mjs");
});

test("npxPrefix: 허브와 이 빌드의 tarball(dandi-<tag>.tgz)로 실행 형식을 만들고 DANDI_NPX로 덮어씀", () => {
  assert.equal(npxPrefix("http://localhost:3000", {}, CLI_BUILD.tarball, "linux"), `npx -y http://localhost:3000/${CLI_BUILD.tarball}`);
  assert.equal(npxPrefix("http://localhost:3000", {}), `${npxCommand({})} -y http://localhost:3000/${CLI_BUILD.tarball}`);
  assert.equal(CLI_BUILD.tarball, `dandi-${CLI_TAG}.tgz`);
  assert.ok(CLI_TAG === CLI_VERSION || CLI_TAG.startsWith(`${CLI_VERSION}-`), CLI_TAG);
  assert.equal(npxPrefix("https://hub.kr", {}, "9.9.9", "linux"), "npx -y https://hub.kr/dandi-9.9.9.tgz");
  assert.equal(npxPrefix("https://hub.kr", {}, "0.2.0-1a2b3c4d", "linux"), "npx -y https://hub.kr/dandi-0.2.0-1a2b3c4d.tgz");
  assert.equal(npxPrefix("https://hub.kr", {}, "dandi-0.2.0-1a2b3c4d.tgz", "linux"), "npx -y https://hub.kr/dandi-0.2.0-1a2b3c4d.tgz");
  assert.equal(npxPrefix("http://h", { DANDI_NPX: " node cli/dandi.mjs " }), "node cli/dandi.mjs");
});

test("CLI 빌드 태그: cli/build-info.json이 있으면 그 태그, 없으면 버전", () => {
  const file = path.join(ROOT, "cli", "build-info.json");
  if (existsSync(file)) {
    const info = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(CLI_TAG, info.tag);
    assert.equal(CLI_BUILD.tarball, info.tarball);
  } else {
    assert.equal(CLI_TAG, CLI_VERSION);
    assert.equal(CLI_BUILD.tarball, `dandi-${CLI_VERSION}.tgz`);
  }
});

test("parseBuildInfo / parseLatestInfo: 빌드 태그와 tarball 이름을 확인(형식이 틀리면 버전만)", () => {
  assert.deepEqual(parseBuildInfo(null, "0.2.0"), { version: "0.2.0", tag: "0.2.0", tarball: "dandi-0.2.0.tgz" });
  assert.deepEqual(parseBuildInfo({ version: "0.2.0", tag: "0.2.0-1a2b3c4d", tarball: "dandi-0.2.0-1a2b3c4d.tgz" }, "0.2.0"), {
    version: "0.2.0",
    tag: "0.2.0-1a2b3c4d",
    tarball: "dandi-0.2.0-1a2b3c4d.tgz",
  });
  // 다른 버전의 태그, 셸에 위험한 이름은 받지 않는다.
  assert.equal(parseBuildInfo({ tag: "0.3.0-aaaa" }, "0.2.0").tag, "0.2.0");
  assert.equal(parseBuildInfo({ tag: "0.2.0-x; rm -rf /" }, "0.2.0").tag, "0.2.0");
  assert.equal(parseBuildInfo({ tag: "0.2.0-abcd", tarball: "evil.tgz; ls" }, "0.2.0").tarball, "dandi-0.2.0-abcd.tgz");
  assert.deepEqual(parseLatestInfo({ version: "0.3.0", tag: "0.3.0-deadbeef", tarball: "dandi-0.3.0-deadbeef.tgz" }), {
    version: "0.3.0",
    tag: "0.3.0-deadbeef",
    tarball: "dandi-0.3.0-deadbeef.tgz",
  });
  assert.equal(parseLatestInfo({ version: "0.3.0", tag: "9.9.9-x" }), null);
  assert.equal(parseLatestInfo("<html>"), null);
});

test("detectAgent: 환경 변수·TTY로 에이전트 모드와 도구 이름을 정함", () => {
  assert.deepEqual(detectAgent({}, true), { agent: false, client: "terminal" });
  assert.deepEqual(detectAgent({}, false), { agent: true, client: "non-interactive" });
  assert.deepEqual(detectAgent({ CLAUDECODE: "1" }, true), { agent: true, client: "claude-code" });
  assert.deepEqual(detectAgent({ CLAUDE_CODE_ENTRYPOINT: "cli" }, true), { agent: true, client: "claude-code" });
  assert.deepEqual(detectAgent({ CODEX_CI: "1" }, true), { agent: true, client: "codex" });
  assert.deepEqual(detectAgent({ CODEX_THREAD_ID: "t1" }, true), { agent: true, client: "codex" });
  assert.deepEqual(detectAgent({ CURSOR_AGENT: "1" }, true), { agent: true, client: "cursor" });
  assert.deepEqual(detectAgent({ GEMINI_CLI: "1" }, true), { agent: true, client: "gemini-cli" });
  // Antigravity CLI(agy)와 Grok이 셸 명령에 넣는 변수
  assert.deepEqual(detectAgent({ ANTIGRAVITY_AGENT: "1" }, true), { agent: true, client: "antigravity" });
  assert.deepEqual(detectAgent({ GROK_SESSION_ID: "0b6c" }, true), { agent: true, client: "grok" });
  for (const name of ["ANTIGRAVITY_AGENT", "GROK_SESSION_ID"]) assert.ok(AGENT_ENV_VARS.includes(name), name);
  assert.deepEqual(detectAgent({ AI_AGENT: "my-agent<script>" }, true), { agent: true, client: "my-agentscript" });
  assert.deepEqual(detectAgent({ CLAUDECODE: "0", CODEX_CI: "" }, true), { agent: false, client: "terminal" });
});

/* ---------- 경로·셸 인자 ---------- */

test("shellArg / displayPath / commandWithFolder: next_step은 bash·PowerShell에서 그대로 실행됨", () => {
  assert.equal(shellArg("dist"), "dist");
  assert.equal(shellArg("C:/Users/t/site"), "C:/Users/t/site");
  assert.equal(shellArg("내 퀴즈 사이트"), '"내 퀴즈 사이트"');
  assert.equal(shellArg("a b(1)&c"), '"a b(1)&c"');
  assert.equal(shellArg("-x"), '"-x"');
  for (const bad of ['a"b', "a$b", "a`b", "a\\b", "a\nb", ""]) assert.equal(shellArg(bad), null, JSON.stringify(bad));
  const cwd = path.resolve("/work/proj");
  assert.equal(displayPath(path.join(cwd, "dist"), cwd), "dist");
  assert.equal(displayPath(cwd, cwd), ".");
  assert.equal(displayPath(path.join(cwd, "내 사이트", "out"), cwd), "내 사이트/out");
  assert.equal(displayPath(path.resolve("/other/site"), cwd), path.resolve("/other/site").split(path.sep).join("/"));
  assert.equal(displayPath(path.join(cwd, "-weird"), cwd), "./-weird");
  assert.equal(commandWithFolder("npx -y h/v.tgz", "deploy", "내 퀴즈 사이트", "--json"), 'npx -y h/v.tgz deploy "내 퀴즈 사이트" --json');
  assert.equal(commandWithFolder("p", "deploy", undefined, "--json"), "p deploy --json");
  assert.equal(commandWithFolder("p", "deploy", "a$b", "--json"), null);
});

test("fromMsysPath: Windows에서 /c/... · /cygdrive/c/... 경로를 C:/...로 바꿈", () => {
  assert.equal(fromMsysPath("/c/Users/t/site", "win32"), "C:/Users/t/site");
  assert.equal(fromMsysPath("/cygdrive/d/work", "win32"), "D:/work");
  assert.equal(fromMsysPath("/c", "win32"), "C:/");
  assert.equal(fromMsysPath("/c/Users/t", "linux"), "/c/Users/t");
  assert.equal(fromMsysPath("C:\\Users\\t", "win32"), "C:\\Users\\t");
  assert.equal(fromMsysPath("/usr/local", "win32"), "/usr/local");
  assert.equal(fromMsysPath("dist", "win32"), "dist");
});

/* ---------- 종료 코드·출력 형식 ---------- */

test("exitCodeFor: 원인별 종료 코드", () => {
  assert.equal(exitCodeFor("usage"), EXIT.USAGE);
  assert.equal(exitCodeFor("login_required"), 4);
  assert.equal(exitCodeFor("unauthorized", "deploy"), 4);
  assert.equal(exitCodeFor("authorization_pending"), 5);
  assert.equal(exitCodeFor("slow_down"), 5);
  assert.equal(exitCodeFor("access_denied"), 6);
  assert.equal(exitCodeFor("expired_token"), 7);
  assert.equal(exitCodeFor("invalid_grant"), 7);
  assert.equal(exitCodeFor("invalid_publish", "publish"), 21);
  assert.equal(exitCodeFor("secret_detected", "deploy"), 20);
  assert.equal(exitCodeFor("missing_files", "deploy"), 20);
  assert.equal(exitCodeFor("hash_mismatch", "deploy"), 20);
  assert.equal(exitCodeFor("network_error", "deploy"), 1);
  assert.equal(exitCodeFor("server_error", "deploy"), 1);
  assert.equal(exitCodeFor("something_else"), 1);
  // 폴더·등록 대상을 못 찾은 것은 사용법 오류(2), 사이트가 계정에 없거나 소스 폴더면 업로드 거부(20)
  assert.equal(exitCodeFor("folder_not_found", "deploy"), 2);
  assert.equal(exitCodeFor("missing_index", "deploy"), 2);
  assert.equal(exitCodeFor("nothing_to_publish", "publish"), 2);
  assert.equal(exitCodeFor("site_not_found", "publish"), 20);
  assert.equal(exitCodeFor("source_folder", "deploy"), 20);
  assert.equal(exitCodeFor("manifest_encoding", "publish"), 2);
  assert.equal(exitCodeFor("manifest_in_parent", "deploy"), 2);
  assert.deepEqual(EXIT, {
    OK: 0, ERROR: 1, USAGE: 2, LOGIN_REQUIRED: 4, PENDING: 5, DENIED: 6, EXPIRED: 7, UPLOAD_REJECTED: 20, PUBLISH_INVALID: 21,
  });
});

test("normalizeApiError: 새 API·RFC 8628·v0.1 형식을 하나로", () => {
  assert.deepEqual(normalizeApiError(422, { error: { code: "secret_detected", message: "비밀값", hint: "a.js" } }), {
    code: "secret_detected",
    message: "비밀값",
    hint: "a.js",
  });
  assert.deepEqual(normalizeApiError(400, { error: "authorization_pending" }), {
    code: "authorization_pending",
    message: "교사의 브라우저 승인을 기다리는 중입니다.",
  });
  assert.equal(normalizeApiError(400, { error: "access_denied", error_description: "거부됨" }).message, "거부됨");
  assert.deepEqual(normalizeApiError(400, { error: "앱 이름을 입력하십시오." }), { code: "bad_request", message: "앱 이름을 입력하십시오." });
  assert.equal(normalizeApiError(401, null).code, "unauthorized");
  assert.equal(normalizeApiError(503, "<html>").code, "server_error");
});

test("okJson / errorJson / humanErrorLines 형식", () => {
  assert.deepEqual(okJson({ status: "logged_in" }), { ok: true, status: "logged_in" });
  assert.deepEqual(errorJson({ code: "login_required", message: "로그인 필요", nextStep: "npx -y h login --json" }), {
    ok: false,
    error: { code: "login_required", message: "로그인 필요" },
    next_step: "npx -y h login --json",
  });
  assert.deepEqual(errorJson({ code: "x", message: "m", hint: "h", extra: { missing: ["title"] } }), {
    ok: false,
    error: { code: "x", message: "m", hint: "h" },
    missing: ["title"],
  });
  assert.deepEqual(humanErrorLines({ message: "m", hint: "h", nextStep: "cmd" }), ["오류: m", "도움말: h", "다음 실행: cmd"]);
  // 그대로 실행할 명령이 없으면 next_step을 내지 않고 틀(next_step_template)을 따로 준다.
  assert.deepEqual(errorJson({ code: "missing_index", message: "m", nextStep: null, nextStepTemplate: 'p deploy "<폴더>" --json' }), {
    ok: false,
    error: { code: "missing_index", message: "m" },
    next_step_template: 'p deploy "<폴더>" --json',
  });
  assert.deepEqual(humanErrorLines({ message: "m", nextStep: null }), ["오류: m"]);
  assert.deepEqual(humanErrorLines({ message: "m", nextStep: null, nextStepTemplate: 'p deploy "<폴더>" --json' }), [
    "오류: m",
    '다음 실행(<폴더>를 실제 폴더로 바꾸어): p deploy "<폴더>" --json',
  ]);
  // 폴더 자리표시가 없는 틀은 "확인한 뒤 실행할 명령"(예: 교사가 계정을 확인한 뒤의 --new-site)
  assert.deepEqual(humanErrorLines({ message: "m", nextStep: null, nextStepTemplate: "p deploy --new-site --json" }), [
    "오류: m",
    "확인한 뒤 실행할 명령: p deploy --new-site --json",
  ]);
});

test("--json 인코딩: 기본은 UTF-8 그대로, Windows PowerShell·cmd(MSYSTEM 없음)나 DANDI_JSON_ASCII=1이면 \\uXXXX", () => {
  assert.equal(jsonAsciiWanted({}, "linux"), false);
  assert.equal(jsonAsciiWanted({}, "darwin"), false);
  assert.equal(jsonAsciiWanted({ MSYSTEM: "MINGW64" }, "win32"), false);
  assert.equal(jsonAsciiWanted({}, "win32"), true);
  assert.equal(jsonAsciiWanted({ DANDI_JSON_ASCII: "1" }, "linux"), true);
  assert.equal(jsonAsciiWanted({ DANDI_JSON_ASCII: "0", MSYSTEM: "MINGW64" }, "win32"), false);
  const value = { message: "활동지.hwp를 올리지 않았습니다" };
  assert.equal(formatJsonOutput(value, {}, "linux"), JSON.stringify(value));
  assert.equal(formatJsonOutput(value, { MSYSTEM: "MINGW64" }, "win32"), JSON.stringify(value));
  assert.match(formatJsonOutput(value, {}, "win32"), /^[\x20-\x7e]*$/);
  assert.deepEqual(JSON.parse(formatJsonOutput(value, { DANDI_JSON_ASCII: "1" }, "linux")), value);
});

test("asciiJson: 한글을 \\uXXXX로 적어 콘솔 코드 페이지와 관계없이 읽힘", () => {
  const value = { name: "김교사", emoji: "😀", ok: true, list: ["중", "a"], tab: "a\tb" };
  const text = asciiJson(value);
  assert.match(text, /^[\x20-\x7e]*$/);
  assert.ok(text.includes("\\uae40"), text);
  assert.deepEqual(JSON.parse(text), value);
});

test("loginPendingJson: 계약 3-2 예시와 같은 순서, 아직 끝나지 않았다는 done:false", () => {
  const prefix = npxPrefix("http://localhost:3000", {}, CLI_BUILD.tarball, "linux");
  const out = loginPendingJson(
    {
      user_code: "WDJB-MJHT",
      verification_uri: "http://localhost:3000/device",
      verification_uri_complete: "http://localhost:3000/device?code=WDJB-MJHT",
      expires_in: 600,
    },
    prefix,
  );
  assert.equal(
    JSON.stringify(out),
    `{"ok":true,"status":"pending","done":false,"user_code":"WDJB-MJHT","verification_uri":"http://localhost:3000/device","verification_uri_complete":"http://localhost:3000/device?code=WDJB-MJHT","expires_in":600,"next_step":"npx -y http://localhost:3000/${CLI_BUILD.tarball} login --wait --json","agent_instructions":"Show verification_uri_complete and user_code to the user exactly as given and ask them to approve in the browser. Then, in the same turn, run next_step in the foreground (not as a background task; do not end your turn to wait for a reply). It waits up to 90 seconds for the approval by itself. Repeat next_step while status is pending."}`,
  );
  assert.equal(out.agent_instructions, AGENT_INSTRUCTIONS_LOGIN);
});

test("redactSecrets: 토큰·키·device code를 가림", () => {
  assert.equal(redactSecrets("token dd_cli_AbC-12_x done"), "token dd_cli_*** done");
  assert.equal(redactSecrets('{"a":"dd_dev_zz","b":"dd_sk_1","c":"dd_mat_2","d":"dd_mrt_3"}'), '{"a":"dd_dev_***","b":"dd_sk_***","c":"dd_mat_***","d":"dd_mrt_***"}');
  assert.equal(redactSecrets("dd_cli_ 로 시작합니다"), "dd_cli_ 로 시작합니다");
});

test("apiErrorMessage: 서버 오류 문장을 우선, 없으면 상태 코드별 안내", () => {
  assert.equal(apiErrorMessage(400, { error: "앱 이름을 입력하십시오." }), "앱 이름을 입력하십시오.");
  assert.equal(apiErrorMessage(422, { error: { code: "x", message: "새 형식" } }), "새 형식");
  assert.match(apiErrorMessage(401, null), /login/);
  assert.match(apiErrorMessage(404, "<html>"), /--hub/);
  assert.match(apiErrorMessage(502, null), /502/);
});

test("describeUser: 이름, 역할, 학교급", () => {
  assert.equal(describeUser({ name: "김교사", role: "teacher", schoolLevel: "middle" }), "김교사 (교사 · 중)");
  assert.equal(describeUser({ name: "관리자", role: "admin", schoolLevel: null }), "관리자 (교육청 관리자)");
});

/* ---------- 셀프점검 문구 ---------- */

test("셀프점검 5문항: 허브 런북(src/lib/runbook.ts)과 문항·승인 규칙 문장이 같음", () => {
  assert.equal(PRIVACY_QUESTIONS.length, RUNBOOK_QUESTIONS.length);
  for (const [i, q] of PRIVACY_QUESTIONS.entries()) {
    assert.equal(q.key, RUNBOOK_QUESTIONS[i].key);
    assert.equal(q.mark, RUNBOOK_QUESTIONS[i].mark);
    assert.equal(q.question, RUNBOOK_QUESTIONS[i].question);
  }
  assert.equal(APPROVAL_RULE, RUNBOOK_APPROVAL_RULE);
  const text = privacyQuestionsText();
  assert.ok(text.includes(APPROVAL_RULE));
  assert.ok(!text.includes('①이 "예"이면 앱은'), "승인 대기는 ⑤가 정한다");
  for (const q of PRIVACY_QUESTIONS) assert.ok(text.includes(`${q.mark} ${q.question}`), q.key);
  // dandi.json의 _help도 같은 문항을 쓴다.
  const help = defaultManifest("x")._help as Record<string, string>;
  for (const q of PRIVACY_QUESTIONS) assert.ok(help[`privacyCheck.${q.key}`].includes(`${q.mark} ${q.question}`), q.key);
  assert.ok(help.privacyCheck.includes(APPROVAL_RULE));
});

/* ---------- dandi.json ---------- */

test("validateManifest: 올바른 파일은 _help 없이 본문을 만듦", () => {
  const r = validateManifest({ _help: { title: "설명" }, ...validManifest() });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.title, "수업 퀴즈");
    assert.equal("_help" in r.value, false);
    assert.equal(r.value.privacyCheck.storageLocation, "저장 안 함");
  }
});

test("defaultManifest: 학교급·분류·설명·셀프점검은 비워 두고, 교사가 확인하기 전에는 publish가 빠진 항목으로 알림", () => {
  const m = defaultManifest("우리말 퀴즈");
  assert.equal(m.siteId, "");
  assert.equal(m.projectId, "");
  assert.equal(m.title, "우리말 퀴즈");
  assert.deepEqual(m.schoolLevels, []);
  assert.equal(m.category, "");
  const r = validateManifest(applyOverrides(m, { url: "https://a.example.com" }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    for (const key of ["collectsStudentData", "storageLocation", "retention", "externalTransfer", "needsSchoolApproval"]) {
      assert.ok(r.missing.includes(`privacyCheck.${key}`), key);
      assert.ok(r.errors.some((e) => e.startsWith(`privacyCheck.${key}`)), key);
    }
    for (const key of ["description", "schoolLevels", "category"]) assert.ok(r.missing.includes(key), key);
    assert.deepEqual(r.invalid, []);
  }
  const empty = validateManifest(defaultManifest(""), { requireUrl: false });
  assert.ok(!empty.ok && empty.missing.includes("title"));
});

test("validateManifest: 한국어 학교급·분류(초/중/고/특수, 수업/업무/학생지도/기타)를 id로 바꿈", () => {
  const m = validManifest();
  m.schoolLevels = ["중", "고등학교", "elem", "Middle"];
  m.category = "학생지도";
  const r = validateManifest(m);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (r.ok) {
    assert.deepEqual(r.value.schoolLevels, ["middle", "high", "elem"]);
    assert.equal(r.value.category, "guidance");
  }
  assert.equal(normalizeSchoolLevel("특수"), "special");
  assert.equal(normalizeSchoolLevel("대학"), null);
  assert.equal(normalizeCategory("수업"), "class");
  assert.equal(normalizeCategory("기타"), "etc");
  assert.equal(normalizeCategory("fun"), null);
  const one = validManifest();
  one.schoolLevels = "초, 중";
  const r2 = validateManifest(one);
  assert.ok(r2.ok && r2.value.schoolLevels.join() === "elem,middle");
});

test("validateManifest: 빠진 항목(missing)과 형식만 틀린 항목(invalid)과 맞지 않는 답(conflicts)을 나눔", () => {
  const m = validManifest();
  m.schoolLevels = ["college"];
  m.category = "fun";
  m.privacyCheck.collectsStudentData = "false";
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.invalid.map((i) => i.field).sort(), ["category", "privacyCheck.collectsStudentData", "schoolLevels"]);
    // 허용값을 알려 준다
    assert.match(r.invalid.find((i) => i.field === "schoolLevels")?.problem ?? "", /elem\|middle\|high\|special/);
    assert.match(r.invalid.find((i) => i.field === "category")?.problem ?? "", /class\|work\|guidance\|etc/);
    assert.match(r.invalid.find((i) => i.field === "privacyCheck.collectsStudentData")?.problem ?? "", /true 또는 false/);
  }

  const conflict = validManifest();
  conflict.privacyCheck.collectsStudentData = true;
  conflict.privacyCheck.needsSchoolApproval = false;
  const c = validateManifest(conflict);
  assert.equal(c.ok, false);
  if (!c.ok) {
    assert.deepEqual(c.missing, []);
    assert.deepEqual(c.conflicts.map((x) => x.field), ["privacyCheck.needsSchoolApproval"]);
    assert.match(c.conflicts[0].problem, /⑤를 다시 물으십시오/);
  }
});

test("validateManifest: URL 필수 여부, 제목 길이, 객체가 아닌 파일", () => {
  const noUrl = { ...validManifest(), url: "" };
  assert.equal(validateManifest(noUrl).ok, false);
  assert.equal(validateManifest(noUrl, { requireUrl: false }).ok, true);
  const bad = validateManifest({ ...validManifest(), url: "javascript:alert(1)" });
  assert.ok(!bad.ok && bad.invalid.some((i) => i.field === "url"));
  const long = validateManifest({ ...validManifest(), title: "가".repeat(81) });
  assert.ok(!long.ok && long.invalid.some((i) => i.field === "title"));
  assert.equal(validateManifest([]).ok, false);
});

test("validateManifest: 깨진 글자(U+FFFD)가 든 값은 거부하고 garbled로 알려 줌", () => {
  const m = validManifest();
  m.title = "\uFFFD\uFFFD 퀴즈";
  m.privacyCheck.storageLocation = "\uFFFD\uFFFD \uFFFD \uFFFD";
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.garbled.sort(), ["privacyCheck.storageLocation", "title"]);
    assert.ok(r.invalid.some((i) => i.field === "title" && /깨진 글자/.test(i.problem) && /Set-Content -Encoding UTF8/.test(i.problem)));
    assert.deepEqual(r.missing, []);
  }
  const ok = validateManifest(validManifest());
  assert.equal(ok.ok, true);
});

test("decodeJsonBytes: UTF-8(BOM)·UTF-16LE/BE(BOM·BOM 없음)를 읽고, ANSI(CP949)·깨진 글자는 알려 줌", () => {
  const text = '{"title":"우리말 퀴즈"}';
  const utf8 = new TextEncoder().encode(text);
  assert.deepEqual(decodeJsonBytes(utf8), { text, encoding: "utf8", problem: null });
  assert.equal(decodeJsonBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8])).text, text);
  const le = Buffer.from(text, "utf16le");
  assert.deepEqual(decodeJsonBytes(new Uint8Array([0xff, 0xfe, ...le])), { text, encoding: "utf16le", problem: null });
  assert.deepEqual(decodeJsonBytes(new Uint8Array(le)), { text, encoding: "utf16le", problem: null });
  const be = Buffer.from(le).swap16();
  assert.deepEqual(decodeJsonBytes(new Uint8Array([0xfe, 0xff, ...be])), { text, encoding: "utf16be", problem: null });
  assert.equal(decodeJsonBytes(new Uint8Array(be)).encoding, "utf16be");
  // "우리말"을 CP949로 저장한 바이트: UTF-8로는 읽을 수 없다.
  const cp949 = new Uint8Array([0x7b, 0x22, 0x74, 0x22, 0x3a, 0x22, 0xbf, 0xec, 0xb8, 0xae, 0xb8, 0xbb, 0x22, 0x7d]);
  assert.equal(decodeJsonBytes(cp949).problem, "invalid_utf8");
  assert.equal(decodeJsonBytes(new TextEncoder().encode('{"t":"\uFFFD\uFFFD"}')).problem, "replacement_char");
});

test("savedAnswers: 다시 올릴 때 교사에게 보여 줄 저장된 답(문항 원문 포함)", () => {
  const r = validateManifest(validManifest());
  assert.ok(r.ok);
  if (r.ok) {
    const s = savedAnswers(r.value);
    assert.equal(s.title, "수업 퀴즈");
    assert.deepEqual(s.schoolLevels, ["middle(중)"]);
    assert.equal(s.category, "class(수업)");
    assert.equal(s.privacy.length, 5);
    assert.ok(s.privacy[0].startsWith(`① ${PRIVACY_QUESTIONS[0].question}`));
    assert.ok(s.privacy[0].endsWith(": 아니요"));
  }
});

test("titleFromHtml: index.html의 <title>", () => {
  assert.equal(titleFromHtml("<html><head><title> 우리말 &amp; 퀴즈 </title></head></html>"), "우리말 & 퀴즈");
  assert.equal(titleFromHtml("<TITLE>\n  A\n  B </TITLE>"), "A B");
  assert.equal(titleFromHtml("<h1>no title</h1>"), null);
  assert.equal(titleFromHtml("<title></title>"), null);
  assert.equal(titleFromHtml(`<title>${"가".repeat(100)}</title>`)?.length, 80);
});

test("applyOverrides: --url, --title 값만 덮어씀", () => {
  const out = applyOverrides(validManifest(), { url: "https://b.example.com", title: undefined }) as ReturnType<
    typeof validManifest
  >;
  assert.equal(out.url, "https://b.example.com");
  assert.equal(out.title, "수업 퀴즈");
});

test("extractLastHttpsUrl: vercel 출력의 마지막 https 주소", () => {
  const out = [
    "Vercel CLI 39.0.0",
    "Inspect: https://vercel.com/team/proj/abc123 [2s]",
    "Production: https://my-quiz.vercel.app [3s]",
    "https://my-quiz.vercel.app",
    "",
  ].join("\n");
  assert.equal(extractLastHttpsUrl(out), "https://my-quiz.vercel.app");
  assert.equal(extractLastHttpsUrl("배포 완료 (https://x.vercel.app)."), "https://x.vercel.app");
  assert.equal(extractLastHttpsUrl("no url here"), null);
});

/* ---------- 사이트 파일 ---------- */

test("isExcludedPath: node_modules, .git, .env*, 점 파일, dandi.json 제외", () => {
  for (const p of ["node_modules", "a/node_modules/x.js", ".git", ".git/config", ".env", ".env.local", "sub/.secret", ".well-known/x", "dandi.json", "sub/dandi.json"]) {
    assert.equal(isExcludedPath(p), true, p);
  }
  for (const p of ["index.html", "assets/app.js", "llms.txt", "env.js", "a.b/c.css", "dandi.json.bak"]) {
    assert.equal(isExcludedPath(p), false, p);
  }
});

test("isBuildConfigFile / sourceModuleReference: 빌드 전 소스 폴더를 알아봄", () => {
  for (const p of ["package.json", "package-lock.json", "vite.config.js", "vite.config.mts", "tsconfig.json", "tsconfig.app.json"]) {
    assert.equal(isBuildConfigFile(p), true, p);
  }
  for (const p of ["src/package.json", "data.json", "app.js", "config.js"]) assert.equal(isBuildConfigFile(p), false, p);
  assert.equal(sourceModuleReference('<script type="module" src="/src/main.jsx"></script>'), "/src/main.jsx");
  assert.equal(sourceModuleReference("<script type=module src='./src/main.ts?v=1'></script>"), "./src/main.ts");
  assert.equal(sourceModuleReference('<script type="module">import App from "./App.vue";</script>'), "./App.vue");
  assert.equal(sourceModuleReference('<script src="app.js"></script><link href="a.css">'), null);
  assert.equal(sourceModuleReference('<script src="types.d.ts"></script>'), null);
  // 루트 절대 경로 /src/의 모듈(빌드 전 Vite vanilla 템플릿)
  assert.equal(sourceModuleReference('<script type="module" src="/src/main.js"></script>'), "/src/main.js");
  assert.equal(sourceModuleReference('<link rel="modulepreload" href="/src/app.tsx">'), "/src/app.tsx");
  assert.equal(sourceModuleReference('<script type="module">import "/src/main.js";</script>'), "/src/main.js");
  // 일반 스크립트의 /src/ 경로, 빌드 결과(/assets/), 외부 주소는 소스가 아니다.
  assert.equal(sourceModuleReference('<script src="/src/app.js"></script>'), null);
  assert.equal(sourceModuleReference('<script type="module" src="/assets/index-abc.js"></script>'), null);
  assert.equal(sourceModuleReference('<script type="module" src="https://esm.sh/app.tsx"></script>'), null);
  // 코드 예시(pre·code·textarea·주석), 링크, text/babel(브라우저 변환)은 보지 않는다.
  const lesson = [
    "<h1>React 수업</h1>",
    '<pre><code>import App from "./App.jsx";\n&lt;script type="module" src="/src/main.tsx"&gt;&lt;/script&gt;</code></pre>',
    '<code>import x from "./a.vue"</code>',
    '<textarea>import Y from "./y.svelte"</textarea>',
    '<!-- <script type="module" src="/src/main.jsx"></script> -->',
    '<a href="App.tsx">App.tsx 내려받기</a>',
    '<script type="text/babel" src="app.jsx"></script>',
    '<script src="quiz.js"></script>',
  ].join("\n");
  assert.equal(sourceModuleReference(lesson), null);
  assert.equal(sourceModuleReference(`${lesson}<script type="module" src="./src/main.tsx"></script>`), "./src/main.tsx");
});

test("packageBuildSignals: build 스크립트와 빌드 도구 의존성", () => {
  assert.deepEqual(packageBuildSignals({ scripts: { dev: "vite", build: "vite build" }, devDependencies: { vite: "^5" } }), {
    buildScript: true,
    tools: ["vite"],
  });
  assert.deepEqual(packageBuildSignals({ dependencies: { "react-scripts": "5" } }), { buildScript: false, tools: ["react-scripts"] });
  assert.deepEqual(packageBuildSignals({ scripts: { dev: "live-server" } }), { buildScript: false, tools: [] });
  assert.deepEqual(packageBuildSignals(null), { buildScript: false, tools: [] });
});

test("extOf / sitePathProblem / splitAllowedFiles", () => {
  assert.equal(extOf("a/b/Photo.JPG"), "jpg");
  assert.equal(extOf("README"), "");
  assert.equal(extOf("dir.v2/file"), "");
  assert.equal(sitePathProblem("index.html"), null);
  assert.equal(sitePathProblem("assets/한글 이름.png"), null);
  assert.ok(sitePathProblem("../x.html"));
  assert.ok(sitePathProblem("/abs.html"));
  assert.ok(sitePathProblem("C:/x.html"));
  assert.ok(sitePathProblem("a\\b.html"));
  assert.ok(sitePathProblem("a//b.html"));
  assert.ok(sitePathProblem(".env"));
  assert.ok(sitePathProblem("a\u0001.html"));
  const { keep, skipped } = splitAllowedFiles([{ path: "index.html" }, { path: "app.js.map" }, { path: "README" }, { path: "x.WOFF2" }]);
  assert.deepEqual(keep.map((f) => f.path), ["index.html", "x.WOFF2"]);
  assert.deepEqual(skipped.map((f) => f.path), ["app.js.map", "README"]);
});

test("siteLimitProblems: 루트 index.html, 개수·파일·합계 한도", () => {
  assert.deepEqual(siteLimitProblems([{ path: "index.html", size: 10 }]), []);
  assert.match(siteLimitProblems([{ path: "sub/index.html", size: 10 }])[0], /index.html/);
  const big = siteLimitProblems([{ path: "index.html", size: 10 }, { path: "v.mp4", size: SITE_LIMITS.fileBytes + 1 }]);
  assert.ok(big.some((p) => p.includes("v.mp4")));
  const many = Array.from({ length: SITE_LIMITS.fileCount + 1 }, (_, i) => ({ path: i === 0 ? "index.html" : `f${i}.txt`, size: 1 }));
  assert.ok(siteLimitProblems(many).some((p) => p.includes("1001")));
  const total = Array.from({ length: 5 }, (_, i) => ({ path: i === 0 ? "index.html" : `f${i}.png`, size: 5 * 1024 * 1024 }));
  assert.ok(siteLimitProblems(total).some((p) => p.includes("합계")));
});

test("scanSecrets: 텍스트 파일의 비밀값 패턴만 찾음, 안내는 허브 호스팅이 키를 둘 수 없다고 알려 줌", () => {
  const found = scanSecrets([
    { path: "index.html", bytes: enc("<p>hello</p>") },
    { path: "app.js", bytes: enc('const k = "sk-abcdefghijklmnopqrstuvwxyz123";') },
    { path: "cfg.json", bytes: enc('{"key":"dd_sk_123"}') },
    { path: "img.png", bytes: enc("dd_cli_in_binary_is_not_scanned") },
    { path: "k.txt", bytes: enc("-----BEGIN RSA PRIVATE KEY-----") },
    { path: "s.md", bytes: enc("service_role") },
  ]);
  assert.deepEqual(found.map((f) => f.path), ["app.js", "cfg.json", "k.txt", "s.md"]);
  assert.equal(scanSecrets([{ path: "SCRIPT", bytes: enc("dd_mat_x") }], { allText: true }).length, 1);
  assert.equal(scanSecrets([{ path: "bin", bytes: new Uint8Array([0, 118, 104]) }], { allText: true }).length, 0);
  // 허브와 같은 규칙: 새 형식 키(sk-proj-…, sk-ant-…)도 잡고, CSS 클래스 이름은 잡지 않는다.
  const modern = scanSecrets([
    { path: "a.js", bytes: enc('const k = "sk-proj-Ab3dEf6hIj9kLmN0pQr3StU6vWx9yZ";') },
    { path: "b.js", bytes: enc('const k = "sk-ant-api03-Ab3dEf6hIj9kLmN0pQr3StU6-xyz";') },
    { path: "c.css", bytes: enc(".sk-folding-cube-and-more-things { color: red }") },
    { path: "d.html", bytes: enc('<div class="task-abcdefghijklmnopqrstuvwxyz"></div>') },
  ]);
  assert.deepEqual(modern.map((f) => f.path), ["a.js", "b.js"]);
  const guidance = secretGuidance("http://hub:3100/");
  assert.equal(
    guidance,
    "Dandi 사이트 호스팅은 정적 파일만 제공하므로 키를 보관할 수 없습니다. AI 기능은 서버 프록시(http://hub:3100/downloads/ai-proxy-example.md)를 따로 배포해 publish --url로 등록하거나, AI 호출을 빼십시오. 키를 숨기거나 나눠서 검사를 피하지 마십시오.",
  );
  // 허브 hint에 이미 안내가 있으면 다시 붙이지 않고, 없으면 마침표 하나로 잇는다.
  assert.equal(withSecretGuidance(`app.js. ${guidance}`, "http://hub:3100"), `app.js. ${guidance}`);
  assert.equal(withSecretGuidance("비밀값을 지운 뒤 다시 올리십시오: app.js.", "http://hub:3100"), `비밀값을 지운 뒤 다시 올리십시오: app.js. ${guidance}`);
  assert.equal(withSecretGuidance(undefined, "http://hub:3100"), guidance);
});

test("buildFileManifest: 경로순 sha256·크기 목록", () => {
  assert.equal(sha256Hex(enc("hello")), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  const m = buildFileManifest([
    { path: "b.css", bytes: enc("") },
    { path: "a/index.html", bytes: enc("hello") },
  ]);
  assert.deepEqual(m, [
    { path: "a/index.html", size: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" },
    { path: "b.css", size: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  ]);
});

test("siteFolderCandidates: outputDir → dist → build → out → 현재 폴더", () => {
  assert.deepEqual(siteFolderCandidates(undefined), ["dist", "build", "out", "."]);
  assert.deepEqual(siteFolderCandidates("public"), ["public", "dist", "build", "out", "."]);
  assert.deepEqual(siteFolderCandidates("dist"), ["dist", "build", "out", "."]);
  assert.deepEqual(siteFolderCandidates(" "), ["dist", "build", "out", "."]);
});

test("isValidSlug: 계약 2-1 형식", () => {
  for (const s of ["quiz", "my-quiz-2", "a1b"]) assert.equal(isValidSlug(s), true, s);
  for (const s of ["ab", "-quiz", "quiz-", "my--quiz", "Quiz", "www", "admin", "a".repeat(31)]) assert.equal(isValidSlug(s), false, s);
});

/* ---------- 스킬 ---------- */

test("skill add: 계약의 npx skills add 명령 인자", () => {
  assert.deepEqual(parseAgentList(undefined), ["claude-code", "cursor", "codex", "antigravity-cli", "grok"]);
  assert.deepEqual(DEFAULT_SKILL_AGENTS, ["claude-code", "cursor", "codex", "antigravity-cli", "grok"]);
  assert.deepEqual(parseAgentList("antigravity,grok"), ["antigravity", "grok"]);
  assert.deepEqual(parseAgentList("claude-code, codex,codex"), ["claude-code", "codex"]);
  assert.equal(parseAgentList("claude code"), null);
  assert.equal(parseAgentList(""), null);
  assert.deepEqual(skillAddArgs("http://localhost:3000", "quiz-maker", ["claude-code", "cursor", "codex"]), [
    "-y", "skills@latest", "add", "http://localhost:3000/.well-known/agent-skills/quiz-maker", "--skill", "quiz-maker", "-a", "claude-code", "-a", "cursor", "-a", "codex", "--copy",
  ]);
  assert.deepEqual(skillAddArgs("https://h", "x", ["codex"], { global: true, yes: true }).slice(-3), ["--copy", "-g", "-y"]);
  assert.equal(isValidSkillName("quiz-maker"), true);
  assert.equal(isValidSkillName("Quiz"), false);
  assert.equal(isValidSkillName("a--b"), false);
  assert.equal(isShellSafeArg("http://localhost:3000"), true);
  assert.equal(isShellSafeArg("a&b"), false);
  assert.equal(isShellSafeArg("%PATH%"), false);
  assert.equal(isShellSafeArg("a b"), false);
});

test("setup: 배포 스킬을 다섯 도구에 확인 없이 설치하고 AI에게 보낼 문장을 준다", () => {
  assert.deepEqual(COMMAND_SPECS.setup, { flags: ["agent", "global"], maxArgs: 0 });
  assert.deepEqual(validateCommand(parseArgs(["setup"])), []);
  assert.deepEqual(validateCommand(parseArgs(["setup", "--agent", "codex,grok", "-g", "--json"])), []);
  assert.match(validateCommand(parseArgs(["setup", "extra"]))[0], /쓰지 않는 인자/);
  assert.match(validateCommand(parseArgs(["setup", "--title", "x"]))[0], /쓰지 않는 옵션/);
  assert.equal(SKILLS_PACKAGE, "skills@latest");
  assert.equal(DEPLOY_SKILL, "dandi-deploy");
  assert.deepEqual(skillAddArgs("http://localhost:3000/", DEPLOY_SKILL, DEFAULT_SKILL_AGENTS, { yes: true }), [
    "-y", "skills@latest", "add", "http://localhost:3000/.well-known/agent-skills/dandi-deploy", "--skill", "dandi-deploy",
    "-a", "claude-code", "-a", "cursor", "-a", "codex", "-a", "antigravity-cli", "-a", "grok", "--copy", "-y",
  ]);
  assert.ok(skillAddArgs("https://dandi.gne.go.kr", DEPLOY_SKILL, DEFAULT_SKILL_AGENTS, { yes: true }).every(isShellSafeArg));
  assert.equal(SETUP_PROMPT, "dandi-deploy 스킬로 이 폴더의 사이트를 Dandi에 올려 주십시오.");
  for (const part of ["제목:", "설명:", "학교급:", "분류:", "①", "⑤"]) assert.ok(ANSWERS_TEMPLATE.includes(part), part);
  const prefix = npxPrefix("http://localhost:3000", {});
  const json = helpJson(prefix, "http://localhost:3000") as { ok: boolean; commands: { name: string; command: string }[] };
  assert.ok(json.commands.some((c) => c.name === "setup" && c.command.startsWith(`${prefix} setup`)));
  const text = helpText(prefix, "http://localhost:3000");
  assert.ok(text.includes("setup [--agent <도구 목록>] [-g]"));
  assert.ok(text.includes("claude-code, cursor, codex, antigravity-cli, grok"));
  assert.ok(!text.includes("!"));
});

/* ---------- 배포물·도움말 ---------- */

test("cli/package.json: 이름·버전·bin·files가 CLI와 맞음(build-info.json은 pack-cli가 만듦)", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "cli", "package.json"), "utf8"));
  // npm의 "dandi"는 다른 사람의 패키지라 패키지 이름은 dandi-cli, 명령(bin) 이름은 dandi다.
  assert.equal(pkg.name, "dandi-cli");
  assert.equal(pkg.version, "0.2.0");
  assert.equal(pkg.version, CLI_VERSION);
  assert.equal(pkg.bin["dandi"], "dandi.mjs");
  for (const f of pkg.files) if (f !== "build-info.json") assert.ok(existsSync(path.join(ROOT, "cli", f)), f);
  for (const f of ["dandi.mjs", "lib.mjs", "core.mjs", "mcp.mjs", "build-info.json"]) assert.ok(pkg.files.includes(f), f);
  assert.ok(readFileSync(path.join(ROOT, "cli", "dandi.mjs"), "utf8").startsWith("#!/usr/bin/env node"));
});

test("builtinRunbook: 5KB 이하, 현재 허브의 npx 명령과 금지 규칙·새 안내 포함", () => {
  const prefix = npxPrefix("http://localhost:3000", {});
  const text = builtinRunbook("http://localhost:3000", prefix);
  assert.ok(Buffer.byteLength(text, "utf8") <= 5 * 1024, `${Buffer.byteLength(text, "utf8")} bytes`);
  assert.ok(text.includes(`${prefix} login --json`));
  assert.ok(text.includes(`${prefix} login --wait --json`));
  assert.ok(text.includes(`${prefix} deploy "<folder>" --json`));
  assert.ok(text.includes("Never answer the privacy questions yourself"));
  assert.ok(text.includes("①") && text.includes("⑤"));
  assert.ok(text.includes(APPROVAL_RULE));
  assert.match(text, /exit 6 \(denied\): ASK/);
  assert.match(text, /skipped/);
  assert.match(text, /Never obfuscate or split keys/);
  // 셸별 npx(Git Bash에서 npx.cmd를 권하지 않음), PowerShell 인코딩, publish 결과 필드
  assert.ok(text.includes("Git Bash·macOS·Linux: `npx` / Windows PowerShell·cmd: `npx.cmd`"));
  assert.ok(text.includes("[Console]::OutputEncoding=[Text.Encoding]::UTF8"));
  assert.match(text, /approved\|not_required\|pending/);
  assert.match(text, /kept_until_approval/);
  assert.match(text, /site_not_found: ASK the teacher about the account/);
});

test("helpText / helpJson: 이번 실행의 허브 주소와 명령 목록", () => {
  const prefix = npxPrefix("http://localhost:3100", {});
  const text = helpText(prefix, "http://localhost:3100");
  assert.ok(text.includes("허브: http://localhost:3100"));
  assert.ok(!text.includes("기본 허브: http://localhost:3000"));
  const psPrefix = withNpxCommand(prefix, process.platform === "win32" ? "npx.cmd" : "npx");
  assert.ok(text.includes(`PowerShell: $env:DANDI_TOKEN | ${psPrefix} login --token-stdin`), text);
  assert.ok(text.includes("--allow-source") && text.includes("--project <id>"));
  const json = helpJson(prefix, "http://localhost:3100") as { ok: boolean; hub: string; commands: { name: string; command: string }[]; exit_codes: Record<string, string> };
  assert.equal(json.ok, true);
  assert.equal(json.hub, "http://localhost:3100");
  assert.ok(json.commands.some((c) => c.name === "deploy" && c.command.startsWith(`${prefix} deploy`)));
  assert.ok(json.exit_codes["20"].includes("site_not_found"));
});
