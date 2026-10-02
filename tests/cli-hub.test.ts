// dandi CLI를 실제 프로세스로 실행해 가짜 허브(node:http)와 주고받는 흐름을 확인한다.
// 가짜 허브는 계약 2-3(사이트 3단계 업로드·publish), 3-1(device code), 6(스킬) API만 흉내 낸다.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { CLI_BUILD, CLI_TAG, secretGuidance, shellArg } from "../cli/lib.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "cli", "dandi.mjs");
const TOKEN = "dd_cli_FAKEHUBTOKEN_abcdefghijklmnop";
const RUNBOOK = "# Dandi (fake hub)\n\n1. whoami\n2. login\n";
const USER = { name: "김교사", role: "teacher", schoolLevel: "middle" };

/* ---------- 가짜 허브 ---------- */

type Json = Record<string, unknown>;
type DeviceState = { status: "pending" | "approved" | "denied" | "expired" | "consumed"; userCode: string; body: Json; polls: number };
type FileEntry = { path: string; size: number; sha256: string };
type Deploy = { id: string; siteId: string; files: FileEntry[]; upload: string[]; received: Map<string, Buffer>; finalized: boolean };
type SiteState = { appId: string | null; approvalStatus: string | null; projectId: string; live: boolean; approvedAnswers: string | null };

const hub = {
  base: "",
  seq: 0,
  siteSeq: 0,
  sites: new Map<string, SiteState>(),
  devices: new Map<string, DeviceState>(),
  lastDeviceCode: "",
  deploys: new Map<string, Deploy>(),
  deployBodies: [] as Json[],
  knownHashes: new Set<string>(),
  publishBodies: [] as Json[],
  appsBodies: [] as Json[],
  skillBodies: [] as Json[],
  skillQueries: [] as string[],
  puts: 0,
  latest: null as Json | null,
};
let server: http.Server;

function send(res: http.ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function apiErr(res: http.ServerResponse, status: number, code: string, message: string, hint?: string) {
  send(res, status, { error: { code, message, ...(hint ? { hint } : {}) } });
}

function authed(req: http.IncomingMessage) {
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const PREVIEW = "http://quiz--abcde12345.localhost:3000/";
const LIVE = "http://quiz.localhost:3000/";
// 허브(src/lib/sites.ts publishMessage)가 돌려주는 문장과 같은 뜻의 가짜 문장
const MSG_PUBLIC = "허브에 미니앱으로 등록했습니다. 공개 주소가 이 버전을 보여 줍니다.";
const MSG_APPROVAL_KEPT = "셀프점검 답이 학교 내부 승인을 받을 때와 같아 승인 완료 상태를 유지했습니다. 공개 주소를 새 버전으로 바꿨습니다.";
const MSG_KEPT_PREVIOUS =
  "셀프점검 답이 승인받을 때와 달라져 새 버전은 학교 내부 승인을 다시 받아야 합니다. 승인 완료를 표시할 때까지 공개 주소는 이전에 공개한 버전을 계속 보여 주고, 표시하면 새 버전으로 바뀝니다. 승인 대기 동안 이 앱은 허브 목록에서 빠집니다.";
const MSG_AWAITING = "학교 내부 승인이 필요하다고 답했으므로 승인 대기 상태로 등록했습니다.";

/** 교사가 허브에서 학교 내부 승인 완료를 표시한 것처럼 만든다. */
function approveSite(siteId: string, answers: unknown) {
  const site = hub.sites.get(siteId);
  assert.ok(site, siteId);
  site.approvedAnswers = JSON.stringify(answers);
  site.approvalStatus = "approved";
  site.live = true;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", hub.base);
  const body = await readBody(req);
  const json = (): Json => (body.length ? (JSON.parse(body.toString("utf8")) as Json) : {});
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /llms.txt") {
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" }).end(RUNBOOK);
    return;
  }
  if (route === "GET /dandi-latest.json") {
    if (!hub.latest) return send(res, 404, { error: "not found" });
    return send(res, 200, hub.latest);
  }
  if (route === "POST /api/cli/device/start") {
    const n = ++hub.seq;
    const deviceCode = `dd_dev_fake_${n}_secret`;
    const userCode = `BCDF-${"GHJK".slice(0, 3)}${"LMNPQRSTVWXZ"[n % 12]}`;
    hub.devices.set(deviceCode, { status: "pending", userCode, body: json(), polls: 0 });
    hub.lastDeviceCode = deviceCode;
    send(res, 200, {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${hub.base}/device`,
      verification_uri_complete: `${hub.base}/device?code=${userCode}`,
      expires_in: 600,
      interval: 1,
    });
    return;
  }
  if (route === "POST /api/cli/device/token") {
    const d = hub.devices.get(String(json().device_code));
    if (!d || d.status === "consumed") return send(res, 400, { error: "invalid_grant" });
    d.polls++;
    if (d.status === "pending") return send(res, 400, { error: "authorization_pending" });
    if (d.status === "denied") return send(res, 400, { error: "access_denied" });
    if (d.status === "expired") return send(res, 400, { error: "expired_token" });
    d.status = "consumed";
    return send(res, 200, { token: TOKEN, user: USER });
  }
  if (route === "GET /api/cli/whoami") {
    if (!authed(req)) return send(res, 401, { error: "CLI 토큰이 없거나 유효하지 않습니다." });
    return send(res, 200, USER);
  }
  if (route === "GET /api/skills") {
    hub.skillQueries.push(url.searchParams.get("q") ?? "");
    return send(res, 200, {
      skills: [
        {
          name: "quiz-maker",
          title: "퀴즈 만들기",
          description: "수업용 퀴즈를 만듭니다.",
          installs: 3,
          latestVersion: "1.0.0",
          hasScripts: false,
          status: "approved",
          installCommand: `npx -y skills add ${hub.base} --skill quiz-maker -a claude-code -a cursor -a codex --copy`,
        },
      ],
    });
  }
  if (route === "GET /api/skills/quiz-maker") {
    return send(res, 200, { name: "quiz-maker", title: "퀴즈 만들기", description: "수업용 퀴즈", skillMd: "---\nname: quiz-maker\n---\n# 퀴즈" });
  }

  // 여기부터는 로그인이 필요한 API
  if (!authed(req)) return apiErr(res, 401, "invalid_token", "토큰이 없거나 만료·폐기되었습니다.");

  if (route === "POST /api/sites/deploys") {
    const b = json();
    hub.deployBodies.push(b);
    let siteId: string;
    if (b.siteId !== undefined) {
      siteId = String(b.siteId);
      const existing = hub.sites.get(siteId);
      if (!existing) return apiErr(res, 404, "site_not_found", "사이트를 찾을 수 없습니다.", "siteId를 확인하십시오.");
      // 계약(결정 5): 기존 사이트는 moveToProject가 true일 때만 옮기고, 아니면 projectId를 무시한다(409를 내지 않음).
      if (b.moveToProject === true && typeof b.projectId === "string") existing.projectId = b.projectId;
    } else {
      siteId = `site_${++hub.siteSeq}`;
      const projectId = typeof b.projectId === "string" ? b.projectId : "prj_default";
      hub.sites.set(siteId, { appId: null, approvalStatus: null, projectId, live: false, approvedAnswers: null });
    }
    const files = b.files as FileEntry[];
    const id = `dep_${++hub.seq}`;
    const upload = files.filter((f) => !hub.knownHashes.has(f.sha256)).map((f) => f.path);
    hub.deploys.set(id, { id, siteId, files, upload, received: new Map(), finalized: false });
    return send(res, 201, { deployId: id, siteId, slug: "quiz", projectId: hub.sites.get(siteId)?.projectId, upload });
  }
  const put = /^PUT \/api\/sites\/deploys\/([^/]+)\/files$/.exec(route);
  if (put) {
    const d = hub.deploys.get(put[1]);
    const p = url.searchParams.get("path") ?? "";
    const entry = d?.files.find((f) => f.path === p);
    if (!d || !entry) return apiErr(res, 404, "not_found", "배포나 파일을 찾을 수 없습니다.");
    const sha = createHash("sha256").update(body).digest("hex");
    if (sha !== entry.sha256 || body.length !== entry.size) return apiErr(res, 400, "hash_mismatch", "크기나 해시가 다릅니다.", p);
    hub.puts++;
    d.received.set(p, body);
    hub.knownHashes.add(sha);
    return send(res, 204);
  }
  const fin = /^POST \/api\/sites\/deploys\/([^/]+)\/finalize$/.exec(route);
  if (fin) {
    const d = hub.deploys.get(fin[1]);
    if (!d) return apiErr(res, 404, "not_found", "배포를 찾을 수 없습니다.");
    const missing = d.upload.filter((p) => !d.received.has(p));
    if (missing.length) return apiErr(res, 409, "missing_files", "빠진 파일이 있습니다.", missing.join(", "));
    // 서버만 알아채는 비밀값(CLI 검사를 통과한 파일)을 흉내 낸다.
    const rejected = [...d.received.entries()].find(([, buf]) => buf.toString("utf8").includes("SERVER_REJECT"));
    if (rejected) {
      // 새 허브는 hint에 공통 안내를 이미 넣는다(SERVER_REJECT_FULL). 예전 허브는 경로만 준다.
      const full = rejected[1].toString("utf8").includes("SERVER_REJECT_FULL");
      const hint = full ? `비밀값을 지운 뒤 다시 올리십시오: "${rejected[0]}". ${secretGuidance(hub.base)}` : rejected[0];
      return apiErr(res, 422, "secret_detected", "비밀값으로 보이는 내용이 있어 거부했습니다.", hint);
    }
    d.finalized = true;
    return send(res, 200, {
      siteId: d.siteId,
      deployId: d.id,
      slug: "quiz",
      projectId: hub.sites.get(d.siteId)?.projectId,
      previewUrl: PREVIEW,
      status: "preview",
      warnings: [{ path: "index.html", kind: "mobile", message: "휴대전화번호로 보이는 내용이 있습니다." }],
    });
  }
  const pub = /^POST \/api\/sites\/([^/]+)\/publish$/.exec(route);
  if (pub) {
    const b = json();
    hub.publishBodies.push(b);
    const site = hub.sites.get(pub[1]);
    if (!site) return apiErr(res, 404, "site_not_found", "사이트를 찾을 수 없습니다.");
    if (!b.privacyCheck) return apiErr(res, 422, "invalid_publish", "셀프점검이 필요합니다.");
    const appId = pub[1] === "site_1" ? "app_site" : `app_${pub[1]}`;
    site.appId = appId;
    const answers = JSON.stringify(b.privacyCheck);
    let approvalStatus: string;
    let liveVersion: string;
    let message: string;
    if (!(b.privacyCheck as Json).needsSchoolApproval) {
      [approvalStatus, liveVersion, message] = ["not_required", "updated", MSG_PUBLIC];
      site.live = true;
    } else if (site.approvedAnswers === answers) {
      [approvalStatus, liveVersion, message] = ["approved", "updated", MSG_APPROVAL_KEPT];
      site.live = true;
    } else {
      [approvalStatus, liveVersion, message] = ["pending", "kept_until_approval", site.live ? MSG_KEPT_PREVIOUS : MSG_AWAITING];
    }
    site.approvalStatus = approvalStatus;
    return send(res, 200, {
      appId,
      appUrl: `${hub.base}/apps/${appId}`,
      liveUrl: LIVE,
      previewUrl: PREVIEW,
      approvalStatus,
      liveVersion,
      message,
    });
  }
  if (route === "POST /api/cli/apps") {
    const b = json();
    hub.appsBodies.push(b);
    return send(res, 201, { id: "app_ext", url: "/apps/app_ext", title: b.title, approvalStatus: "not_required" });
  }
  if (route === "GET /api/sites") {
    return send(res, 200, {
      sites: [...hub.sites.entries()].map(([id, s]) => ({
        id,
        slug: "quiz",
        title: "퀴즈",
        projectId: s.projectId,
        liveUrl: s.appId ? LIVE : null,
        previewUrl: PREVIEW,
        appId: s.appId,
        approvalStatus: s.approvalStatus,
        updatedAt: new Date().toISOString(),
      })),
    });
  }
  if (route === "POST /api/skills") {
    const b = json();
    hub.skillBodies.push(b);
    return send(res, 201, { name: "quiz-maker", version: "1.0.1", status: "pending_review", findings: ["scripts/ 폴더 포함"], url: `${hub.base}/skills/quiz-maker` });
  }
  apiErr(res, 404, "not_found", `없는 경로: ${route}`);
}

function setDevice(status: DeviceState["status"]) {
  const d = hub.devices.get(hub.lastDeviceCode);
  assert.ok(d, "시작한 로그인 요청이 없음");
  d.status = status;
}

/* ---------- CLI 실행 도우미 ---------- */

let tmp = "";
const AGENT_VARS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "AI_AGENT", "CODEX_SANDBOX", "CODEX_CI", "CODEX_THREAD_ID", "CURSOR_AGENT", "GEMINI_CLI"];

/**
 * CLI 실행 환경. 기본은 Git Bash처럼 MSYSTEM을 넣는다(Windows에서도 안내 명령은 npx, --json은 UTF-8 그대로).
 * Windows PowerShell·cmd를 흉내 내려면 powershellEnv를 쓴다.
 */
function env(cfg: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || AGENT_VARS.includes(k) || k.startsWith("DANDI_") || k === "MSYSTEM") continue;
    out[k] = v;
  }
  return {
    ...out,
    MSYSTEM: "MINGW64",
    DANDI_CONFIG_DIR: path.join(tmp, cfg),
    DANDI_HUB: hub.base,
    DANDI_NO_BROWSER: "1",
    ...extra,
  } as unknown as NodeJS.ProcessEnv;
}

/** MSYSTEM이 없는 환경(Windows에서는 PowerShell·cmd로 실행한 것과 같다). */
function powershellEnv(cfg: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e = env(cfg, extra) as Record<string, string>;
  delete e.MSYSTEM;
  return e as unknown as NodeJS.ProcessEnv;
}

type Run = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], opts: { cwd?: string; cfg?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? tmp,
      env: opts.env ?? env(opts.cfg ?? "cfg-main"),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
}

/** --json 출력은 stdout에 JSON 한 줄이어야 한다(기본은 UTF-8 그대로, ascii면 한글을 \uXXXX로). */
function onlyJson(r: Run, { ascii = false }: { ascii?: boolean } = {}): Json {
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `stdout은 JSON 한 줄이어야 함: ${r.stdout}${r.stderr}`);
  if (ascii) assert.match(lines[0], /^[\x20-\x7e]*$/, "JSON 출력에 ASCII가 아닌 문자가 있음");
  return JSON.parse(lines[0]) as Json;
}

function noSecrets(r: Run) {
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), "토큰이 출력에 나옴");
  assert.ok(!/dd_dev_fake_\d+_secret/.test(r.stdout + r.stderr), "device_code가 출력에 나옴");
}

function put(rel: string, content: string | Uint8Array) {
  const abs = path.join(tmp, ...rel.split("/"));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const readJson = (rel: string) => JSON.parse(readFileSync(path.join(tmp, ...rel.split("/")), "utf8")) as Json;
const writeJson = (rel: string, value: unknown) => writeFileSync(path.join(tmp, ...rel.split("/")), JSON.stringify(value, null, 2));
const PREFIX = () => `npx -y ${hub.base}/${CLI_BUILD.tarball}`;
/** MSYSTEM 없는 셸의 접두어: Windows PowerShell·cmd는 npx.cmd, 그 밖에는 npx */
const PS_PREFIX = () => `${process.platform === "win32" ? "npx.cmd" : "npx"} -y ${hub.base}/${CLI_BUILD.tarball}`;
const ANSWERS = {
  collectsStudentData: false,
  storageLocation: "저장 안 함",
  retention: "저장 안 함",
  externalTransfer: false,
  needsSchoolApproval: false,
};

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "vh-cli-hub-"));
  server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500).end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hub.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(tmp, { recursive: true, force: true });
});

/* ---------- 로그인 ---------- */

test("login --json: 승인 링크·코드를 JSON 한 개로 출력하고 종료 코드 5(대기, done:false)", async () => {
  const r = await runCli(["login", "--json"]);
  assert.equal(r.code, 5, r.stderr);
  const out = onlyJson(r);
  assert.deepEqual(Object.keys(out), [
    "ok", "status", "done", "user_code", "verification_uri", "verification_uri_complete", "expires_in", "next_step", "agent_instructions",
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.status, "pending");
  assert.equal(out.done, false);
  assert.match(String(out.user_code), /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.equal(out.verification_uri_complete, `${hub.base}/device?code=${out.user_code}`);
  assert.equal(out.next_step, `${PREFIX()} login --wait --json`);
  noSecrets(r);
  // device_code는 pending.json(0600)에만 저장된다.
  const pending = readJson("cfg-main/pending.json");
  assert.equal(pending.device_code, hub.lastDeviceCode);
  assert.equal(existsSync(path.join(tmp, "cfg-main", "config.json")), false);
  const started = hub.devices.get(hub.lastDeviceCode)?.body ?? {};
  assert.equal(started.client, "non-interactive");
  assert.equal(typeof started.hostname, "string");
});

test("login 에이전트 환경: --json 없이도 JSON, 도구 이름은 claude-code", async () => {
  const r = await runCli(["login"], { env: env("cfg-agent", { CLAUDECODE: "1" }) });
  assert.equal(r.code, 5);
  assert.equal(onlyJson(r).status, "pending");
  assert.equal(hub.devices.get(hub.lastDeviceCode)?.body.client, "claude-code");
});

test("login --wait: 승인 전이면 --timeout 뒤 종료 코드 5와 같은 코드", async () => {
  const code = readJson("cfg-main/pending.json").user_code;
  const r = await runCli(["login", "--wait", "--json", "--timeout", "1"]);
  assert.equal(r.code, 5, r.stdout + r.stderr);
  const out = onlyJson(r);
  assert.equal(out.status, "pending");
  assert.equal(out.done, false);
  assert.equal(out.user_code, code);
  assert.equal(out.next_step, `${PREFIX()} login --wait --json`);
});

test("login --wait: 승인되면 토큰을 저장하고 종료 코드 0, 출력에는 토큰이 없음", async () => {
  // login --json 테스트가 cfg-main에 만든 요청을 다시 찾아 승인한다.
  hub.lastDeviceCode = String(readJson("cfg-main/pending.json").device_code);
  setDevice("approved");
  const r = await runCli(["login", "--wait", "--json"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = onlyJson(r);
  assert.equal(out.status, "logged_in");
  assert.equal(out.done, true);
  assert.deepEqual(out.user, USER);
  noSecrets(r);
  const cfg = readJson("cfg-main/config.json");
  assert.equal(cfg.token, TOKEN);
  assert.equal(cfg.hub, hub.base);
  assert.equal(existsSync(path.join(tmp, "cfg-main", "pending.json")), false);
});

test("login: 저장된 토큰이 아직 유효하면 새 승인 요청 없이 logged_in(종료 코드 0), --force면 새로 로그인", async () => {
  const devices = hub.devices.size;
  const again = await runCli(["login", "--json"]);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  const out = onlyJson(again);
  assert.equal(out.status, "logged_in");
  assert.equal(out.already, true);
  assert.deepEqual(out.user, USER);
  assert.equal(hub.devices.size, devices, "새 로그인 요청을 만들면 안 됨");

  const envToken = env("cfg-force", { DANDI_TOKEN: TOKEN });
  assert.equal((await runCli(["login", "--json"], { env: envToken })).code, 0);
  const forced = await runCli(["login", "--json", "--force"], { env: envToken });
  assert.equal(forced.code, 5, forced.stdout + forced.stderr);
  assert.equal(onlyJson(forced).status, "pending");
  assert.equal(hub.devices.size, devices + 1);

  // 토큰이 폐기되었으면 새로 로그인을 시작한다.
  const revoked = await runCli(["login", "--json"], { env: env("cfg-revoked", { DANDI_TOKEN: "dd_cli_revoked" }) });
  assert.equal(revoked.code, 5);
});

test("whoami: JSON(기본 UTF-8, Windows PowerShell·cmd나 DANDI_JSON_ASCII=1이면 ASCII)과 사람용 출력", async () => {
  const j = await runCli(["whoami", "--json"]);
  assert.equal(j.code, 0);
  assert.deepEqual(onlyJson(j), { ok: true, status: "logged_in", hub: hub.base, user: USER });
  // 기본은 UTF-8 그대로(에이전트가 한국어를 그대로 읽는다)
  assert.ok(j.stdout.includes("김교사"), j.stdout);
  // DANDI_JSON_ASCII=1이면 어디서나 \uXXXX
  const ascii = await runCli(["whoami", "--json"], { env: env("cfg-main", { DANDI_JSON_ASCII: "1" }) });
  assert.deepEqual(onlyJson(ascii, { ascii: true }).user, USER);
  assert.ok(ascii.stdout.includes("\\uae40\\uad50\\uc0ac"), ascii.stdout);
  // MSYSTEM이 없는 Windows(PowerShell·cmd)는 \uXXXX, 다른 OS는 UTF-8 그대로
  const ps = await runCli(["whoami", "--json"], { env: powershellEnv("cfg-main") });
  assert.deepEqual(onlyJson(ps, { ascii: process.platform === "win32" }).user, USER);
  assert.equal(ps.stdout.includes("김교사"), process.platform !== "win32");
  const h = await runCli(["whoami"]);
  assert.equal(h.code, 0);
  assert.ok(h.stdout.includes("김교사 (교사 · 중)"));
  noSecrets(h);
  const bad = await runCli(["whoami", "--json"], { env: env("cfg-none", { DANDI_TOKEN: "dd_cli_invalid" }) });
  assert.equal(bad.code, 4);
  // /api/cli/whoami는 v0.1 오류 형식({ error: "문장" })이라 상태 코드로 code를 정한다.
  assert.equal((onlyJson(bad).error as Json).code, "unauthorized");
  const none = await runCli(["whoami"], { cfg: "cfg-none" });
  assert.equal(none.code, 4);
  assert.match(none.stderr, /다음 실행: .*login/);
});

test("whoami·guide: 허브의 최신 CLI(/dandi-latest.json)와 태그가 다르면 새 접두어를 알려 줌", async () => {
  hub.latest = { version: "0.2.0", tag: "0.2.0-deadbeef", tarball: "dandi-0.2.0-deadbeef.tgz" };
  try {
    const who = await runCli(["whoami", "--json"]);
    assert.equal(who.code, 0);
    const out = onlyJson(who);
    assert.deepEqual(out.cli_update, { current: CLI_TAG, latest: "0.2.0-deadbeef", prefix: `npx -y ${hub.base}/dandi-0.2.0-deadbeef.tgz` });
    assert.match(String(out.agent_instructions), /cli_update\.prefix/);

    const guide = await runCli(["guide"]);
    assert.equal(guide.code, 0);
    assert.equal(guide.stdout, RUNBOOK);
    assert.ok(guide.stderr.includes(`npx -y ${hub.base}/dandi-0.2.0-deadbeef.tgz`), guide.stderr);
    const guideJson = onlyJson(await runCli(["guide", "--json"]));
    assert.equal((guideJson.cli_update as Json).latest, "0.2.0-deadbeef");

    hub.latest = { version: "0.2.0", tag: CLI_TAG, tarball: CLI_BUILD.tarball };
    const same = onlyJson(await runCli(["whoami", "--json"]));
    assert.equal("cli_update" in same, false);
  } finally {
    hub.latest = null;
  }
});

test("login: 거부되면 종료 코드 6(바로 다시 시작하지 않고 교사에게 묻기), 만료되면 7, 기다릴 요청이 없으면 4", async () => {
  assert.equal((await runCli(["login", "--json"], { cfg: "cfg-deny" })).code, 5);
  setDevice("denied");
  const denied = await runCli(["login", "--wait", "--json"], { cfg: "cfg-deny" });
  assert.equal(denied.code, 6);
  const d = onlyJson(denied);
  assert.equal((d.error as Json).code, "access_denied");
  assert.equal("next_step" in d, false, "거부 뒤에는 next_step이 없어야 함");
  assert.match(String(d.agent_instructions), /ASK the teacher whether they want to log in/);
  assert.ok(String(d.agent_instructions).includes(`${PREFIX()} login --json`));

  assert.equal((await runCli(["login", "--json"], { cfg: "cfg-deny" })).code, 5);
  setDevice("expired");
  const expired = await runCli(["login", "--wait", "--json"], { cfg: "cfg-deny" });
  assert.equal(expired.code, 7);
  const e = onlyJson(expired);
  assert.equal((e.error as Json).code, "expired_token");
  assert.equal(e.next_step, `${PREFIX()} login --json`);

  const nothing = await runCli(["login", "--wait", "--json"], { cfg: "cfg-deny" });
  assert.equal(nothing.code, 4);
  assert.equal((onlyJson(nothing).error as Json).code, "no_pending_login");
});

test("허브에 연결하지 못하면 next_step 없이 교사에게 허브 실행·주소 확인을 부탁하라고 안내", async () => {
  const offline = env("cfg-offline", { DANDI_HUB: "http://127.0.0.1:9" });
  const r = await runCli(["login", "--json"], { env: offline });
  assert.equal(r.code, 1);
  const out = onlyJson(r);
  assert.equal((out.error as Json).code, "network_error");
  assert.equal("next_step" in out, false);
  assert.match(String(out.agent_instructions), /ask them to start the hub or check the hub address/);
  const human = await runCli(["login"], { env: offline });
  assert.equal(human.code, 1);
  assert.doesNotMatch(human.stderr, /다음 실행/);
});

test("login <token> 위치 인자는 종료 코드 2와 bash·PowerShell --token-stdin 안내, --token-stdin은 표준입력 토큰으로 로그인", async () => {
  const positional = await runCli(["login", TOKEN], { cfg: "cfg-stdin" });
  assert.equal(positional.code, 2);
  assert.match(positional.stderr, /--token-stdin/);
  assert.ok(positional.stderr.includes(`bash: printf %s "$DANDI_TOKEN" | ${PREFIX()} login --token-stdin`), positional.stderr);
  assert.ok(positional.stderr.includes(`PowerShell: $env:DANDI_TOKEN | ${PS_PREFIX()} login --token-stdin`), positional.stderr);
  noSecrets(positional);

  const ok = await runCli(["login", "--token-stdin", "--json"], { cfg: "cfg-stdin", input: `${TOKEN}\n` });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(onlyJson(ok).status, "logged_in");
  assert.equal(readJson("cfg-stdin/config.json").token, TOKEN);
  noSecrets(ok);

  // PowerShell 5.1이 파이프로 보낸 BOM이 붙어도 받는다.
  const bom = await runCli(["login", "--token-stdin", "--json"], { cfg: "cfg-stdin-bom", input: `﻿${TOKEN}\r\n` });
  assert.equal(bom.code, 0, bom.stdout + bom.stderr);

  const wrong = await runCli(["login", "--token-stdin"], { cfg: "cfg-stdin2", input: "dd_cli_wrong\n" });
  assert.equal(wrong.code, 4);
  const notToken = await runCli(["login", "--token-stdin"], { cfg: "cfg-stdin2", input: "hello\n" });
  assert.equal(notToken.code, 2);
  const empty = await runCli(["login", "--token-stdin"], { cfg: "cfg-stdin2", input: "" });
  assert.equal(empty.code, 2);
  assert.ok(empty.stderr.includes("PowerShell: $env:DANDI_TOKEN |"), empty.stderr);

  const out = await runCli(["logout", "--json"], { cfg: "cfg-stdin" });
  assert.equal(out.code, 0);
  assert.equal(existsSync(path.join(tmp, "cfg-stdin", "config.json")), false);
  assert.equal((await runCli(["logout"], { cfg: "cfg-stdin" })).code, 4);
});

test("help: 이번 실행의 허브 주소, help --json은 JSON, 사용법 오류의 next_step은 help --json", async () => {
  const human = await runCli(["help"]);
  assert.equal(human.code, 0);
  assert.ok(human.stdout.includes(`허브: ${hub.base}`), human.stdout);
  assert.ok(human.stdout.includes(PREFIX()));
  const json = onlyJson(await runCli(["help", "--json"]));
  assert.equal(json.hub, hub.base);
  assert.equal(json.prefix, PREFIX());
  assert.ok(Array.isArray(json.commands));
  const bogus = await runCli(["bogus-cmd", "--json"]);
  assert.equal(bogus.code, 2);
  assert.equal(onlyJson(bogus).next_step, `${PREFIX()} help --json`);
  const version = onlyJson(await runCli(["--version", "--json"]));
  assert.deepEqual(version, { ok: true, version: "0.2.0", tag: CLI_TAG });
});

test("next_step은 실행한 셸에 맞는 npx: Git Bash(MSYSTEM)는 npx, Windows PowerShell·cmd는 npx.cmd", async () => {
  const bash = onlyJson(await runCli(["deploy", "--json"], { cwd: tmp, env: env("cfg-none") }));
  assert.equal(bash.next_step, `${PREFIX()} login --json`);
  const ps = await runCli(["deploy", "--json"], { cwd: tmp, env: powershellEnv("cfg-none") });
  assert.equal(ps.code, 4);
  assert.equal(onlyJson(ps).next_step, `${PS_PREFIX()} login --json`);
  const help = onlyJson(await runCli(["help", "--json"], { env: powershellEnv("cfg-none") }));
  assert.equal(help.prefix, PS_PREFIX());
});

/* ---------- deploy / publish ---------- */

test("deploy: 3단계 업로드, 제외 규칙, dandi.json에 siteId·lastDeployId·outputDir·projectId 기록", async () => {
  put("proj/dist/index.html", "<h1>퀴즈</h1>");
  put("proj/dist/app.js", "console.log('quiz')");
  put("proj/dist/img/logo.png", new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
  put("proj/dist/app.js.map", "{}");
  put("proj/dist/.env", "SECRET=1");
  put("proj/dist/node_modules/x/index.js", "x");
  put("proj/src/main.js", "not uploaded");

  const r = await runCli(["deploy", "--json", "--slug", "my-quiz"], { cwd: path.join(tmp, "proj") });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = onlyJson(r);
  assert.equal(out.status, "preview");
  assert.equal(out.siteId, "site_1");
  assert.equal(out.previewUrl, PREVIEW);
  assert.equal(out.preview_url, out.previewUrl);
  assert.equal(out.uploaded, 3);
  assert.equal(out.projectId, "prj_default");
  assert.equal(out.next_step, `${PREFIX()} publish --json`);
  assert.equal(out.published, null);
  assert.match(String(out.message), /아직 허브에 공개되지 않았습니다/);
  assert.deepEqual((out.skipped as Json[]).map((s) => s.path), ["app.js.map"]);
  // 서버의 개인정보 경고 + 올리지 않은 파일 경고
  const warnings = out.warnings as Json[];
  assert.deepEqual(warnings.map((w) => w.kind), ["mobile", "skipped"]);
  assert.match(String(warnings[1].message), /자료실/);
  // 올리지 않은 파일은 교사에게 알리고, 등록 전에 모든 항목을 한 번에 묻게 한다.
  assert.match(String(out.agent_instructions), /NOT uploaded: app\.js\.map/);
  assert.match(String(out.agent_instructions), /ASK the teacher in ONE message/);
  assert.equal((out.privacy_questions as string[]).length, 5);
  for (const k of ["title", "description", "schoolLevels", "category", "privacyCheck.collectsStudentData"]) {
    assert.ok((out.missing as string[]).includes(k), k);
  }
  noSecrets(r);

  const body = hub.deployBodies.at(-1) ?? {};
  assert.equal(body.slug, "my-quiz");
  assert.equal(body.title, "proj");
  assert.equal(body.siteId, undefined);
  assert.deepEqual((body.files as FileEntry[]).map((f) => f.path), ["app.js", "img/logo.png", "index.html"]);
  const deploy = hub.deploys.get(String(out.deployId));
  assert.equal(deploy?.finalized, true);
  assert.equal(deploy?.received.get("index.html")?.toString("utf8"), "<h1>퀴즈</h1>");

  const manifest = readJson("proj/dandi.json");
  assert.equal(manifest.siteId, "site_1");
  assert.equal(manifest.lastDeployId, out.deployId);
  assert.equal(manifest.outputDir, "dist");
  assert.equal(manifest.projectId, "prj_default");
  assert.equal(manifest.title, "");
  assert.deepEqual(manifest.schoolLevels, []);
  assert.equal(manifest.category, "");
  assert.equal((manifest.privacyCheck as Json).collectsStudentData, null);
});

test("deploy 다시 실행: 같은 사이트로, 허브에 있는 파일은 보내지 않음, 미리보기 주소는 한 줄에 따로", async () => {
  const putsBefore = hub.puts;
  const r = await runCli(["deploy"], { cwd: path.join(tmp, "proj") });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(hub.puts, putsBefore);
  assert.equal(hub.deployBodies.at(-1)?.siteId, "site_1");
  const lines = r.stdout.split(/\r?\n/);
  assert.ok(lines.includes(PREVIEW), r.stdout);
  assert.ok(lines.some((l) => l === `다음 실행: ${PREFIX()} publish`), r.stdout);
  assert.ok(lines.some((l) => l.includes("app.js.map") && l.includes("올리지 않은 파일")), r.stdout);
});

test("deploy: 비밀값이 있으면 종료 코드 20, 허브에 보내지 않고 next_step은 그 폴더를 다시 올리는 명령", async () => {
  put("leaky/index.html", '<script>const k = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";</script>');
  const count = hub.deployBodies.length;
  const r = await runCli(["deploy", ".", "--json"], { cwd: path.join(tmp, "leaky") });
  assert.equal(r.code, 20);
  const out = onlyJson(r);
  const err = out.error as Json;
  assert.equal(err.code, "secret_detected");
  assert.match(String(err.hint), /index\.html/);
  assert.match(String(err.hint), /ai-proxy-example\.md/);
  assert.equal(out.next_step, `${PREFIX()} deploy . --json`);
  assert.match(String(out.agent_instructions), /Never obfuscate/);
  assert.equal(hub.deployBodies.length, count);

  // 한글·공백이 있는 폴더는 큰따옴표로 감싼다(bash·PowerShell 모두 그대로 실행됨).
  put("kor/내 퀴즈 사이트/index.html", '<script>const k = "dd_sk_abcdef";</script>');
  const kor = await runCli(["deploy", "내 퀴즈 사이트", "--json"], { cwd: path.join(tmp, "kor") });
  assert.equal(kor.code, 20);
  assert.equal(onlyJson(kor).next_step, `${PREFIX()} deploy "내 퀴즈 사이트" --json`);

  // 새 형식 키(sk-proj-…)도 허브로 보내기 전에 잡는다(허브와 같은 규칙).
  put("leaky2/app.js", 'const k = "sk-proj-Ab3dEf6hIj9kLmN0pQr3StU6vWx9yZ";');
  put("leaky2/index.html", '<script src="app.js"></script>');
  const modern = await runCli(["deploy", ".", "--json"], { cwd: path.join(tmp, "leaky2") });
  assert.equal(modern.code, 20);
  assert.equal((onlyJson(modern).error as Json).code, "secret_detected");
  assert.equal(hub.deployBodies.length, count);
});

test("deploy: index.html이 있는 폴더를 못 찾으면 종료 코드 2, next_step 대신 next_step_template", async () => {
  put("noindex/page.html", "<p>x</p>");
  const noIndex = await runCli(["deploy", "--json"], { cwd: path.join(tmp, "noindex") });
  assert.equal(noIndex.code, 2);
  const out = onlyJson(noIndex);
  assert.equal((out.error as Json).code, "missing_index");
  assert.match(String((out.error as Json).hint), /dist, build, out, 현재 폴더/);
  assert.equal("next_step" in out, false);
  assert.equal(out.next_step_template, `${PREFIX()} deploy "<폴더>" --json`);
  const human = await runCli(["deploy"], { cwd: path.join(tmp, "noindex") });
  assert.equal(human.code, 2);
  assert.ok(human.stderr.includes(`${PREFIX()} deploy "<폴더>" --json`));

  const missingDir = await runCli(["deploy", "없는 폴더", "--json"], { cwd: path.join(tmp, "noindex") });
  assert.equal(missingDir.code, 2);
  assert.equal((onlyJson(missingDir).error as Json).code, "folder_not_found");
});

test("deploy: 1단계 응답을 받자마자 siteId를 기록(뒤에서 거부되어도 다시 올리면 같은 사이트)", async () => {
  put("late/site/index.html", "<p>SERVER_REJECT</p>");
  const r = await runCli(["deploy", "site", "--json"], { cwd: path.join(tmp, "late") });
  assert.equal(r.code, 20, r.stdout + r.stderr);
  const out = onlyJson(r);
  assert.equal((out.error as Json).code, "secret_detected");
  assert.match(String((out.error as Json).hint), /ai-proxy-example\.md/);
  assert.equal(out.next_step, `${PREFIX()} deploy site --json`);
  // 예전 허브(hint가 경로뿐): CLI가 안내를 붙인다 / 새 허브(hint에 안내 포함): 다시 붙이지 않는다
  assert.equal((String((out.error as Json).hint).match(/정적 파일만 제공/g) ?? []).length, 1);
  put("late2/site/index.html", "<p>SERVER_REJECT_FULL</p>");
  const full = onlyJson(await runCli(["deploy", "site", "--json"], { cwd: path.join(tmp, "late2") }));
  const fullHint = String((full.error as Json).hint);
  assert.equal((fullHint.match(/정적 파일만 제공/g) ?? []).length, 1, fullHint);
  assert.doesNotMatch(fullHint, /\.\./);
  const created = hub.deployBodies.length;
  const m = readJson("late/site/dandi.json");
  assert.match(String(m.siteId), /^site_\d+$/);
  assert.equal(m.lastDeployId, "");

  put("late/site/index.html", "<p>fixed</p>");
  const again = await runCli(["deploy", "site", "--json"], { cwd: path.join(tmp, "late") });
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.equal(hub.deployBodies[created]?.siteId, m.siteId, "같은 사이트로 다시 올려야 함");
});

test("deploy: 빌드 전 소스 폴더(Vite 등)는 source_folder(20)", async () => {
  put("vite/index.html", '<div id="root"></div><script type="module" src="/src/main.jsx"></script>');
  put("vite/package.json", '{"name":"vite-app"}');
  put("vite/vite.config.js", "export default {}");
  const count = hub.deployBodies.length;
  const r = await runCli(["deploy", ".", "--json"], { cwd: path.join(tmp, "vite") });
  assert.equal(r.code, 20, r.stdout + r.stderr);
  const out = onlyJson(r);
  assert.equal((out.error as Json).code, "source_folder");
  assert.equal("next_step" in out, false);
  assert.match(String(out.agent_instructions), /Build the project first/);
  assert.equal(hub.deployBodies.length, count);

  put("vite/dist/index.html", '<script type="module" src="/assets/index.js"></script>');
  put("vite/dist/assets/index.js", "console.log(1)");
  const built = await runCli(["deploy", ".", "--json"], { cwd: path.join(tmp, "vite") });
  assert.equal(built.code, 20);
  assert.equal(onlyJson(built).next_step, `${PREFIX()} deploy dist --json`);
  const ok = await runCli(["deploy", "dist", "--json"], { cwd: path.join(tmp, "vite") });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(readJson("vite/dandi.json").outputDir, "dist");
});

test("deploy: 빌드 전 Vite vanilla(/src/main.js)는 거부, --allow-source면 올리고 notes로 알림, 코드 예시가 있는 수업 페이지는 통과", async () => {
  put("vanilla/index.html", '<div id="app"></div><script type="module" src="/src/main.js"></script>');
  put("vanilla/package.json", '{"scripts":{"dev":"vite","build":"vite build"},"devDependencies":{"vite":"^5.0.0"}}');
  put("vanilla/src/main.js", "import './style.css'");
  const count = hub.deployBodies.length;
  const r = await runCli(["deploy", ".", "--json"], { cwd: path.join(tmp, "vanilla") });
  assert.equal(r.code, 20, r.stdout + r.stderr);
  const out = onlyJson(r);
  assert.equal((out.error as Json).code, "source_folder");
  assert.match(String((out.error as Json).hint), /--allow-source/);
  assert.equal(hub.deployBodies.length, count);

  const forced = await runCli(["deploy", ".", "--allow-source", "--json"], { cwd: path.join(tmp, "vanilla") });
  assert.equal(forced.code, 0, forced.stdout + forced.stderr);
  const fo = onlyJson(forced);
  // 참고 사항은 notes에, warnings는 개인정보(허브)·건너뛴 파일만
  assert.ok((fo.notes as Json[]).some((n) => n.kind === "source_allowed"));
  assert.ok((fo.notes as Json[]).some((n) => n.kind === "source_file" && n.path === "package.json"));
  assert.ok((fo.warnings as Json[]).every((w) => w.kind !== "source_file" && w.kind !== "source_allowed"));

  put("lesson/index.html", '<h1>React 수업</h1><pre><code>import App from "./App.jsx";</code></pre><script src="quiz.js"></script>');
  put("lesson/quiz.js", "console.log(1)");
  const lesson = await runCli(["deploy", ".", "--json"], { cwd: path.join(tmp, "lesson") });
  assert.equal(lesson.code, 0, lesson.stdout + lesson.stderr);
});

test("deploy: 로그인이 없으면 종료 코드 4와 login 안내", async () => {
  const r = await runCli(["deploy", "--json"], { cwd: path.join(tmp, "proj"), cfg: "cfg-none" });
  assert.equal(r.code, 4);
  assert.equal(onlyJson(r).next_step, `${PREFIX()} login --json`);
});

test("publish: 셀프점검이 비면 종료 코드 21, 빠진 항목을 한 번에 물으라고 안내, 허브에는 보내지 않음", async () => {
  const count = hub.publishBodies.length;
  const r = await runCli(["publish", "--json"], { cwd: path.join(tmp, "proj") });
  assert.equal(r.code, 21, r.stdout + r.stderr);
  const out = onlyJson(r);
  assert.equal((out.error as Json).code, "invalid_publish");
  for (const k of ["collectsStudentData", "storageLocation", "retention", "externalTransfer", "needsSchoolApproval"]) {
    assert.ok((out.missing as string[]).includes(`privacyCheck.${k}`), k);
  }
  for (const k of ["title", "description", "schoolLevels", "category"]) assert.ok((out.missing as string[]).includes(k), k);
  assert.deepEqual(out.invalid_format, []);
  assert.match(String(out.agent_instructions), /ASK the teacher in ONE message/);
  assert.match(String(out.agent_instructions), /Never answer the privacy questions yourself/);
  assert.equal(out.next_step, `${PREFIX()} publish --json`);
  assert.equal(hub.publishBodies.length, count);

  const human = await runCli(["publish"], { cwd: path.join(tmp, "proj") });
  assert.equal(human.code, 21);
  assert.match(human.stderr, /privacyCheck\.storageLocation/);
  assert.match(human.stderr, /다음 실행: /);
});

test("publish: siteId가 있으면 사이트 publish(lastDeployId·셀프점검 전송, 한국어 학교급·분류는 id로)", async () => {
  const m = readJson("proj/dandi.json");
  Object.assign(m, { title: "수업 퀴즈", description: "도입 5분 퀴즈", schoolLevels: ["중"], category: "수업", privacyCheck: ANSWERS });
  writeJson("proj/dandi.json", m);

  const r = await runCli(["publish", "--json"], { cwd: path.join(tmp, "proj") });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = onlyJson(r);
  assert.equal(out.status, "published");
  assert.equal(out.appUrl, `${hub.base}/apps/app_site`);
  assert.equal(out.liveUrl, LIVE);
  assert.equal(out.approvalStatus, "not_required");
  const body = hub.publishBodies.at(-1) ?? {};
  assert.equal(body.deployId, m.lastDeployId);
  assert.equal(body.title, "수업 퀴즈");
  assert.deepEqual(body.schoolLevels, ["middle"]);
  assert.equal(body.category, "class");
  assert.deepEqual(body.privacyCheck, ANSWERS);
  assert.equal("url" in body, false);

  const human = await runCli(["publish"], { cwd: path.join(tmp, "proj") });
  assert.equal(human.code, 0);
  assert.ok(human.stdout.includes("허브에 등록했습니다: 수업 퀴즈"));
  assert.ok(human.stdout.includes(`앱 주소: ${hub.base}/apps/app_site`));

  const both = await runCli(["publish", "--url", "https://x.example.com"], { cwd: path.join(tmp, "proj") });
  assert.equal(both.code, 2);
});

test("deploy: 이미 공개한 사이트를 다시 올리면 공개 버전은 그대로라고 알리고, 저장된 답을 확인받게 함", async () => {
  const r = await runCli(["deploy", "--json"], { cwd: path.join(tmp, "proj") });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = onlyJson(r);
  assert.equal((out.published as Json).appId, "app_site");
  assert.match(String(out.message), /지금 공개된 버전은 허브에 다시 등록하기 전까지 그대로 유지됩니다/);
  assert.doesNotMatch(String(out.message), /publish/);
  const saved = out.saved_answers as { title: string; schoolLevels: string[]; privacy: string[] };
  assert.equal(saved.title, "수업 퀴즈");
  assert.deepEqual(saved.schoolLevels, ["middle(중)"]);
  assert.equal(saved.privacy.length, 5);
  assert.match(String(out.agent_instructions), /already published/);
  assert.match(String(out.agent_instructions), /ASK them to confirm or change them/);
  assert.equal("privacy_questions" in out, false);

  const human = await runCli(["deploy"], { cwd: path.join(tmp, "proj") });
  assert.match(human.stdout, /저장된 등록 정보와 셀프점검 답/);
  assert.ok(human.stdout.includes("제목: 수업 퀴즈"));
});

test("publish: 형식만 틀린 답(invalid_format)은 다시 묻지 말고 고치라고 안내하고, 허용값을 알려 줌", async () => {
  const file = path.join(tmp, "proj", "dandi.json");
  const original = readFileSync(file, "utf8");
  try {
    const m = JSON.parse(original);
    m.schoolLevels = ["college"];
    m.privacyCheck = { ...ANSWERS, collectsStudentData: "false" };
    writeFileSync(file, JSON.stringify(m));
    const r = await runCli(["publish", "--json"], { cwd: path.join(tmp, "proj") });
    assert.equal(r.code, 21);
    const out = onlyJson(r);
    assert.deepEqual(out.missing, []);
    const invalid = out.invalid_format as { field: string; problem: string }[];
    assert.deepEqual(invalid.map((i) => i.field).sort(), ["privacyCheck.collectsStudentData", "schoolLevels"]);
    assert.match(invalid.find((i) => i.field === "schoolLevels")?.problem ?? "", /elem\|middle\|high\|special/);
    assert.match(String(out.agent_instructions), /do not ask the teacher again/);
    assert.doesNotMatch(String(out.agent_instructions), /ASK the teacher/);

    m.schoolLevels = ["middle"];
    m.privacyCheck = { ...ANSWERS, collectsStudentData: true, needsSchoolApproval: false };
    writeFileSync(file, JSON.stringify(m));
    const conflict = onlyJson(await runCli(["publish", "--json"], { cwd: path.join(tmp, "proj") }));
    assert.deepEqual((conflict.conflicts as Json[]).map((c) => c.field), ["privacyCheck.needsSchoolApproval"]);
    assert.match(String(conflict.agent_instructions), /ASK the teacher/);
  } finally {
    writeFileSync(file, original);
  }
});

test("publish --url: siteId가 없으면 외부 주소 등록(v0.1 API), 둘 다 없으면 사용법 오류(2)", async () => {
  mkdirSync(path.join(tmp, "ext"), { recursive: true });
  const init = await runCli(["init"], { cwd: path.join(tmp, "ext") });
  assert.equal(init.code, 0);
  assert.ok(init.stdout.includes("만들었습니다: dandi.json") && init.stdout.includes("만들었습니다: llms.txt"));
  const again = await runCli(["init", "--json"], { cwd: path.join(tmp, "ext") });
  assert.deepEqual(onlyJson(again).skipped, ["dandi.json", "llms.txt"]);

  const early = await runCli(["publish", "--url", "https://example.com/app"], { cwd: path.join(tmp, "ext") });
  assert.equal(early.code, 21);
  assert.match(early.stderr, /storageLocation/);

  const m = readJson("ext/dandi.json");
  Object.assign(m, { title: "외부 앱", description: "외부에 배포한 앱", schoolLevels: ["high"], category: "work", projectId: "prj_ext", privacyCheck: ANSWERS });
  writeJson("ext/dandi.json", m);
  const none = await runCli(["publish", "--json"], { cwd: path.join(tmp, "ext") });
  assert.equal(none.code, 2);
  assert.equal((onlyJson(none).error as Json).code, "nothing_to_publish");

  const r = await runCli(["publish", "--url", "https://example.com/app"], { cwd: path.join(tmp, "ext") });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("허브에 등록했습니다: 외부 앱"));
  assert.ok(r.stdout.includes(`앱 주소: ${hub.base}/apps/app_ext`));
  assert.equal(hub.appsBodies.at(-1)?.url, "https://example.com/app");
  assert.equal(hub.appsBodies.at(-1)?.projectId, "prj_ext");
});

test("dandi.json의 siteId가 이 계정에 없으면 비우지 않고, 로그인한 계정을 보여 주며 교사에게 먼저 묻게 함(--new-site는 확인 뒤 템플릿으로만)", async () => {
  put("stale/index.html", "<p>옛 사이트</p>");
  writeJson("stale/dandi.json", { title: "옛 사이트", siteId: "site_other", lastDeployId: "dep_old", outputDir: "." });
  const r = await runCli(["deploy", "--json"], { cwd: path.join(tmp, "stale") });
  assert.equal(r.code, 20, r.stdout + r.stderr);
  const out = onlyJson(r);
  assert.equal((out.error as Json).code, "site_not_found");
  assert.equal("next_step" in out, false, "계정을 확인하기 전에는 next_step을 주지 않음");
  assert.equal(out.next_step_template, `${PREFIX()} deploy --new-site --json`);
  assert.equal(out.relogin_step, `${PREFIX()} login --force --json`);
  assert.equal(out.account, "김교사");
  assert.equal(out.manifest_cleared, false);
  assert.match(String((out.error as Json).hint), /'김교사'/);
  assert.match(String(out.agent_instructions), /Do not create a new site yet\. ASK the teacher/);
  assert.ok(String(out.agent_instructions).includes("김교사"));
  // dandi.json은 그대로
  assert.equal(readJson("stale/dandi.json").siteId, "site_other");
  assert.equal(readJson("stale/dandi.json").lastDeployId, "dep_old");
  const human = await runCli(["deploy"], { cwd: path.join(tmp, "stale") });
  assert.match(human.stderr, /확인한 뒤 실행할 명령: .*deploy --new-site/);

  // 교사가 계정이 맞다고 확인한 뒤: --new-site로 새 사이트, 이전 siteId는 previousSiteId에
  const fresh = await runCli(["deploy", "--new-site", "--json"], { cwd: path.join(tmp, "stale") });
  assert.equal(fresh.code, 0, fresh.stdout + fresh.stderr);
  const siteId = onlyJson(fresh).siteId;
  const after = readJson("stale/dandi.json");
  assert.equal(after.siteId, siteId);
  assert.equal(after.previousSiteId, "site_other");
  assert.notEqual(after.lastDeployId, "dep_old");
  assert.equal(hub.deployBodies.at(-1)?.siteId, undefined);

  // publish도 같은 경우 dandi.json을 비우지 않고 계정을 확인하게 한다.
  const m = readJson("stale/dandi.json");
  Object.assign(m, { siteId: "site_gone", description: "설명", schoolLevels: ["elem"], category: "class", privacyCheck: ANSWERS });
  writeJson("stale/dandi.json", m);
  const pub = await runCli(["publish", "--json"], { cwd: path.join(tmp, "stale") });
  assert.equal(pub.code, 20, pub.stdout + pub.stderr);
  const p = onlyJson(pub);
  assert.equal((p.error as Json).code, "site_not_found");
  assert.equal("next_step" in p, false);
  assert.equal(p.next_step_template, `${PREFIX()} deploy --new-site --json`);
  assert.equal(p.account, "김교사");
  assert.equal(readJson("stale/dandi.json").siteId, "site_gone");
});

test("deploy <폴더>: dandi.json은 현재 폴더가 아니라 그 폴더의 프로젝트에 두어 다른 사이트를 덮어쓰지 않음", async () => {
  put("homeX/readme.txt", "home");
  put("projA/dist/index.html", "<title>A 퀴즈</title><h1>A</h1>");
  put("projB/dist/index.html", "<title>B 퀴즈</title><h1>B</h1>");
  const home = path.join(tmp, "homeX");
  const a = await runCli(["deploy", "../projA/dist", "--json"], { cwd: home });
  assert.equal(a.code, 0, a.stdout + a.stderr);
  const outA = onlyJson(a);
  assert.equal(existsSync(path.join(home, "dandi.json")), false);
  const mA = readJson("projA/dandi.json");
  assert.equal(mA.siteId, outA.siteId);
  assert.equal(mA.title, "A 퀴즈");
  assert.equal(mA.outputDir, "dist");
  assert.equal(outA.suggested_title, "A 퀴즈");
  const projADir = shellArg(path.join(tmp, "projA").split(path.sep).join("/"));
  assert.equal(outA.next_step, `${PREFIX()} publish --dir ${projADir} --json`);

  const b = await runCli(["deploy", "../projB/dist", "--json"], { cwd: home });
  assert.equal(b.code, 0, b.stdout + b.stderr);
  const outB = onlyJson(b);
  assert.equal(hub.deployBodies.at(-1)?.siteId, undefined);
  assert.notEqual(outB.siteId, outA.siteId);
  assert.equal(readJson("projB/dandi.json").siteId, outB.siteId);

  Object.assign(mA, { description: "A 설명", schoolLevels: ["초"], category: "기타", privacyCheck: ANSWERS });
  writeJson("projA/dandi.json", mA);
  const pub = await runCli(["publish", "--dir", path.join(tmp, "projA"), "--json"], { cwd: home });
  assert.equal(pub.code, 0, pub.stdout + pub.stderr);
  assert.equal(hub.publishBodies.at(-1)?.title, "A 퀴즈");
});

test("deploy: dandi.json의 projectId는 새 사이트를 만들 때만 보내고, 허브에서 옮긴 프로젝트를 되돌리지 않음(--project일 때만 옮김)", async () => {
  put("proj6/index.html", "<p>프로젝트</p>");
  writeJson("proj6/dandi.json", { title: "프로젝트 퀴즈", projectId: "prj_first" });
  const first = onlyJson(await runCli(["deploy", "--json"], { cwd: path.join(tmp, "proj6") }));
  const siteId = String(first.siteId);
  assert.equal(hub.deployBodies.at(-1)?.projectId, "prj_first", "새 사이트는 dandi.json의 projectId로 만든다");
  assert.equal(first.projectId, "prj_first");

  // 교사가 허브 화면에서 사이트를 다른 프로젝트로 옮겼다.
  const site = hub.sites.get(siteId);
  assert.ok(site);
  site.projectId = "prj_moved";
  const again = await runCli(["deploy", "--json"], { cwd: path.join(tmp, "proj6") });
  assert.equal(again.code, 0, again.stdout + again.stderr);
  const body = hub.deployBodies.at(-1) ?? {};
  assert.equal(body.siteId, siteId);
  assert.equal("projectId" in body, false, "기존 사이트에는 projectId를 보내지 않음");
  assert.equal("moveToProject" in body, false);
  assert.equal(site.projectId, "prj_moved");
  const out = onlyJson(again);
  assert.equal(out.projectId, "prj_moved");
  assert.ok((out.notes as Json[]).some((n) => n.kind === "project_synced"));
  assert.equal(readJson("proj6/dandi.json").projectId, "prj_moved", "허브의 지금 프로젝트를 기록");

  // --project를 주면 옮긴다(moveToProject: true).
  const moved = await runCli(["deploy", "--project", "prj_third", "--json"], { cwd: path.join(tmp, "proj6") });
  assert.equal(moved.code, 0, moved.stdout + moved.stderr);
  assert.equal(hub.deployBodies.at(-1)?.projectId, "prj_third");
  assert.equal(hub.deployBodies.at(-1)?.moveToProject, true);
  assert.equal(readJson("proj6/dandi.json").projectId, "prj_third");
  assert.ok((onlyJson(moved).notes as Json[]).some((n) => n.kind === "project_moved"));
});

test("예전 CLI가 현재 폴더에 남긴 dandi.json(siteId 있음, outputDir 빈칸): 현재 폴더면 이어서 쓰고, 아니면 새 사이트를 만들지 않고 묻게 함", async () => {
  put("legacyX/내 퀴즈 사이트/index.html", "<title>내 퀴즈</title><p>퀴즈</p>");
  const known = onlyJson(await runCli(["deploy", "--json"], { cwd: path.join(tmp, "proj") })).siteId as string;
  writeJson("legacyX/dandi.json", {
    title: "내 퀴즈",
    description: "퀴즈",
    siteId: known,
    lastDeployId: "",
    outputDir: "",
    schoolLevels: ["middle"],
    category: "class",
    privacyCheck: ANSWERS,
  });
  // 다른 폴더에서 실행: 새 사이트를 만들지 않고 manifest_in_parent(2)로 묻게 한다.
  const count = hub.deployBodies.length;
  const elsewhere = await runCli(["deploy", "legacyX/내 퀴즈 사이트", "--json"], { cwd: tmp });
  assert.equal(elsewhere.code, 2, elsewhere.stdout + elsewhere.stderr);
  const e = onlyJson(elsewhere);
  assert.equal((e.error as Json).code, "manifest_in_parent");
  assert.equal(e.parent_siteId, known);
  assert.match(String(e.agent_instructions), /ASK the teacher/);
  const choices = e.choices as { same_site: string; new_site: string };
  assert.equal(choices.same_site, `${PREFIX()} deploy "내 퀴즈 사이트" --dir legacyX --json`);
  assert.equal(choices.new_site, `${PREFIX()} deploy "legacyX/내 퀴즈 사이트" --new-site --json`);
  assert.equal(hub.deployBodies.length, count);
  assert.equal(existsSync(path.join(tmp, "legacyX", "내 퀴즈 사이트", "dandi.json")), false);

  // 그 폴더(현재 폴더)에서 실행: 이어서 쓰고 outputDir을 기록한다.
  const r = await runCli(["deploy", "내 퀴즈 사이트", "--json"], { cwd: path.join(tmp, "legacyX") });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const out = onlyJson(r);
  assert.equal(out.siteId, known);
  assert.equal(hub.deployBodies.at(-1)?.siteId, known);
  assert.ok((out.notes as Json[]).some((n) => n.kind === "manifest_adopted"));
  assert.equal(readJson("legacyX/dandi.json").outputDir, "내 퀴즈 사이트");
  assert.equal(existsSync(path.join(tmp, "legacyX", "내 퀴즈 사이트", "dandi.json")), false);
  assert.ok(out.saved_answers, "저장된 답을 그대로 쓴다");

  // 안내된 same_site 명령(--dir)도 같은 결과
  const viaDir = await runCli(["deploy", "내 퀴즈 사이트", "--dir", "legacyX", "--json"], { cwd: tmp });
  assert.equal(viaDir.code, 0, viaDir.stdout + viaDir.stderr);
  assert.equal(onlyJson(viaDir).siteId, known);
});

test("publish: 허브 message를 그대로 전하고, 승인 유지(approved)·이전 버전 유지(kept_until_approval)를 알림", async () => {
  put("appr/index.html", "<p>승인 앱</p>");
  const approvalAnswers = { ...ANSWERS, needsSchoolApproval: true };
  writeJson("appr/dandi.json", { title: "승인 앱", description: "설명", schoolLevels: ["high"], category: "work", privacyCheck: approvalAnswers });
  const dep = onlyJson(await runCli(["deploy", "--json"], { cwd: path.join(tmp, "appr") }));
  const siteId = String(dep.siteId);

  const first = onlyJson(await runCli(["publish", "--json"], { cwd: path.join(tmp, "appr") }));
  assert.equal(first.approvalStatus, "pending");
  assert.equal(first.liveVersion, "kept_until_approval");
  assert.equal(first.message, MSG_AWAITING);

  // 학교 내부 승인 완료 표시 → 같은 답으로 다시 등록하면 승인 유지(approved)
  approveSite(siteId, approvalAnswers);
  const redeployed = onlyJson(await runCli(["deploy", "--json"], { cwd: path.join(tmp, "appr") }));
  assert.match(String(redeployed.message), /학교 내부 승인 완료를 표시하기 전까지/);
  const kept = onlyJson(await runCli(["publish", "--json"], { cwd: path.join(tmp, "appr") }));
  assert.equal(kept.approvalStatus, "approved");
  assert.equal(kept.liveVersion, "updated");
  assert.equal(kept.message, MSG_APPROVAL_KEPT);
  assert.match(String(kept.agent_instructions), /approval was kept/);

  // 답을 바꾸면 새 버전은 승인 대기, 공개 주소는 이전 버전(kept_until_approval)
  const m = readJson("appr/dandi.json");
  (m.privacyCheck as Json).retention = "학기 말 삭제";
  writeJson("appr/dandi.json", m);
  const changed = await runCli(["publish", "--json"], { cwd: path.join(tmp, "appr") });
  const c = onlyJson(changed);
  assert.equal(c.approvalStatus, "pending");
  assert.equal(c.liveVersion, "kept_until_approval");
  assert.equal(c.message, MSG_KEPT_PREVIOUS, "허브의 message를 덮어쓰지 않음");
  assert.match(String(c.agent_instructions), /kept_until_approval/);
  assert.match(String(c.agent_instructions), /liveUrl/);
  const human = await runCli(["publish"], { cwd: path.join(tmp, "appr") });
  assert.ok(human.stdout.includes(`공개 주소(승인 전까지 이전 버전): ${LIVE}`), human.stdout);
  assert.ok(human.stdout.includes(MSG_KEPT_PREVIOUS), human.stdout);
});

test("dandi.json 인코딩: UTF-16(PowerShell Out-File)은 읽어 등록, ANSI(Set-Content 기본값)는 manifest_encoding(2)로 멈춤", async () => {
  put("enc16/index.html", "<p>인코딩</p>");
  const dep = onlyJson(await runCli(["deploy", "--json"], { cwd: path.join(tmp, "enc16") }));
  const m = readJson("enc16/dandi.json");
  Object.assign(m, { title: "받아쓰기 퀴즈", description: "설명", schoolLevels: ["elem"], category: "class", privacyCheck: { ...ANSWERS, storageLocation: "저장 안 함" } });
  const text = JSON.stringify(m, null, 2);
  writeFileSync(path.join(tmp, "enc16", "dandi.json"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
  const pub = await runCli(["publish", "--json"], { cwd: path.join(tmp, "enc16") });
  assert.equal(pub.code, 0, pub.stdout + pub.stderr);
  assert.equal(hub.publishBodies.at(-1)?.title, "받아쓰기 퀴즈");
  assert.equal((hub.publishBodies.at(-1)?.privacyCheck as Json).storageLocation, "저장 안 함");

  // "받아쓰기"를 CP949로 저장한 파일(바이트는 UTF-8로 읽을 수 없다)
  const cp949Title = Buffer.from([0xb9, 0xde, 0xbe, 0xc6, 0xbe, 0xb2, 0xb1, 0xe2]);
  const ansi = Buffer.concat([Buffer.from(`{"siteId":"${String(dep.siteId)}","title":"`, "latin1"), cp949Title, Buffer.from('","description":"x"}', "latin1")]);
  writeFileSync(path.join(tmp, "enc16", "dandi.json"), ansi);
  const count = hub.publishBodies.length;
  const bad = await runCli(["publish", "--json"], { cwd: path.join(tmp, "enc16") });
  assert.equal(bad.code, 2, bad.stdout + bad.stderr);
  const b = onlyJson(bad);
  assert.equal((b.error as Json).code, "manifest_encoding");
  assert.match(String((b.error as Json).hint), /Set-Content -Encoding UTF8/);
  assert.doesNotMatch(String((b.error as Json).hint), /init을 다시/);
  assert.equal(hub.publishBodies.length, count);
  // deploy도 멈춘다(깨진 파일을 덮어쓰거나 새 사이트를 만들지 않음).
  const deployBad = await runCli(["deploy", "--json"], { cwd: path.join(tmp, "enc16") });
  assert.equal(deployBad.code, 2);
  assert.ok(readFileSync(path.join(tmp, "enc16", "dandi.json")).equals(ansi), "파일을 그대로 둠");
});

test("init: 제목은 index.html의 <title>, 학교급·분류는 비워 둠", async () => {
  put("titled/index.html", "<html><head><title>우리말 퀴즈</title></head></html>");
  const r = await runCli(["init", "--json"], { cwd: path.join(tmp, "titled") });
  assert.equal(r.code, 0);
  const m = readJson("titled/dandi.json");
  assert.equal(m.title, "우리말 퀴즈");
  assert.deepEqual(m.schoolLevels, []);
  assert.equal(m.category, "");
  assert.equal(onlyJson(await runCli(["init", "--json"], { cwd: path.join(tmp, "titled") })).next_step, `${PREFIX()} deploy --json`);
});

/* ---------- guide / skill ---------- */

test("guide: 허브 /llms.txt 원문을 그대로 출력, 받지 못하면 내장 요약", async () => {
  const r = await runCli(["guide"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, RUNBOOK);
  const offline = await runCli(["guide"], { env: env("cfg-none", { DANDI_HUB: "http://127.0.0.1:9" }) });
  assert.equal(offline.code, 0);
  assert.match(offline.stdout, /내장 요약 런북/);
  assert.ok(offline.stdout.includes(`npx -y http://127.0.0.1:9/${CLI_BUILD.tarball} login --json`), offline.stdout);
  const custom = await runCli(["guide"], { env: env("cfg-none", { DANDI_HUB: "http://127.0.0.1:9", DANDI_NPX: "node cli/dandi.mjs" }) });
  assert.match(custom.stdout, /`node cli\/dandi\.mjs login --json`/);
});

test("skill list / skill publish", async () => {
  const list = await runCli(["skill", "list", "퀴즈", "--json"]);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(((onlyJson(list).skills as Json[])[0] as Json).name, "quiz-maker");
  assert.equal(hub.skillQueries.at(-1), "퀴즈");
  const human = await runCli(["skill", "list"], { cfg: "cfg-none" });
  assert.equal(human.code, 0);
  assert.ok(human.stdout.includes(`설치: ${PREFIX()} skill add quiz-maker`));

  put("skill/SKILL.md", "---\nname: quiz-maker\ndescription: 퀴즈\nlicense: MIT\n---\n# 퀴즈");
  put("skill/scripts/run.sh", "echo hi");
  put("skill/.DS_Store", "x");
  const pub = await runCli(["skill", "publish", "skill", "--json"]);
  assert.equal(pub.code, 0, pub.stdout + pub.stderr);
  const out = onlyJson(pub);
  assert.equal(out.status, "pending_review");
  assert.equal(out.version, "1.0.1");
  const files = (hub.skillBodies.at(-1)?.files ?? []) as { path: string; contentBase64: string }[];
  assert.deepEqual(files.map((f) => f.path).sort(), ["SKILL.md", "scripts/run.sh"]);
  assert.equal(Buffer.from(files.find((f) => f.path === "SKILL.md")?.contentBase64 ?? "", "base64").toString("utf8").split("\n")[1], "name: quiz-maker");

  put("noskill/readme.md", "x");
  const bad = await runCli(["skill", "publish", "noskill", "--json"]);
  assert.equal(bad.code, 21);
  const badOut = onlyJson(bad);
  assert.equal((badOut.error as Json).code, "invalid_skill");
  assert.equal(badOut.next_step, `${PREFIX()} skill publish noskill --json`);
});

/* ---------- stdio MCP ---------- */

type Mcp = {
  request: (method: string, params?: Json) => Promise<Json>;
  notify: (method: string, params?: Json) => void;
  close: () => Promise<number | null>;
  stderr: () => string;
};

function startMcp(e: NodeJS.ProcessEnv): Mcp {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [CLI, "mcp"], { cwd: tmp, env: e, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (msg: Json) => void>();
  let buf = "";
  let err = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8").on("data", (d: string) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Json; // stdout에는 JSON-RPC 메시지만 있어야 한다
      assert.equal(msg.jsonrpc, "2.0");
      const w = waiting.get(msg.id as number);
      if (w) {
        waiting.delete(msg.id as number);
        w(msg);
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP ${method} 응답 없음: ${err}`)), 30_000);
        waiting.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`);
    },
    close() {
      child.stdin.end();
      return new Promise((resolve) => child.on("close", (code) => resolve(code)));
    },
    stderr: () => err,
  };
}

async function callTool(mcp: Mcp, name: string, args: Json = {}) {
  const res = await mcp.request("tools/call", { name, arguments: args });
  const result = res.result as { content: { type: string; text: string }[]; structuredContent: Json; isError?: boolean };
  assert.ok(result, `tools/call ${name}: ${JSON.stringify(res)}`);
  assert.ok(!result.content[0].text.includes(TOKEN), "도구 결과에 토큰이 나옴");
  return result;
}

test("mcp: initialize → tools/list → tools/call(내 정보·폴더 배포·파일 배포·등록·목록·스킬)", async () => {
  const mcp = startMcp(env("cfg-main"));
  const init = await mcp.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claude-desktop", version: "1.0" },
  });
  assert.equal((init.result as Json).protocolVersion, "2025-06-18");
  mcp.notify("notifications/initialized");
  const list = await mcp.request("tools/list");
  assert.equal(((list.result as Json).tools as Json[]).length, 9);

  const who = await callTool(mcp, "dandi_whoami");
  assert.equal(who.isError, undefined);
  assert.deepEqual(who.structuredContent.user, USER);

  const folder = await callTool(mcp, "dandi_deploy_folder", { path: path.join(tmp, "proj") });
  assert.equal(folder.isError, undefined, folder.content[0].text);
  assert.equal(folder.structuredContent.previewUrl, PREVIEW);
  assert.equal(hub.deployBodies.at(-1)?.siteId, "site_1"); // dandi.json의 siteId로 같은 사이트에 올림
  assert.equal(readJson("proj/dandi.json").lastDeployId, folder.structuredContent.deployId);
  // 이미 공개한 사이트: 저장된 답을 보여 주고 확인받게 한다.
  assert.equal((folder.structuredContent.published as Json).appId, "app_site");
  assert.ok(folder.structuredContent.saved_answers);
  assert.match(String(folder.structuredContent.agent_instructions), /call dandi_publish_site/);
  assert.deepEqual((folder.structuredContent.skipped as Json[]).map((s) => s.path), ["app.js.map"]);

  if (process.platform === "win32") {
    // Git Bash 형식 경로(/c/Users/...)도 받는다.
    const abs = path.join(tmp, "proj");
    const msys = `/${abs[0].toLowerCase()}${abs.slice(2).split(path.sep).join("/")}`;
    const viaMsys = await callTool(mcp, "dandi_deploy_folder", { path: msys });
    assert.equal(viaMsys.isError, undefined, viaMsys.content[0].text);
    assert.equal(viaMsys.structuredContent.siteId, "site_1");
  }

  const files = await callTool(mcp, "dandi_deploy_files", {
    files: [{ path: "index.html", content: "<h1>인라인</h1>" }],
    title: "인라인 사이트",
  });
  assert.equal(files.isError, undefined, files.content[0].text);
  assert.equal(hub.deployBodies.at(-1)?.title, "인라인 사이트");
  assert.equal(files.structuredContent.published, null);
  assert.equal((files.structuredContent.privacy_questions as string[]).length, 5);

  const missing = await callTool(mcp, "dandi_publish_site", {
    siteId: "site_1",
    title: "수업 퀴즈",
    description: "",
    schoolLevels: ["middle"],
    category: "class",
  });
  assert.equal(missing.isError, true);
  assert.ok((missing.structuredContent.missing as string[]).includes("privacyCheck"));
  assert.match(String(missing.structuredContent.agent_instructions), /ASK the teacher in ONE message/);

  const published = await callTool(mcp, "dandi_publish_site", {
    siteId: "site_1",
    title: "수업 퀴즈",
    description: "도입 퀴즈",
    schoolLevels: ["중"],
    category: "수업",
    privacyCheck: { collectsStudentData: true, storageLocation: "이 기기 브라우저", retention: "학기 말 삭제", externalTransfer: false, needsSchoolApproval: true },
  });
  assert.equal(published.isError, undefined, published.content[0].text);
  assert.equal(published.structuredContent.approvalStatus, "pending");
  assert.equal(published.structuredContent.liveVersion, "kept_until_approval");
  assert.equal(published.structuredContent.message, MSG_KEPT_PREVIOUS, "허브의 message를 그대로 씀");
  assert.ok(published.content[0].text.includes(MSG_KEPT_PREVIOUS));
  assert.match(published.content[0].text, /공개 주소\(승인 전까지 이전 버전\)/);
  assert.deepEqual(hub.publishBodies.at(-1)?.schoolLevels, ["middle"]);

  const sites = await callTool(mcp, "dandi_list_my_sites");
  assert.equal((sites.structuredContent.sites as Json[])[0].id, "site_1");
  const skills = await callTool(mcp, "dandi_search_skills", { query: "퀴즈" });
  assert.equal((skills.structuredContent.skills as Json[]).length, 1);
  const skill = await callTool(mcp, "dandi_get_skill", { name: "quiz-maker" });
  assert.match(skill.content[0].text, /SKILL\.md/);

  // 빌드 전 소스 폴더: next_step 대신 dandi_deploy_folder에 빌드 폴더를 넘기라고 안내, allowSource로 그대로 올릴 수 있음
  const src = await callTool(mcp, "dandi_deploy_folder", { path: path.join(tmp, "vanilla") });
  assert.equal(src.isError, true);
  assert.match(String(src.structuredContent.agent_instructions), /call dandi_deploy_folder/);
  assert.doesNotMatch(src.content[0].text, /next_step/);
  const allowed = await callTool(mcp, "dandi_deploy_folder", { path: path.join(tmp, "vanilla"), allowSource: true });
  assert.equal(allowed.isError, undefined, allowed.content[0].text);
  assert.ok((allowed.structuredContent.notes as Json[]).some((n) => n.kind === "source_allowed"));

  // 없는 사이트: 계정을 확인하게 하고 newSite 도구 인자를 안내
  const gone = await callTool(mcp, "dandi_deploy_files", { files: [{ path: "index.html", content: "x" }], siteId: "site_nope" });
  assert.equal(gone.isError, true);
  assert.equal((gone.structuredContent.error as Json).code, "site_not_found");
  assert.equal(gone.structuredContent.account, "김교사");
  assert.match(String(gone.structuredContent.agent_instructions), /dandi_login with force: true/);
  assert.match(String(gone.structuredContent.agent_instructions), /without siteId/);

  const already = await callTool(mcp, "dandi_login");
  assert.equal(already.structuredContent.status, "logged_in");
  assert.equal(await mcp.close(), 0);
});

test("mcp: 로그인 전 dandi_login은 승인 링크를 돌려주고, 승인 뒤 다시 부르면 로그인 완료", async () => {
  const mcp = startMcp(env("cfg-mcp-login"));
  await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cursor", version: "1" } });
  mcp.notify("notifications/initialized");

  const before = await callTool(mcp, "dandi_whoami");
  assert.equal(before.isError, true);
  assert.equal((before.structuredContent.error as Json).code, "login_required");

  const start = await callTool(mcp, "dandi_login");
  assert.equal(start.structuredContent.status, "pending");
  assert.equal(start.structuredContent.done, false);
  assert.match(String(start.structuredContent.verification_uri_complete), /\/device\?code=/);
  assert.ok(start.content[0].text.includes(String(start.structuredContent.user_code)));
  assert.equal(hub.devices.get(hub.lastDeviceCode)?.body.client, "mcp:cursor");

  const waiting = await callTool(mcp, "dandi_deploy_files", { files: [{ path: "index.html", content: "x" }] });
  assert.equal((waiting.structuredContent.error as Json).code, "authorization_pending");

  setDevice("approved");
  const done = await callTool(mcp, "dandi_login");
  assert.equal(done.structuredContent.status, "logged_in", done.content[0].text);
  assert.equal(readJson("cfg-mcp-login/config.json").token, TOKEN);
  const who = await callTool(mcp, "dandi_whoami");
  assert.equal(who.isError, undefined);

  // 다른 계정으로 바꾸기(force): 이미 로그인되어 있어도 새 승인 요청을 만들고,
  // 다시 불렀을 때 예전 토큰으로 "이미 로그인됨"이라 답하지 않고 새 승인 결과를 확인한다.
  const devices = hub.devices.size;
  const forced = await callTool(mcp, "dandi_login", { force: true });
  assert.equal(forced.structuredContent.status, "pending", forced.content[0].text);
  assert.equal(hub.devices.size, devices + 1);
  setDevice("approved");
  const switched = await callTool(mcp, "dandi_login");
  assert.equal(switched.structuredContent.status, "logged_in", switched.content[0].text);
  assert.match(switched.content[0].text, /^로그인했습니다/);
  const bad = await callTool(mcp, "dandi_login", { force: "yes" });
  assert.equal((bad.structuredContent.error as Json).code, "invalid_argument");
  assert.equal(await mcp.close(), 0);
  assert.ok(!mcp.stderr().includes(TOKEN));
});

test("mcp: 교사가 [거부]하면 dandi_login은 새 로그인을 바로 시작하지 않고 교사에게 먼저 묻게 함", async () => {
  const mcp = startMcp(env("cfg-mcp-deny"));
  await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-desktop", version: "1" } });
  mcp.notify("notifications/initialized");
  const start = await callTool(mcp, "dandi_login");
  assert.equal(start.structuredContent.status, "pending");
  const firstCode = hub.lastDeviceCode;
  setDevice("denied");
  const denied = await callTool(mcp, "dandi_login");
  assert.equal(denied.structuredContent.status, "denied", denied.content[0].text);
  assert.match(String(denied.structuredContent.agent_instructions), /ASK the teacher whether they want to log in/);
  assert.equal(hub.lastDeviceCode, firstCode, "거부 직후에는 새 요청을 만들지 않음");
  // 교사가 원한다고 답해 다시 부르면 새로 시작한다.
  const again = await callTool(mcp, "dandi_login");
  assert.equal(again.structuredContent.status, "pending");
  assert.notEqual(hub.lastDeviceCode, firstCode);
  assert.equal(await mcp.close(), 0);
});
