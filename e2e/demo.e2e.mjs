// Dandi v0.1 시연 시나리오(PRD 13장) + v0.2 연결 기능(PRD 14·15장, F-31~F-58) 실제 브라우저 E2E 테스트.
// 실행: node e2e/demo.e2e.mjs   (BASE_URL 기본값 http://localhost:3100, 서버는 미리 실행되어 있어야 한다)
// 시스템 Chrome(playwright-core, channel: "chrome")을 headless로 띄우고,
// 익명 방문자 / 교사 A / 교사 B / 관리자를 서로 다른 브라우저 컨텍스트로 분리한다.
// 사이트 호스팅(F-51)은 http://<label>.localhost:<port>로 서빙되므로 Chrome은 주소를 그대로 열고,
// Node에서는 127.0.0.1로 접속하면서 Host 헤더를 붙인다.
// 환경 변수: BASE_URL, E2E_TMP_DIR(임시 폴더를 만들 상위 폴더, 기본 OS 임시 폴더), E2E_KEEP_TMP=1(임시 폴더 유지),
//           E2E_STEPS=6,7,11(지정한 단계만 실행, 앞 단계 상태가 필요하면 도우미가 대신 만든다), E2E_JSON(결과 JSON 경로),
//           E2E_SKIP_SKILLS_INSTALL=1(13단계의 npx skills add 실제 설치를 건너뜀: 네트워크가 없을 때)

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "cli", "dandi.mjs");
const BASE_URL = (process.env.BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const RUN = Date.now().toString(36).slice(-6);
const u = (p) => `${BASE_URL}${p}`;
const CLI_VERSION = "0.2.0";
// npx 캐시 문제 때문에 허브는 CLI를 내용 해시가 붙은 이름(dandi-<version>-<sha8>.tgz)으로 내놓고,
// 그 이름을 /dandi-latest.json에 적는다. 안내 명령(next_step·llms.txt·/connect)은 모두 이 이름을 써야 한다.
// main()이 시작할 때 latest.json을 읽어 TARBALL_URL을 정한다. 예전 이름(LEGACY)은 호환용으로만 남아 있다.
const LEGACY_TARBALL_URL = `${BASE_URL}/dandi-${CLI_VERSION}.tgz`;
let TARBALL_URL = LEGACY_TARBALL_URL;
/** @type {{ version: string, tag: string, tarball: string } | null} */
let CLI_LATEST = null;
/** --json 출력은 ASCII만 쓴다(한글은 \uXXXX). */
const isAscii = (s) => !/[^\x00-\x7f]/.test(String(s));
/** CLI --json은 UTF-8이 기본이고, Windows PowerShell·cmd(MSYSTEM 없음)에서만 한글을 이스케이프한다. */
const JSON_ESCAPED = process.platform === "win32" && !process.env.MSYSTEM;
/** 셸에 맞는 --json 출력인지: 이스케이프 환경이면 ASCII여야 하고, 아니면 어느 쪽이든 JSON.parse만 되면 된다. */
const jsonEncodingOk = (s) => (JSON_ESCAPED ? isAscii(s) : true);
const ONLY = new Set(
  String(process.env.E2E_STEPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const TEACHER_A = `김교사A-${RUN}`;
const TEACHER_B = `이교사B-${RUN}`;
const ADMIN = `관리자-${RUN}`;
const PHONE = "010-1234-5678";
const EMAIL = "kim.teacher@example.com";

/* ------------------------------------------------------------------ */
/* 공통 도우미                                                          */
/* ------------------------------------------------------------------ */

class Fatal extends Error {}

function checker() {
  const failures = [];
  const notes = [];
  return {
    failures,
    notes,
    /** 실패하면 단계를 즉시 중단한다. */
    must(cond, msg) {
      if (!cond) throw new Fatal(msg);
    },
    /** 실패를 기록하고 계속 진행한다. */
    soft(cond, msg) {
      if (!cond) failures.push(msg);
      return Boolean(cond);
    },
    note(msg) {
      notes.push(msg);
    },
  };
}

const results = [];
const jsErrors = [];

async function step(name, fn) {
  const stepNo = name.match(/^(\d+)\)/)?.[1];
  if (ONLY.size && stepNo && !ONLY.has(stepNo)) return;
  const t = checker();
  const started = Date.now();
  let fatal = null;
  try {
    await fn(t);
  } catch (err) {
    fatal = err;
  }
  const ok = !fatal && t.failures.length === 0;
  const details = [];
  if (fatal) details.push(`중단: ${String(fatal.message || fatal).split("\n").slice(0, 3).join(" | ")}`);
  for (const f of t.failures) details.push(`확인 실패: ${f}`);
  const ms = Date.now() - started;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} (${ms}ms)`);
  for (const d of details) console.log(`    - ${d}`);
  for (const n of t.notes) console.log(`    · ${n}`);
  results.push({ name, ok, details, notes: t.notes });
}

/** Next.js 서버 액션(POST + Next-Action 헤더) 응답을 기다린다. */
function waitForAction(page, timeout = 20000) {
  return page.waitForResponse(
    (r) => r.request().method() === "POST" && Boolean(r.request().headers()["next-action"]),
    { timeout },
  );
}

/** 페이지에서 나가는 서버 액션 요청 수를 센다. */
function trackActions(page) {
  const reqs = [];
  const handler = (req) => {
    if (req.method() === "POST" && req.headers()["next-action"]) reqs.push(req.url());
  };
  page.on("request", handler);
  return {
    get count() {
      return reqs.length;
    },
    stop() {
      page.off("request", handler);
    },
  };
}

const num = (s) => Number(String(s).replace(/,/g, ""));

async function mainText(page) {
  return page.locator("main").innerText();
}

async function newCtx(browser, extra = {}) {
  const ctx = await browser.newContext({ locale: "ko-KR", acceptDownloads: true, ...extra });
  ctx.setDefaultTimeout(15000);
  ctx.setDefaultNavigationTimeout(30000);
  ctx.on("page", (p) => {
    p.on("pageerror", (e) => jsErrors.push(`${p.url()} :: ${e.message}`));
  });
  return ctx;
}

/** /login 데모 로그인. 성공하면 /studio로 이동하고 헤더에 이름이 보인다. */
async function demoLogin(ctx, { name, role = "teacher", level = "middle" }) {
  const page = await ctx.newPage();
  try {
    const r = await page.goto(u("/login"));
    if (!r || r.status() !== 200) throw new Error(`/login 상태 코드 ${r?.status()}`);
    await page.locator('input[name="name"]').fill(name);
    await page.locator('select[name="schoolLevel"]').selectOption(level);
    await page.locator(`input[name="role"][value="${role}"]`).check();
    await Promise.all([
      page.waitForURL((url) => new URL(url).pathname === "/studio", { timeout: 20000 }),
      page.getByRole("button", { name: "데모 로그인" }).click(),
    ]);
    const who = await page.locator("header .session").innerText();
    return { who };
  } finally {
    await page.close();
  }
}

const S = { browser: null, tmp: null, cliToken: null };
const memo = {};
function once(key, fn) {
  if (!memo[key]) memo[key] = fn();
  return memo[key];
}

const ensureAnon = () => once("anon", async () => newCtx(S.browser));

const ensureTeacherA = () =>
  once("teacherA", async () => {
    const ctx = await newCtx(S.browser);
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
    const { who } = await demoLogin(ctx, { name: TEACHER_A, role: "teacher", level: "middle" });
    if (!who.includes(TEACHER_A) || !who.includes("교사")) throw new Error(`교사 A 로그인 후 헤더: ${who}`);
    return ctx;
  });

const ensureTeacherB = () =>
  once("teacherB", async () => {
    const ctx = await newCtx(S.browser);
    const { who } = await demoLogin(ctx, { name: TEACHER_B, role: "teacher", level: "high" });
    if (!who.includes(TEACHER_B)) throw new Error(`교사 B 로그인 후 헤더: ${who}`);
    return ctx;
  });

const ensureAdmin = () =>
  once("admin", async () => {
    const ctx = await newCtx(S.browser);
    const { who } = await demoLogin(ctx, { name: ADMIN, role: "admin", level: "middle" });
    if (!who.includes(ADMIN) || !who.includes("관리자")) throw new Error(`관리자 로그인 후 헤더: ${who}`);
    return ctx;
  });

/** /studio/cli에서 CI용 CLI 토큰을 발급하고 화면에 한 번 표시되는 원문과 로그인 명령을 읽는다. */
async function issueCliTokenViaPage(ctx) {
  const page = await ctx.newPage();
  try {
    await page.goto(u("/studio/cli"));
    await page.getByRole("heading", { level: 1, name: "CLI 토큰" }).waitFor();
    const act = waitForAction(page);
    await page.getByRole("button", { name: "새 CLI 토큰 발급" }).click();
    await act;
    const pres = page.locator('div[role="status"] pre');
    await pres.first().waitFor();
    const token = (await pres.first().innerText()).trim();
    if (!/^dd_cli_[A-Za-z0-9_-]{10,}$/.test(token)) throw new Error(`토큰 형식이 이상함: ${token}`);
    const loginCmd = (await pres.nth(1).innerText()).trim();
    return { token, loginCmd };
  } finally {
    await page.close();
  }
}

async function cliTokenForA() {
  if (!S.cliToken) S.cliToken = (await issueCliTokenViaPage(await ensureTeacherA())).token;
  return S.cliToken;
}

/** 교사 B의 CLI 토큰(다른 교사의 자원에 접근하지 못하는지 확인할 때 쓴다). */
const cliTokenForB = () => once("cliTokenB", async () => (await issueCliTokenViaPage(await ensureTeacherB())).token);

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function apiPost(pathname, token, body, extraHeaders = {}) {
  const res = await fetch(u(pathname), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: parseMaybeJson(text), headers: res.headers };
}

/** 프로젝트 키를 원하는 헤더 형식으로 보내 게이트웨이를 부른다(F-32: Authorization: Bearer 또는 x-api-key). */
async function gatewayPost(key, body, { via = "x-api-key", headers = {} } = {}) {
  const auth = via === "bearer" ? { Authorization: `Bearer ${key}` } : { "x-api-key": key };
  const res = await fetch(u("/api/ai/chat"), {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: parseMaybeJson(text), headers: res.headers };
}

/** 에이전트 감지 환경 변수를 뺀, 테스트용 CLI 환경. 표준입력은 파이프(비TTY)라 login은 JSON 모드로 동작한다. */
function cliEnv(configDir, extra = {}) {
  const env = { ...process.env, DANDI_CONFIG_DIR: configDir, DANDI_NO_BROWSER: "1", ...extra };
  for (const k of [
    "DANDI_TOKEN",
    "DANDI_HUB",
    "DANDI_NPX",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "AI_AGENT",
    "CODEX_SANDBOX",
    "CODEX_CI",
    "CODEX_THREAD_ID",
    "CURSOR_AGENT",
    "GEMINI_CLI",
  ]) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

function lastJsonLine(text) {
  const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      // 다음 줄
    }
  }
  return null;
}

/** node cli/dandi.mjs <args>. input을 주면 표준입력으로 보낸다. */
function runCli(args, { cwd, env, input, timeout = 120000 }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      stderr += `\n[E2E] ${timeout}ms 안에 끝나지 않아 종료함`;
      child.kill();
    }, timeout);
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, json: lastJsonLine(stdout) });
    };
    child.on("error", (e) => {
      stderr += String(e);
      done(1);
    });
    child.on("close", (code) => done(typeof code === "number" ? code : 1));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

/** 셸 명령(npx 등). Windows의 npx는 .cmd라 셸이 필요하다. 인자는 테스트가 만든 고정 문자열이다. */
function runShell(command, { cwd, env, timeout = 240000 }) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      out += `\n[E2E] ${timeout}ms 안에 끝나지 않아 종료함`;
      child.kill();
    }, timeout);
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out });
    };
    child.on("error", (e) => {
      out += String(e);
      done(1);
    });
    child.on("close", (code) => done(typeof code === "number" ? code : 1));
  });
}

/**
 * 사이트 호스트(<label>.localhost:<port>)를 Node에서 요청한다. Node는 *.localhost를 풀지 못할 수 있으므로
 * 127.0.0.1로 접속하고 Host 헤더에 원래 호스트를 넣는다.
 */
function hostRequest(urlStr, { method = "GET", headers = {} } = {}) {
  const target = new URL(urlStr);
  const local = target.hostname === "localhost" || target.hostname.endsWith(".localhost");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: local ? "127.0.0.1" : target.hostname,
        port: target.port || 80,
        method,
        path: `${target.pathname}${target.search}`,
        headers: { Host: target.host, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body, text: body.toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error(`timeout ${urlStr}`)));
    req.end();
  });
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** 원격 MCP(Streamable HTTP) 요청. 응답은 JSON 또는 SSE(text/event-stream)일 수 있다. */
async function mcpPost(token, message, { protocolVersion } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
  const res = await fetch(u("/mcp"), { method: "POST", headers, body: JSON.stringify(message) });
  const text = await res.text();
  const ct = res.headers.get("content-type") || "";
  let data = null;
  if (ct.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const obj = parseMaybeJson(line.slice(5).trim());
      if (obj && typeof obj === "object" && (message.id === undefined || obj.id === message.id)) data = obj;
    }
  } else if (text) {
    data = parseMaybeJson(text);
  }
  return { status: res.status, headers: res.headers, data, text };
}

/** 도구 호출 결과(content 텍스트 + structuredContent)를 한 문자열로 모은다. */
function toolResultText(result) {
  if (!result || typeof result !== "object") return "";
  const parts = [];
  for (const c of result.content ?? []) if (c && typeof c.text === "string") parts.push(c.text);
  if (result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n");
}

/** 1x1 PNG */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** pdf.js로 실제 렌더링할 수 있는 한 쪽짜리 PDF(xref 오프셋이 맞는 파일)를 만든다. */
function makePdf(text) {
  const content = `0.2 0.45 0.85 rg 20 20 260 60 re f BT /F1 18 Tf 0 0 0 rg 30 140 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** 작은 정적 사이트(index.html + css + js + png)를 만든다. */
async function writeStaticSite(dir, { heading, marker }) {
  await fs.mkdir(path.join(dir, "img"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "index.html"),
    `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>${heading}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<h1 id="title">${heading}</h1>
<p id="js-out">스크립트 실행 전</p>
<img id="logo" src="img/logo.png" alt="로고" width="16" height="16">
<script src="app.js"></script>
</body>
</html>
`,
    "utf8",
  );
  await fs.writeFile(path.join(dir, "style.css"), "h1 { color: rgb(12, 34, 56); }\n", "utf8");
  await fs.writeFile(path.join(dir, "app.js"), `document.getElementById("js-out").textContent = ${JSON.stringify(marker)};\n`, "utf8");
  await fs.writeFile(path.join(dir, "img", "logo.png"), PNG_1X1);
}

/** Chrome으로 사이트 주소를 열어 HTML·CSS·JS·이미지가 모두 적용됐는지 확인한다. */
async function inspectSiteInChrome(ctx, url) {
  const page = await ctx.newPage();
  try {
    const res = await page.goto(url);
    const status = res?.status() ?? 0;
    const headers = res ? await res.allHeaders() : {};
    if (status !== 200) return { status, headers, text: await page.content().catch(() => "") };
    await page.waitForFunction(() => document.getElementById("js-out")?.textContent !== "스크립트 실행 전", null, { timeout: 10000 }).catch(() => {});
    const info = await page.evaluate(() => {
      const h1 = document.getElementById("title");
      const img = document.getElementById("logo");
      return {
        h1: h1?.textContent ?? "",
        color: h1 ? getComputedStyle(h1).color : "",
        js: document.getElementById("js-out")?.textContent ?? "",
        imgOk: Boolean(img && img.complete && img.naturalWidth > 0),
        cookie: document.cookie,
        origin: location.origin,
      };
    });
    return { status, headers, ...info };
  } finally {
    await page.close();
  }
}

/** 프로젝트 만들기(/studio/projects). 성공하면 키 탭(/studio/projects/<id>?tab=keys)으로 이동한다. */
async function createProjectViaPage(ctx, { name, budget }) {
  const page = await ctx.newPage();
  try {
    await page.goto(u("/studio/projects"));
    await page.getByRole("heading", { level: 1, name: "프로젝트·API 키" }).waitFor();
    await page.locator('form input[name="name"]').fill(name);
    if (budget !== undefined) await page.locator('input[name="monthlyTokenBudget"]').fill(String(budget));
    await Promise.all([
      page.waitForURL(/\/studio\/projects\/[^/?]+\?tab=keys$/, { timeout: 20000 }),
      page.getByRole("button", { name: "프로젝트 만들기" }).click(),
    ]);
    return new URL(page.url()).pathname.split("/").pop();
  } finally {
    await page.close();
  }
}

/** 프로젝트 키 탭에서 키를 만들고 한 번만 표시되는 원문을 읽는다(같은 page를 이어서 쓸 수 있다). */
async function createKeyOnPage(page, { name, role }) {
  const shown = page.locator('.notice[role="status"] code');
  const prev = (await shown.count()) > 0 ? (await shown.first().innerText()).trim() : "";
  await page.locator('form input[name="name"]').fill(name);
  await page.locator(`input[name="role"][value="${role}"]`).check();
  const act = waitForAction(page);
  await page.getByRole("button", { name: "새 API 키 만들기" }).click();
  await act;
  const code = page.locator('.notice[role="status"] code').first();
  await code.waitFor();
  await page.waitForFunction(
    (p) => {
      const el = document.querySelector('.notice[role="status"] code');
      return el && el.textContent.trim() !== p;
    },
    prev,
    { timeout: 10000 },
  );
  const secret = (await code.innerText()).trim();
  if (!/^dd_sk_[A-Za-z0-9_-]{10,}$/.test(secret)) throw new Error(`프로젝트 키 형식: ${secret}`);
  return secret;
}

/** 7·8·9단계가 쓰는 프로젝트와 inference 키(없으면 만든다). */
const ensureProjectKey = () =>
  once("projectKey", async () => {
    if (state.apiKey && state.projectId) return { projectId: state.projectId, key: state.apiKey };
    const ctxA = await ensureTeacherA();
    const projectId = await createProjectViaPage(ctxA, { name: `E2E 프로젝트 ${RUN}` });
    const page = await ctxA.newPage();
    try {
      await page.goto(u(`/studio/projects/${projectId}?tab=keys`));
      const key = await createKeyOnPage(page, { name: `E2E 서버 키 ${RUN}`, role: "inference" });
      state.projectId = projectId;
      state.apiKey = key;
      return { projectId, key };
    } finally {
      await page.close();
    }
  });

/** 6·12·13단계가 쓰는 CLI 로그인 설정 폴더(없으면 CI 토큰을 표준입력으로 넣어 로그인한다). */
const ensureCliConfig = () =>
  once("cliConfig", async () => {
    if (state.cliConfigDir) return state.cliConfigDir;
    const cfgDir = path.join(S.tmp, "cli-config-ci");
    const token = await cliTokenForA();
    const r = await runCli(["login", "--token-stdin", "--hub", BASE_URL], { cwd: S.tmp, env: cliEnv(cfgDir), input: `${token}\n` });
    if (r.code !== 0) throw new Error(`login --token-stdin 실패 ${r.code}: ${r.stderr || r.stdout}`);
    state.cliConfigDir = cfgDir;
    return cfgDir;
  });

/** CLI로 사이트를 올리고 공개(needsSchoolApproval=false)까지 한다. 15단계가 6단계 없이 돌 때 쓴다. */
const ensurePublishedSite = () =>
  once("publishedSite", async () => {
    if (state.site1) return state.site1;
    const cfgDir = await ensureCliConfig();
    const env = cliEnv(cfgDir);
    const projDir = path.join(S.tmp, `iso-site-${RUN}`);
    await writeStaticSite(path.join(projDir, "dist"), { heading: `격리 확인 ${RUN}`, marker: `iso-js-${RUN}` });
    const dep = await runCli(["deploy", "dist", "--json"], { cwd: projDir, env });
    if (dep.code !== 0) throw new Error(`deploy 실패 ${dep.code}: ${dep.stdout}${dep.stderr}`);
    const manifestPath = path.join(projDir, "dandi.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    Object.assign(manifest, { title: `E2E 격리 사이트 ${RUN}`, description: "사이트 격리 확인용", schoolLevels: ["middle"], category: "class" });
    manifest.privacyCheck = {
      collectsStudentData: false,
      storageLocation: "저장 안 함",
      retention: "저장 안 함",
      externalTransfer: false,
      needsSchoolApproval: false,
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const pub = await runCli(["publish", "--json"], { cwd: projDir, env });
    if (pub.code !== 0 || !pub.json?.liveUrl) throw new Error(`publish 실패 ${pub.code}: ${pub.stdout}${pub.stderr}`);
    state.site1 = { liveUrl: pub.json.liveUrl, slug: dep.json.slug, previewUrl: dep.json.previewUrl, heading: `격리 확인 ${RUN}` };
    return state.site1;
  });

async function readRuns(page) {
  const txt = await page.locator("main p.muted").filter({ hasText: /실행 [\d,]+회/ }).first().innerText();
  return num(txt.match(/실행 ([\d,]+)회/)[1]);
}

async function readCopies(page) {
  const txt = await page.locator("main p.muted").filter({ hasText: /복사 [\d,]+회/ }).first().innerText();
  return num(txt.match(/복사 ([\d,]+)회/)[1]);
}

/* 미니앱 등록 폼(/studio/apps/new) */
async function fillAppForm(page, v) {
  await page.locator('input[name="title"]').fill(v.title);
  await page.locator('textarea[name="description"]').fill(v.description);
  await page.locator('input[name="url"]').fill(v.url);
  for (const lvl of ["elem", "middle", "high", "special"]) {
    const cb = page.locator(`input[name="schoolLevels"][value="${lvl}"]`);
    if (v.levels.includes(lvl)) await cb.check();
    else await cb.uncheck();
  }
  await page.locator('select[name="category"]').selectOption(v.category);
  await page.locator(`input[name="collectsStudentData"][value="${v.collects}"]`).check();
  await page.locator('input[name="storageLocation"]').fill(v.storage);
  await page.locator('input[name="retention"]').fill(v.retention);
  await page.locator(`input[name="externalTransfer"][value="${v.external}"]`).check();
  await page.locator(`input[name="needsSchoolApproval"][value="${v.approval}"]`).check();
}

async function submitAppForm(page) {
  await Promise.all([
    page.waitForURL(/\/apps\/app_[A-Za-z0-9_-]+$/, { timeout: 20000 }),
    page.getByRole("button", { name: "셀프점검 완료 후 등록" }).click(),
  ]);
  return new URL(page.url()).pathname.split("/").pop();
}

/* 자료 업로드 폼(/files/upload) */
async function fillUploadForm(page, { file, title, description = "", level = "all", confirm }) {
  await page.locator('input[name="file"]').setInputFiles(file);
  await page.locator('input[name="title"]').fill(title);
  await page.locator('textarea[name="description"]').fill(description);
  await page.locator('select[name="schoolLevel"]').selectOption(level);
  const cb = page.locator('input[name="noStudentData"]');
  if (confirm) await cb.check();
  else await cb.uncheck();
}

async function uploadOk(ctx, opts) {
  const page = await ctx.newPage();
  try {
    await page.goto(u("/files/upload"));
    await fillUploadForm(page, { ...opts, confirm: true });
    await Promise.all([
      page.waitForURL((url) => new URL(url).pathname === "/files", { timeout: 30000 }),
      page.getByRole("button", { name: "업로드", exact: true }).click(),
    ]);
    const row = page.locator("main table tbody tr", { hasText: opts.title });
    await row.first().waitFor();
    const href = await row.first().getByRole("link", { name: "다운로드" }).getAttribute("href");
    const id = href.match(/\/api\/files\/([^/]+)\/download/)[1];
    return { id, href };
  } finally {
    await page.close();
  }
}

function modelTable(page) {
  return page.locator("main table").filter({ has: page.locator("th", { hasText: "현재 상태" }) });
}
function auditTable(page) {
  return page.locator("main table").filter({ has: page.locator("th", { hasText: "시각" }) });
}
function pendingTable(page) {
  return page.locator("main table").filter({ has: page.locator("th", { hasText: "학생 개인정보 · 저장 위치" }) });
}

async function setModelStatusAsAdmin(page, modelId, status, reason) {
  await page.goto(u("/admin"));
  const row = modelTable(page)
    .locator("tbody tr")
    .filter({ has: page.locator("code", { hasText: new RegExp(`^${modelId}$`) }) });
  await row.waitFor();
  await row.locator('select[name="status"]').selectOption(status);
  await row.locator('input[name="reason"]').fill(reason);
  const act = waitForAction(page);
  await row.getByRole("button", { name: "저장" }).click();
  await act;
  await row.getByText(/저장했습니다|이미 '.*' 상태입니다/).waitFor();
  return (await row.innerText()).trim();
}

async function modelsApi() {
  const res = await fetch(u("/api/ai/models"));
  const data = await res.json();
  return { status: res.status, data };
}

/* ------------------------------------------------------------------ */
/* 시나리오                                                            */
/* ------------------------------------------------------------------ */

const state = {};

async function main() {
  console.log(`Dandi E2E · BASE_URL=${BASE_URL} · RUN=${RUN}`);
  S.browser = await chromium.launch({ channel: "chrome", headless: true });
  const tmpRoot = process.env.E2E_TMP_DIR ? path.resolve(process.env.E2E_TMP_DIR) : os.tmpdir();
  await fs.mkdir(tmpRoot, { recursive: true });
  S.tmp = await fs.mkdtemp(path.join(tmpRoot, `dandi-e2e-${RUN}-`));
  // 전역 상태(모델 정책)는 단계마다 되돌리지만, 도중에 멈췄을 때를 대비해 시작 상태를 기억해 둔다.
  const initialModels = await modelsApi()
    .then((r) => new Map(r.data.models.map((m) => [m.id, m.status])))
    .catch(() => null);
  // 허브가 광고하는 최신 CLI tarball(내용 해시가 붙은 이름).
  CLI_LATEST = await fetch(u("/dandi-latest.json"))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (CLI_LATEST && typeof CLI_LATEST.tarball === "string") TARBALL_URL = `${BASE_URL}/${CLI_LATEST.tarball}`;
  console.log(`CLI tarball: ${TARBALL_URL}${CLI_LATEST ? "" : " (dandi-latest.json을 읽지 못해 예전 이름 사용)"}`);

  try {
    /* ---------------- 1) 익명 방문자 ---------------- */
    await step("1) 익명: 허브 접속 · dd_sid · 미니앱 실행 · 실행 수 · 익명 좋아요 · 글쓰기 제한", async (t) => {
      const ctx = await ensureAnon();
      const page = await ctx.newPage();
      try {
        const r = await page.goto(u("/"));
        t.must(r && r.status() === 200, `GET / 상태 코드 ${r?.status()}`);
        await page.getByRole("heading", { level: 1, name: "Dandi" }).waitFor();
        t.soft(await page.getByRole("heading", { name: "인기 미니앱" }).isVisible(), '허브에 "인기 미니앱" 구역 없음');
        t.soft(await page.getByRole("heading", { name: "커뮤니티 최근 글" }).isVisible(), '허브에 "커뮤니티 최근 글" 구역 없음');
        t.soft(await page.getByRole("heading", { name: "자료실 최근 파일" }).isVisible(), '허브에 "자료실 최근 파일" 구역 없음');
        t.soft((await page.locator("header .session").innerText()).includes("익명 방문자"), '헤더에 "익명 방문자" 없음');

        const sid = (await ctx.cookies(BASE_URL)).find((c) => c.name === "dd_sid");
        t.must(sid, "dd_sid 쿠키가 발급되지 않음");
        t.soft(/^s_[0-9a-f]{32}$/.test(sid.value), `dd_sid 형식이 예상과 다름: ${sid.value}`);
        t.soft(sid.httpOnly, "dd_sid 쿠키가 HttpOnly가 아님");
        t.note(`dd_sid=${sid.value}`);

        // 시드 미니앱 실행(임베드) + 실행 수 집계
        let act = waitForAction(page);
        const r2 = await page.goto(u("/apps/app_seed_quiz"));
        t.must(r2 && r2.status() === 200, `GET /apps/app_seed_quiz 상태 코드 ${r2?.status()}`);
        await page.getByRole("heading", { level: 1, name: "OX 퀴즈 미니앱" }).waitFor();
        const frame = page.locator("iframe.app-frame");
        await frame.waitFor();
        t.soft((await frame.getAttribute("src")) === "/examples/quiz.html", "iframe src가 /examples/quiz.html이 아님");
        const frameBody = page.frameLocator("iframe.app-frame").locator("body");
        await frameBody.waitFor();
        t.soft((await frameBody.innerText()).trim().length > 0, "iframe 안 예시 앱 내용이 비어 있음");
        t.soft(await page.getByRole("link", { name: "새 창으로 열기" }).isVisible(), '"새 창으로 열기" 링크 없음');
        const runs1 = await readRuns(page);
        await act;
        act = waitForAction(page);
        await page.reload();
        const runs2 = await readRuns(page);
        await act.catch(() => {});
        t.soft(runs2 === runs1 + 1, `새로고침 후 실행 수가 1 늘지 않음: ${runs1} -> ${runs2}`);
        t.note(`실행 수 ${runs1} -> ${runs2}`);

        // 익명 좋아요
        await page.goto(u("/community/post_seed_welcome"));
        const likeInfo = page.locator("main form span.muted", { hasText: /좋아요 \d+/ });
        const likeBefore = num((await likeInfo.innerText()).match(/좋아요 ([\d,]+)/)[1]);
        act = waitForAction(page);
        await page.getByRole("button", { name: "좋아요", exact: true }).click();
        await act;
        await page.getByRole("button", { name: "좋아요 취소" }).waitFor();
        const likeAfter = num((await likeInfo.innerText()).match(/좋아요 ([\d,]+)/)[1]);
        t.soft(likeAfter === likeBefore + 1, `좋아요 수가 1 늘지 않음: ${likeBefore} -> ${likeAfter}`);
        await page.reload();
        t.soft(
          (await page.getByRole("button", { name: "좋아요 취소" }).count()) === 1,
          "새로고침 후 익명 좋아요 상태가 유지되지 않음",
        );

        // 익명은 글쓰기 불가
        await page.goto(u("/community"));
        t.soft(
          (await page.locator("main").getByRole("link", { name: "글쓰기", exact: true }).count()) === 0,
          '익명 방문자에게 "글쓰기" 버튼이 보임',
        );
        t.soft(
          (await mainText(page)).includes("글쓰기와 댓글은 교사 로그인 후 사용할 수 있습니다"),
          "커뮤니티 목록에 로그인 안내가 없음",
        );
        await page.goto(u("/community/new"));
        t.soft(
          (await mainText(page)).includes("글쓰기는 교사 로그인이 필요합니다"),
          "/community/new에 교사 로그인 안내가 없음",
        );
        t.soft((await page.locator('textarea[name="body"]').count()) === 0, "익명 방문자에게 글쓰기 폼이 보임");
      } finally {
        await page.close();
      }
    });

    /* ---------------- 2) 교사 A 로그인 + 템플릿 복사 ---------------- */
    await step("2) 교사 A 데모 로그인 → 템플릿 작업 지시서 복사 → 복사 수 증가", async (t) => {
      const ctx = await ensureTeacherA();
      const page = await ctx.newPage();
      try {
        await page.goto(u("/studio"));
        t.soft((await page.locator("header .session").innerText()).includes(`${TEACHER_A} (중) · 교사`), "헤더에 교사 A 프로필(중·교사) 표시 없음");

        await page.goto(u("/templates"));
        await page.getByRole("heading", { level: 1, name: "템플릿 갤러리" }).waitFor();
        const firstLink = page.locator("main ul.list > li strong a").first();
        const tplTitle = (await firstLink.innerText()).trim();
        await Promise.all([page.waitForURL(/\/templates\/[^/?]+$/), firstLink.click()]);
        const tplId = new URL(page.url()).pathname.split("/").pop();
        await page.getByRole("heading", { level: 1, name: tplTitle }).waitFor();
        t.note(`템플릿 ${tplId} "${tplTitle}"`);

        const before = await readCopies(page);
        const workOrder = await page.locator("main pre").first().textContent();
        const act = waitForAction(page);
        await page.getByRole("button", { name: "작업 지시서 복사" }).click();
        await page.getByText("복사했습니다. AI 코딩 도구의 입력창에 붙여 넣으십시오.").waitFor();
        await act;
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        t.soft(
          clip.replace(/\r\n/g, "\n") === workOrder.replace(/\r\n/g, "\n"),
          `클립보드 내용이 작업 지시서와 다름(길이 ${clip.length} vs ${workOrder.length})`,
        );
        await page.reload();
        const after = await readCopies(page);
        t.soft(after === before + 1, `복사 수가 1 늘지 않음: ${before} -> ${after}`);
        t.note(`복사 수 ${before} -> ${after}`);

        await page.goto(u("/templates"));
        const li = page.locator("main ul.list > li", { hasText: tplTitle }).first();
        const listCopies = num((await li.innerText()).match(/복사 ([\d,]+)회/)[1]);
        t.soft(listCopies === after, `갤러리 목록의 복사 수(${listCopies})가 상세(${after})와 다름`);
      } finally {
        await page.close();
      }
    });

    /* ---------------- 3) 앱 등록 + 승인 대기 ---------------- */
    await step("3) 교사 A 앱 등록(셀프점검) · 승인 대기 앱 숨김/404 · 승인 후 공개", async (t) => {
      const ctxA = await ensureTeacherA();
      const anon = await ensureAnon();
      const page = await ctxA.newPage();
      const anonPage = await anon.newPage();
      try {
        // (a) 내부 승인 불필요 앱
        const pubTitle = `E2E 공개앱 ${RUN}`;
        await page.goto(u("/studio/apps/new"));
        await page.getByRole("heading", { level: 1, name: "미니앱 등록" }).waitFor();
        t.soft(
          await page.locator('input[name="schoolLevels"][value="middle"]').isChecked(),
          "학교급 기본값이 프로필 학교급(중)으로 체크되지 않음",
        );
        await fillAppForm(page, {
          title: pubTitle,
          description: "수업 도입용 OX 퀴즈 예시",
          url: "https://example.com/e2e-public",
          levels: ["middle"],
          category: "class",
          collects: "no",
          storage: "저장 안 함",
          retention: "저장 안 함",
          external: "no",
          approval: "no",
        });
        const pubId = await submitAppForm(page);
        state.pubAppId = pubId;
        t.note(`공개 앱 ${pubId}`);
        t.soft((await page.locator("main h1").innerText()).trim() === pubTitle, "등록 후 앱 화면 제목이 다름");
        t.soft((await mainText(page)).includes("학생 개인정보 없음"), '공개 앱에 "학생 개인정보 없음" 배지 없음');
        t.soft((await page.locator("iframe.app-frame").getAttribute("src")) === "https://example.com/e2e-public", "iframe src가 등록 URL과 다름");

        await anonPage.goto(u("/apps"));
        t.soft(
          (await anonPage.locator("main").getByRole("link", { name: pubTitle }).count()) >= 1,
          "익명 /apps 목록에 공개 앱이 없음",
        );

        // (b) 학생 개인정보 처리 + 승인 불필요 조합은 거절되어야 함(F-16 강제)
        await page.goto(u("/studio/apps/new"));
        await fillAppForm(page, {
          title: `E2E 거절앱 ${RUN}`,
          description: "",
          url: "https://example.com/e2e-reject",
          levels: ["special"],
          category: "guidance",
          collects: "yes",
          storage: "Supabase(서울 리전)",
          retention: "학기 종료 시 삭제",
          external: "no",
          approval: "no",
        });
        t.soft(
          await page.getByText("학교 내부 승인 필요 여부를 \"예\"로 선택해야 등록됩니다").isVisible(),
          "개인정보 처리 선택 시 클라이언트 안내가 보이지 않음",
        );
        let act = waitForAction(page);
        await page.getByRole("button", { name: "셀프점검 완료 후 등록" }).click();
        await act;
        await page
          .getByText("학생 개인정보를 처리하는 앱은 학교 내부 승인 필요 여부를 확인해야 합니다")
          .waitFor()
          .catch(() => {});
        t.soft(
          await page.getByText("학생 개인정보를 처리하는 앱은 학교 내부 승인 필요 여부를 확인해야 합니다").isVisible(),
          "개인정보 처리 + 승인 불필요 조합이 거절되지 않음",
        );
        t.soft(new URL(page.url()).pathname === "/studio/apps/new", "잘못된 셀프점검인데 페이지가 이동함");

        // (c) 승인 대기 앱
        const pendTitle = `E2E 승인대기앱 ${RUN}`;
        state.pendTitle = pendTitle;
        await page.goto(u("/studio/apps/new"));
        await fillAppForm(page, {
          title: pendTitle,
          description: "상담 기록을 다루는 학생지도 앱",
          url: "https://example.com/e2e-pending",
          levels: ["special"],
          category: "guidance",
          collects: "yes",
          storage: "Supabase(서울 리전)",
          retention: "학기 종료 시 삭제",
          external: "no",
          approval: "yes",
        });
        const pendId = await submitAppForm(page);
        state.pendAppId = pendId;
        t.note(`승인 대기 앱 ${pendId}`);
        const aText = await mainText(page);
        t.soft(aText.includes("승인 대기: 셀프점검에서 학교 내부 승인이 필요하다고 답한 앱입니다"), '작성자 화면에 "승인 대기" 안내 없음');
        t.soft(await page.locator("main .badge", { hasText: "승인 대기" }).first().isVisible(), '작성자 화면에 "승인 대기" 배지 없음');
        t.soft(aText.includes("이 앱은 학생 개인정보를 처리합니다"), "개인정보 처리 경고 문구 없음");
        t.must(
          await page.getByRole("button", { name: "내부 승인 완료 표시" }).isVisible(),
          '작성자에게 "내부 승인 완료 표시" 버튼이 없음',
        );

        // 익명에게는 보이지 않아야 함
        for (const p of ["/", "/?level=special", "/apps", "/apps?level=special"]) {
          await anonPage.goto(u(p));
          t.soft(!(await mainText(anonPage)).includes(pendTitle), `익명 ${p}에 승인 대기 앱이 보임`);
        }
        const r404 = await anonPage.goto(u(`/apps/${pendId}`));
        t.soft(r404 && r404.status() === 404, `익명 GET /apps/${pendId} 상태 코드 ${r404?.status()} (404 기대)`);
        t.soft(!(await anonPage.content()).includes(pendTitle), "익명 404 화면에 승인 대기 앱 제목이 노출됨");
        const rawAnon = await anon.request.get(u(`/apps/${pendId}`));
        t.soft(rawAnon.status() === 404, `익명 HTTP GET 상태 코드 ${rawAnon.status()} (404 기대)`);

        // 교사 B에게도 404
        const ctxB = await ensureTeacherB();
        const pageB = await ctxB.newPage();
        try {
          const rb = await pageB.goto(u(`/apps/${pendId}`));
          t.soft(rb && rb.status() === 404, `교사 B GET /apps/${pendId} 상태 코드 ${rb?.status()} (404 기대)`);
          t.soft(!(await pageB.title()).includes(pendTitle), "교사 B 404 화면 <title>에 앱 제목이 노출됨");
          await pageB.goto(u("/apps"));
          t.soft(!(await mainText(pageB)).includes(pendTitle), "교사 B /apps에 승인 대기 앱이 보임");
        } finally {
          await pageB.close();
        }

        // 작성자 내부 승인 완료 표시
        await page.goto(u(`/apps/${pendId}`));
        act = waitForAction(page);
        await page.getByRole("button", { name: "내부 승인 완료 표시" }).click();
        await act;
        await page.locator("main .badge", { hasText: "내부 승인 완료" }).first().waitFor();
        t.soft(
          !(await mainText(page)).includes("승인 대기: 셀프점검에서"),
          '승인 후에도 작성자 화면에 "승인 대기" 안내가 남음',
        );

        // 공개 확인(익명). 실행 수를 늘리지 않도록 JS 없는 HTTP GET으로 상세를 본다.
        await anonPage.goto(u("/apps"));
        t.soft((await anonPage.locator("main").getByRole("link", { name: pendTitle }).count()) >= 1, "승인 후 익명 /apps에 앱이 없음");
        await anonPage.goto(u("/?level=special"));
        t.soft((await mainText(anonPage)).includes(pendTitle), "승인 후 익명 허브(특수)에 앱이 없음");
        const r200 = await anon.request.get(u(`/apps/${pendId}`));
        t.soft(r200.status() === 200, `승인 후 익명 GET /apps/${pendId} 상태 코드 ${r200.status()}`);
        const html = await r200.text();
        t.soft(html.includes("내부 승인 완료"), '승인 후 상세에 "내부 승인 완료" 배지 없음');
        const ctxB2 = await ensureTeacherB();
        const rb2 = await ctxB2.request.get(u(`/apps/${pendId}`));
        t.soft(rb2.status() === 200, `승인 후 교사 B GET 상태 코드 ${rb2.status()}`);
      } finally {
        await page.close();
        await anonPage.close();
      }
    });

    /* ---------------- 4) 개인정보 경고·차단 · 서버 마스킹 · 글/댓글 ---------------- */
    await step("4) 글쓰기 개인정보 경고·차단 → 서버 마스킹(CLI API) → 일반 글·댓글 작성", async (t) => {
      const ctxA = await ensureTeacherA();
      const anon = await ensureAnon();
      const page = await ctxA.newPage();
      try {
        await page.goto(u("/community"));
        t.soft(
          (await page.locator("main").getByRole("link", { name: "글쓰기", exact: true }).count()) === 1,
          '교사에게 "글쓰기" 버튼이 보이지 않음',
        );

        // 클라이언트 1차 필터
        await page.goto(u("/community/new"));
        await page.getByRole("heading", { level: 1, name: "글쓰기" }).waitFor();
        await page.locator('input[name="title"]').fill(`E2E 개인정보 차단 ${RUN}`);
        await page.locator('textarea[name="body"]').pressSequentially(`연락처 ${PHONE}`, { delay: 5 });
        const warn = page.locator(".pii-warning");
        await warn.first().waitFor();
        const warnText = await warn.first().innerText();
        t.soft(warnText.includes("개인정보로 보이는 내용이 있습니다") && warnText.includes("휴대전화번호"), `경고 문구가 예상과 다름: ${warnText}`);
        t.soft((await page.locator('textarea[name="body"]').getAttribute("aria-invalid")) === "true", "textarea aria-invalid가 true가 아님");
        const tr = trackActions(page);
        await page.getByRole("button", { name: "등록", exact: true }).click();
        await page.waitForTimeout(1500);
        tr.stop();
        t.soft(tr.count === 0, `개인정보가 있는데 서버 액션이 ${tr.count}번 전송됨`);
        t.soft(new URL(page.url()).pathname === "/community/new", `개인정보 글 제출 후 페이지가 이동함: ${page.url()}`);

        // 서버 2차 마스킹(클라이언트 필터 우회): CLI API로 개인정보 포함 앱 등록
        const token = await cliTokenForA();
        const maskTitle = `E2E 마스킹앱 ${RUN}`;
        const res = await apiPost("/api/cli/apps", token, {
          title: maskTitle,
          description: `담당 연락처 ${PHONE}, 메일 ${EMAIL}`,
          url: "https://example.com/e2e-masked",
          schoolLevels: ["high"],
          category: "etc",
          privacyCheck: {
            collectsStudentData: false,
            storageLocation: "저장 안 함 (문의 02-123-4567)",
            retention: "저장 안 함",
            externalTransfer: false,
            needsSchoolApproval: false,
          },
        });
        t.must(res.status === 201, `POST /api/cli/apps 상태 코드 ${res.status}: ${JSON.stringify(res.data)}`);
        const maskId = res.data.id;
        t.note(`마스킹 확인용 앱 ${maskId}`);
        const ap = await anon.newPage();
        try {
          const r = await ap.goto(u(`/apps/${maskId}`));
          t.must(r && r.status() === 200, `익명 GET /apps/${maskId} 상태 코드 ${r?.status()}`);
          const txt = await mainText(ap);
          t.soft(txt.includes("담당 연락처 ***, 메일 ***"), `설명이 마스킹되지 않음: ${txt.match(/담당 연락처[^\n]*/)?.[0]}`);
          t.soft(!txt.includes(PHONE) && !txt.includes(EMAIL), "휴대전화번호/이메일 원문이 화면에 남아 있음");
          t.soft(txt.includes("저장 안 함 (문의 ***)") && !txt.includes("02-123-4567"), "셀프점검 저장 위치의 전화번호가 마스킹되지 않음");
        } finally {
          await ap.close();
        }

        // 일반 글 작성
        await page.goto(u("/community/new"));
        const postTitle = `E2E 수업 아이디어 ${RUN}`;
        const postBody = "중학교 1학년 과학 도입 활동으로 OX 퀴즈 미니앱을 써 보았습니다.";
        await page.locator('input[name="title"]').fill(postTitle);
        await page.locator('select[name="category"]').selectOption("info");
        t.soft((await page.locator('select[name="schoolLevel"]').inputValue()) === "middle", "글 학교급 기본값이 프로필(중)이 아님");
        await page.locator('textarea[name="body"]').fill(postBody);
        t.soft((await page.locator(".pii-warning").count()) === 0, "개인정보 없는 글에 경고가 표시됨");
        await Promise.all([
          page.waitForURL(/\/community\/post_[A-Za-z0-9_-]+$/, { timeout: 20000 }),
          page.getByRole("button", { name: "등록", exact: true }).click(),
        ]);
        state.postId = new URL(page.url()).pathname.split("/").pop();
        t.note(`글 ${state.postId}`);
        t.soft((await page.locator("main h1").innerText()).trim() === postTitle, "글 화면 제목이 다름");
        t.soft((await mainText(page)).includes(postBody), "글 본문이 보이지 않음");

        // 댓글: 개인정보가 있으면 차단, 없으면 등록
        const cbox = page.locator('textarea[name="body"]');
        await cbox.fill(`제 메일은 ${EMAIL} 입니다`);
        await page.locator(".pii-warning").first().waitFor();
        const tr2 = trackActions(page);
        await page.getByRole("button", { name: "댓글 등록" }).click();
        await page.waitForTimeout(1000);
        tr2.stop();
        t.soft(tr2.count === 0, "개인정보가 있는 댓글이 서버로 전송됨");
        const comment = `좋은 자료 감사합니다 ${RUN}`;
        await cbox.fill(comment);
        const act = waitForAction(page);
        await page.getByRole("button", { name: "댓글 등록" }).click();
        await act;
        await page.locator("main ul.list li", { hasText: comment }).waitFor();
        t.soft(await page.getByRole("heading", { name: "댓글 1" }).isVisible(), '"댓글 1" 제목이 보이지 않음');
        t.soft((await cbox.inputValue()) === "", "댓글 등록 후 입력창이 비워지지 않음");

        // 익명에게도 글/댓글이 보임
        const ap2 = await anon.newPage();
        try {
          await ap2.goto(u(`/community/${state.postId}`));
          const at = await mainText(ap2);
          t.soft(at.includes(postBody) && at.includes(comment), "익명에게 글/댓글이 보이지 않음");
        } finally {
          await ap2.close();
        }
      } finally {
        await page.close();
      }
    });

    /* ---------------- 5) 자료 업로드 · 무로그인 다운로드 ---------------- */
    await step("5) 자료 업로드(개인정보 미포함 확인 필수) · 익명 다운로드 · 실행 파일 경고", async (t) => {
      const ctxA = await ensureTeacherA();
      const anon = await ensureAnon();
      const pdfName = `e2e-guide-${RUN}.pdf`;
      const pdfPath = path.join(S.tmp, pdfName);
      const pdfBytes = Buffer.from(
        "%PDF-1.4\n%E2E\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
        "latin1",
      );
      await fs.writeFile(pdfPath, pdfBytes);
      const exeName = `e2e-tool-${RUN}.exe`;
      const exePath = path.join(S.tmp, exeName);
      await fs.writeFile(exePath, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(254)]));
      const pdfTitle = `E2E 수업 안내 PDF ${RUN}`;
      const exeTitle = `E2E 채점 도우미 ${RUN}`;

      const page = await ctxA.newPage();
      try {
        // (a) 확인 체크 없이 → 브라우저 required가 막음
        await page.goto(u("/files/upload"));
        await page.getByRole("heading", { level: 1, name: "자료 업로드" }).waitFor();
        await fillUploadForm(page, { file: pdfPath, title: pdfTitle, description: "E2E 테스트용", confirm: false });
        const tr = trackActions(page);
        await page.getByRole("button", { name: "업로드", exact: true }).click();
        await page.waitForTimeout(1000);
        tr.stop();
        t.soft(tr.count === 0, "개인정보 미포함 확인 없이 서버로 제출됨(required 미동작)");
        t.soft(new URL(page.url()).pathname === "/files/upload", "확인 없이 업로드 후 페이지가 이동함");
        const missing = await page.locator('input[name="noStudentData"]').evaluate((el) => el.validity.valueMissing);
        t.soft(missing, "noStudentData 체크박스가 required로 막히지 않음");

        // (b) required를 제거해 우회 → 서버가 거절해야 함
        await page.locator('input[name="noStudentData"]').evaluate((el) => el.removeAttribute("required"));
        const act = waitForAction(page);
        await page.getByRole("button", { name: "업로드", exact: true }).click();
        await act;
        const srvErr = page.getByText("파일에 학생 개인정보가 없음을 확인하는 항목에 체크하십시오.");
        await srvErr.waitFor().catch(() => {});
        t.soft(await srvErr.isVisible(), "체크 없이 우회 제출했을 때 서버 오류 문구가 보이지 않음");
        t.soft(new URL(page.url()).pathname === "/files/upload", "서버 거절 후 페이지가 이동함");
        await page.goto(u("/files"));
        t.soft(!(await mainText(page)).includes(pdfTitle), "확인 없이 제출한 파일이 목록에 저장됨");
      } finally {
        await page.close();
      }

      // (c) 확인 체크 후 정상 업로드
      const pdf = await uploadOk(ctxA, { file: pdfPath, title: pdfTitle, description: "E2E 테스트용", level: "all" });
      t.note(`PDF 자료 ${pdf.id}`);

      // (d) 익명 다운로드
      const ap = await anon.newPage();
      try {
        await ap.goto(u("/files"));
        const row = ap.locator("main table tbody tr", { hasText: pdfTitle }).first();
        await row.waitFor();
        t.soft((await row.innerText()).includes(pdfName), "목록에 원래 파일 이름이 보이지 않음");
        t.soft((await row.locator(".pii-warning").count()) === 0, "PDF에 실행 파일 경고가 붙음");
        const before = num(await row.locator("td").nth(4).innerText());

        const [dl] = await Promise.all([
          ap.waitForEvent("download"),
          row.getByRole("link", { name: "다운로드" }).click(),
        ]);
        t.soft(dl.suggestedFilename() === pdfName, `다운로드 파일 이름이 다름: ${dl.suggestedFilename()}`);
        const dlPath = await dl.path();
        const dlBytes = await fs.readFile(dlPath);
        t.soft(dlBytes.equals(pdfBytes), "브라우저로 받은 파일 내용이 원본과 다름");

        const res = await anon.request.get(u(pdf.href));
        t.soft(res.status() === 200, `GET ${pdf.href} 상태 코드 ${res.status()}`);
        const cd = res.headers()["content-disposition"] || "";
        t.soft(/^attachment;/.test(cd) && cd.includes(pdfName), `Content-Disposition이 예상과 다름: ${cd}`);
        t.soft((res.headers()["content-type"] || "").startsWith("application/pdf"), `Content-Type: ${res.headers()["content-type"]}`);
        t.soft((await res.body()).equals(pdfBytes), "API로 받은 파일 내용이 원본과 다름");
        const head = await anon.request.head(u(pdf.href));
        t.soft(head.status() === 200, `HEAD 상태 코드 ${head.status()}`);

        await ap.reload();
        const after = num(await ap.locator("main table tbody tr", { hasText: pdfTitle }).first().locator("td").nth(4).innerText());
        t.soft(after === before + 2, `다운로드 수가 2(브라우저 1 + GET 1, HEAD 제외) 늘지 않음: ${before} -> ${after}`);
        t.note(`다운로드 수 ${before} -> ${after}`);
        const missingRes = await anon.request.get(u("/api/files/file_doesnotexist/download"));
        t.soft(missingRes.status() === 404, `없는 파일 다운로드 상태 코드 ${missingRes.status()}`);
      } finally {
        await ap.close();
      }

      // (e) 실행 파일 경고
      const exe = await uploadOk(ctxA, { file: exePath, title: exeTitle, description: "E2E 실행 파일", level: "middle" });
      t.note(`EXE 자료 ${exe.id}`);
      const ap2 = await anon.newPage();
      try {
        await ap2.goto(u("/files"));
        const row = ap2.locator("main table tbody tr", { hasText: exeTitle }).first();
        await row.waitFor();
        const w = row.locator(".pii-warning");
        t.soft(
          (await w.count()) === 1 && (await w.innerText()).includes("실행 파일입니다. 올린 교사와 출처를 확인한 뒤 실행하십시오."),
          "자료실 목록에 실행 파일 경고가 없음",
        );
        await ap2.goto(u("/"));
        t.soft(
          (await ap2.locator("main section", { hasText: "자료실 최근 파일" }).innerText()).includes("실행 파일입니다"),
          "허브 자료실 구역에 실행 파일 경고가 없음",
        );
        const res = await anon.request.get(u(exe.href));
        t.soft(res.status() === 200, `EXE 다운로드 상태 코드 ${res.status()}`);
        t.soft(
          (res.headers()["content-type"] || "") === "application/vnd.microsoft.portable-executable",
          `EXE Content-Type: ${res.headers()["content-type"]}`,
        );
      } finally {
        await ap2.close();
      }
    });

    /* ---------------- 6) CLI v0.2: 로그인 · init · deploy · publish ---------------- */
    await step("6) CLI v0.2: CI 토큰(--token-stdin) · 브라우저 승인 로그인(이미 로그인·--force·거부) · whoami(ASCII JSON) · init · exit 2 사용법 오류 · deploy 미리보기 · deploy가 만든 dandi.json 확인 · 한국어 이름 · publish(공개/승인 대기/승인 유지/이전 버전 유지) · 교사별 파일 저장소", async (t) => {
      const ctxA = await ensureTeacherA();
      const anon = await ensureAnon();

      // (a) CI용 토큰: /studio/cli에서 발급 → 표준입력으로 로그인
      const { token, loginCmd } = await issueCliTokenViaPage(ctxA);
      t.soft(
        loginCmd.includes(`login --token-stdin --hub ${BASE_URL}`) && loginCmd.includes(TARBALL_URL) && !loginCmd.includes(token),
        `화면의 CI 로그인 명령이 예상과 다름(토큰은 표준입력으로 넘겨야 함): ${loginCmd}`,
      );
      const cfgCi = path.join(S.tmp, "cli-config-ci");
      const envCi = cliEnv(cfgCi);

      const noLogin = await runCli(["whoami", "--json"], { cwd: S.tmp, env: envCi });
      t.soft(noLogin.code === 4 && noLogin.json?.ok === false, `로그인 전 whoami 종료 코드 ${noLogin.code} (4 기대): ${noLogin.stdout}`);

      const positional = await runCli(["login", token, "--hub", BASE_URL], { cwd: S.tmp, env: envCi });
      t.soft(
        positional.code === 2 && /--token-stdin/.test(positional.stdout + positional.stderr) && !(positional.stdout + positional.stderr).includes(token),
        `login <토큰> 위치 인자가 exit 2 + --token-stdin 안내가 아님: ${positional.code} ${positional.stderr.slice(0, 200)}`,
      );

      const ci = await runCli(["login", "--token-stdin", "--hub", BASE_URL], { cwd: S.tmp, env: envCi, input: `${token}\n` });
      t.must(ci.code === 0, `login --token-stdin 종료 코드 ${ci.code}: ${ci.stderr || ci.stdout}`);
      t.soft(ci.stdout.includes("로그인했습니다") && ci.stdout.includes(TEACHER_A), `login --token-stdin 출력: ${ci.stdout}`);
      t.soft(!(ci.stdout + ci.stderr).includes(token), "login 출력에 토큰 원문이 보임");
      const cfg = JSON.parse(await fs.readFile(path.join(cfgCi, "config.json"), "utf8"));
      t.soft(cfg.token === token && cfg.hub === BASE_URL, "설정 파일에 토큰/허브가 저장되지 않음");
      state.cliConfigDir = cfgCi;
      memo.cliConfig = Promise.resolve(cfgCi);

      // (b) 브라우저 승인 로그인(device flow): 비TTY → JSON + exit 5 → 교사가 /device에서 승인 → login --wait
      const cfgDev = path.join(S.tmp, "cli-config-device");
      const envDev = cliEnv(cfgDev);
      const start = await runCli(["login", "--hub", BASE_URL, "--json"], { cwd: S.tmp, env: envDev });
      t.must(start.code === 5, `login --json 종료 코드 ${start.code} (5 기대): ${start.stdout}${start.stderr}`);
      const pend = start.json ?? {};
      t.soft(pend.ok === true && pend.status === "pending", `login --json 출력: ${start.stdout}`);
      t.must(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(pend.user_code ?? ""), `user_code 형식: ${pend.user_code}`);
      t.soft(pend.verification_uri === `${BASE_URL}/device`, `verification_uri: ${pend.verification_uri}`);
      t.must(
        pend.verification_uri_complete === `${BASE_URL}/device?code=${pend.user_code}`,
        `verification_uri_complete: ${pend.verification_uri_complete}`,
      );
      t.soft(
        typeof pend.next_step === "string" && pend.next_step.includes(TARBALL_URL) && pend.next_step.includes("login --wait --json"),
        `next_step: ${pend.next_step}`,
      );
      t.soft(!("device_code" in pend), "login --json 출력에 device_code가 노출됨");
      t.soft(typeof pend.agent_instructions === "string" && pend.agent_instructions.includes("verification_uri_complete"), `login --json에 agent_instructions가 없음: ${pend.agent_instructions}`);
      t.soft(Number.isInteger(pend.expires_in) && pend.expires_in > 500 && pend.expires_in <= 600, `login --json expires_in: ${pend.expires_in}`);

      // 승인 전 --wait는 시간 안에 끝나지 않으면 exit 5
      const early = await runCli(["login", "--wait", "--json", "--hub", BASE_URL, "--timeout", "3"], { cwd: S.tmp, env: envDev });
      t.soft(early.code === 5 && early.json?.status === "pending", `승인 전 login --wait 종료 코드 ${early.code} (5 기대): ${early.stdout}`);

      const pendingFile = JSON.parse(await fs.readFile(path.join(cfgDev, "pending.json"), "utf8").catch(() => "{}"));
      t.soft(typeof pendingFile.device_code === "string" && pendingFile.device_code.length > 20, "pending.json에 device_code가 없음");

      const dp = await ctxA.newPage();
      try {
        const r = await dp.goto(pend.verification_uri_complete);
        t.must(r && r.status() === 200, `/device 상태 코드 ${r?.status()}`);
        await dp.getByRole("heading", { level: 1, name: "기기 연결 승인" }).waitFor();
        const dt = await mainText(dp);
        t.soft(dt.includes(pend.user_code), "승인 화면에 CLI와 같은 코드가 보이지 않음");
        t.soft(dt.includes("AI 대화창·터미널에 보이는 코드와 같나요?"), "승인 화면에 코드 대조 질문이 없음");
        t.soft(dt.includes("직접 AI에게 Dandi 로그인을 시킨 경우에만 승인하십시오"), "승인 화면에 피싱 경고문이 없음");
        t.soft(dt.includes("사이트 올리기·허브 등록·스킬 게시"), "승인 화면에 허용 권한 설명이 없음");
        await Promise.all([
          dp.waitForURL((url) => new URL(url).pathname === "/device", { timeout: 20000 }),
          dp.getByRole("button", { name: "승인", exact: true }).click(),
        ]);
        await dp.getByText("승인했습니다").waitFor();
      } finally {
        await dp.close();
      }
      const anonDevice = await anon.request.get(pend.verification_uri_complete, { maxRedirects: 0 });
      t.soft(
        [302, 303, 307].includes(anonDevice.status()) && (anonDevice.headers().location || "").includes("/login?next="),
        `익명 /device 요청이 로그인으로 보내지지 않음: ${anonDevice.status()} ${anonDevice.headers().location}`,
      );

      const wait = await runCli(["login", "--wait", "--json", "--hub", BASE_URL], { cwd: S.tmp, env: envDev });
      t.must(wait.code === 0, `login --wait 종료 코드 ${wait.code}: ${wait.stdout}${wait.stderr}`);
      t.soft(wait.json?.ok === true && wait.json?.status === "logged_in" && wait.json?.user?.name === TEACHER_A, `login --wait 출력: ${wait.stdout}`);
      t.soft(!/dd_cli_/.test(wait.stdout + wait.stderr), "login --wait 출력에 토큰 원문이 보임");
      const whoDev = await runCli(["whoami", "--json"], { cwd: S.tmp, env: envDev });
      t.soft(whoDev.code === 0 && whoDev.json?.user?.name === TEACHER_A, `device 로그인 whoami: ${whoDev.code} ${whoDev.stdout}`);
      // --json 출력: PowerShell·cmd에서는 한글을 \uXXXX로 이스케이프하고, Git Bash·macOS·Linux에서는 UTF-8 그대로 둔다.
      // 어느 쪽이든 JSON.parse하면 한글이 그대로 나온다(위 확인).
      t.soft(
        JSON_ESCAPED
          ? isAscii(whoDev.stdout) && whoDev.stdout.includes("\\u") && !whoDev.stdout.includes(TEACHER_A)
          : whoDev.stdout.includes(TEACHER_A),
        `whoami --json 출력 인코딩이 셸과 맞지 않음(이스케이프=${JSON_ESCAPED}): ${whoDev.stdout.slice(0, 160)}`,
      );
      t.soft(!("cli_update" in (whoDev.json ?? {})), `허브 최신 CLI와 같은 빌드인데 cli_update 안내가 붙음: ${JSON.stringify(whoDev.json?.cli_update)}`);

      // 이미 로그인된 상태의 login은 새 승인 요청을 만들지 않고 exit 0 status logged_in으로 끝난다.
      const again = await runCli(["login", "--hub", BASE_URL, "--json"], { cwd: S.tmp, env: envDev });
      t.soft(
        again.code === 0 && again.json?.ok === true && again.json?.status === "logged_in" && again.json?.already === true && again.json?.user?.name === TEACHER_A && !again.json?.user_code,
        `로그인된 상태의 login --json(exit 0 logged_in 기대): ${again.code} ${again.stdout.slice(0, 200)}`,
      );
      // --force면 새 device flow를 시작한다. 교사가 [거부]하면 login --wait는 exit 6이고, 바로 다시 시작하라는 next_step 없이 ASK를 지시한다.
      const forced = await runCli(["login", "--force", "--hub", BASE_URL, "--json"], { cwd: S.tmp, env: envDev });
      t.soft(
        forced.code === 5 && forced.json?.status === "pending" && /^[A-Z]{4}-[A-Z]{4}$/.test(forced.json?.user_code ?? "") && forced.json.user_code !== pend.user_code,
        `login --force --json(새 승인 요청 기대): ${forced.code} ${forced.stdout.slice(0, 200)}`,
      );
      if (forced.code === 5 && forced.json?.verification_uri_complete) {
        const dp2 = await ctxA.newPage();
        try {
          await dp2.goto(forced.json.verification_uri_complete);
          await dp2.getByRole("heading", { level: 1, name: "기기 연결 승인" }).waitFor();
          await Promise.all([
            dp2.waitForURL((url) => new URL(url).pathname === "/device", { timeout: 20000 }),
            dp2.getByRole("button", { name: "거부", exact: true }).click(),
          ]);
          await dp2.getByText("거부했습니다").waitFor();
        } finally {
          await dp2.close();
        }
        const denied = await runCli(["login", "--wait", "--json", "--hub", BASE_URL, "--timeout", "15"], { cwd: S.tmp, env: envDev });
        t.soft(
          denied.code === 6 && denied.json?.error?.code === "access_denied" && !denied.json?.next_step && /ASK/.test(denied.json?.agent_instructions ?? ""),
          `거부 뒤 login --wait(exit 6, next_step 없음, ASK 기대): ${denied.code} ${denied.stdout.slice(0, 240)}`,
        );
        const still = await runCli(["whoami", "--json"], { cwd: S.tmp, env: envDev });
        t.soft(still.code === 0 && still.json?.user?.name === TEACHER_A, `거부한 --force 로그인 뒤 기존 로그인이 사라짐: ${still.code} ${still.stdout.slice(0, 160)}`);
      }
      if (pendingFile.device_code) {
        const reuse = await fetch(u("/api/cli/device/token"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: pendingFile.device_code }),
        });
        const rb = parseMaybeJson(await reuse.text());
        t.soft(
          reuse.status === 400 && typeof rb?.error === "string" && !rb?.token,
          `한 번 쓴 device_code로 토큰을 다시 받음(1회용 아님): ${reuse.status} ${JSON.stringify(rb).slice(0, 120)}`,
        );
      }

      // (c) whoami · init · deploy (CI 토큰으로 로그인한 설정 사용)
      const projDir = path.join(S.tmp, `cli-site-${RUN}`);
      await fs.mkdir(projDir, { recursive: true });
      const who = await runCli(["whoami"], { cwd: projDir, env: envCi });
      t.soft(who.code === 0 && who.stdout.includes(`${TEACHER_A} (교사 · 중)`), `whoami 출력: ${who.stdout}${who.stderr}`);

      const init = await runCli(["init"], { cwd: projDir, env: envCi });
      t.must(init.code === 0, `init 종료 코드 ${init.code}: ${init.stderr}`);
      t.soft(init.stdout.includes("만들었습니다: dandi.json") && init.stdout.includes("만들었습니다: llms.txt"), `init 출력: ${init.stdout}`);
      const manifestPath = path.join(projDir, "dandi.json");
      let manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      t.soft("siteId" in manifest && "projectId" in manifest, "dandi.json에 siteId/projectId 칸이 없음");
      t.soft(manifest.privacyCheck?.collectsStudentData === null, "init이 셀프점검 항목을 미리 채움");

      // 사용법 오류는 exit 2: 올린 사이트도 --url도 없는 publish(nothing_to_publish), 없는 폴더(folder_not_found),
      // index.html이 없는 폴더(missing_index). 폴더를 모르면 next_step에 <폴더> 같은 자리표시자를 넣지 않는다.
      const nothing = await runCli(["publish", "--json"], { cwd: projDir, env: envCi });
      t.soft(nothing.code === 2 && nothing.json?.error?.code === "nothing_to_publish", `deploy 전 publish(exit 2 nothing_to_publish 기대): ${nothing.code} ${nothing.stdout.slice(0, 200)}`);
      const noFolder = await runCli(["deploy", "no-such-folder", "--json"], { cwd: projDir, env: envCi });
      t.soft(
        noFolder.code === 2 && noFolder.json?.error?.code === "folder_not_found" && !String(noFolder.json?.next_step ?? "").includes("<"),
        `없는 폴더 deploy(exit 2 folder_not_found 기대): ${noFolder.code} ${noFolder.stdout.slice(0, 200)}`,
      );
      await fs.mkdir(path.join(projDir, "empty-folder"), { recursive: true });
      const noIndexDir = await runCli(["deploy", "empty-folder", "--json"], { cwd: projDir, env: envCi });
      t.soft(
        noIndexDir.code === 2 && noIndexDir.json?.error?.code === "missing_index" && !String(noIndexDir.json?.next_step ?? "").includes("<"),
        `index.html 없는 폴더 deploy(exit 2 missing_index 기대): ${noIndexDir.code} ${noIndexDir.stdout.slice(0, 200)}`,
      );

      const heading = `E2E 호스팅 사이트 ${RUN}`;
      const marker = `js-ok-${RUN}`;
      await writeStaticSite(path.join(projDir, "dist"), { heading, marker });
      await fs.writeFile(path.join(projDir, "dist", ".env"), "SECRET=should-not-upload\n", "utf8");
      const dep = await runCli(["deploy", "--json"], { cwd: projDir, env: envCi });
      t.must(dep.code === 0 && dep.json?.ok === true, `deploy 종료 코드 ${dep.code}: ${dep.stdout}${dep.stderr}`);
      t.soft(jsonEncodingOk(dep.stdout), "deploy --json 출력 인코딩이 셸과 맞지 않음");
      t.soft(String(dep.json?.next_step ?? "").startsWith(`npx -y ${TARBALL_URL} `), `deploy next_step이 최신 CLI 이름(${TARBALL_URL})을 쓰지 않음: ${dep.json?.next_step}`);
      const previewUrl = dep.json.previewUrl;
      t.must(
        typeof previewUrl === "string" && new RegExp(`^http://${dep.json.slug}--[a-z0-9]{10}\\.localhost:${new URL(BASE_URL).port}/$`).test(previewUrl),
        `previewUrl 형식: ${previewUrl}`,
      );
      t.note(`미리보기 ${previewUrl}`);
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      t.soft(manifest.siteId === dep.json.siteId && manifest.lastDeployId === dep.json.deployId, "deploy 결과가 dandi.json에 기록되지 않음");
      const human = await runCli(["deploy"], { cwd: projDir, env: envCi });
      t.soft(human.code === 0 && human.stdout.split(/\r?\n/).some((l) => /^http:\/\/\S+--[a-z0-9]{10}\.localhost:\d+\/$/.test(l.trim())), `사람용 deploy 출력에 미리보기 주소 줄이 없음: ${human.stdout}`);
      const previewUrlLatest = human.code === 0 ? human.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => /^http:\/\/\S+--[a-z0-9]{10}\.localhost:\d+\/$/.test(l)) : null;

      // 미리보기를 Chrome으로 연다(허브와 다른 origin: *.localhost).
      const pv = await inspectSiteInChrome(anon, previewUrlLatest || previewUrl);
      t.must(pv.status === 200, `미리보기 상태 코드 ${pv.status}`);
      t.soft(pv.h1 === heading, `미리보기 제목: ${pv.h1}`);
      t.soft(pv.color === "rgb(12, 34, 56)", `CSS가 적용되지 않음(color=${pv.color})`);
      t.soft(pv.js === marker, `JS가 실행되지 않음(${pv.js})`);
      t.soft(pv.imgOk, "PNG 이미지가 로드되지 않음");
      t.soft((pv.headers["x-robots-tag"] || "").includes("noindex"), "미리보기에 X-Robots-Tag: noindex 없음");
      t.soft(!pv.headers["set-cookie"], "사이트 응답에 Set-Cookie가 있음");
      t.soft((pv.headers["content-security-policy"] || "").includes("frame-ancestors"), "사이트 응답에 CSP frame-ancestors 없음");
      const envFile = await hostRequest(`${previewUrl}.env`);
      t.soft(envFile.status === 404, `.env 파일이 업로드되어 서빙됨: ${envFile.status}`);

      // publish: 셀프점검이 비어 있으면 exit 21
      const empty = await runCli(["publish", "--json"], { cwd: projDir, env: envCi });
      t.soft(empty.code === 21 && empty.json?.ok === false, `빈 셀프점검으로 publish 종료 코드 ${empty.code} (21 기대): ${empty.stdout}`);

      const title1 = `E2E 호스팅앱 ${RUN}`;
      Object.assign(manifest, { title: title1, description: "허브 호스팅으로 올린 E2E 사이트", schoolLevels: ["middle"], category: "class" });
      manifest.privacyCheck = {
        collectsStudentData: false,
        storageLocation: "저장 안 함",
        retention: "저장 안 함",
        externalTransfer: false,
        needsSchoolApproval: false,
      };
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      const pub = await runCli(["publish", "--json"], { cwd: projDir, env: envCi });
      t.must(pub.code === 0 && pub.json?.ok === true, `publish 종료 코드 ${pub.code}: ${pub.stdout}${pub.stderr}`);
      const { appUrl, liveUrl, approvalStatus, appId } = pub.json;
      t.soft(approvalStatus === "not_required", `approvalStatus: ${approvalStatus}`);
      t.soft(appUrl === `${BASE_URL}/apps/${appId}`, `appUrl: ${appUrl}`);
      t.must(liveUrl === `http://${dep.json.slug}.localhost:${new URL(BASE_URL).port}/`, `liveUrl: ${liveUrl}`);
      state.site1 = { liveUrl, slug: dep.json.slug, previewUrl, heading, appId };
      t.note(`공개 ${liveUrl} · 앱 ${appId}`);

      const live = await inspectSiteInChrome(anon, liveUrl);
      t.soft(live.status === 200 && live.h1 === heading && live.js === marker && live.imgOk, `공개 주소 확인: ${live.status} ${live.h1} ${live.js}`);
      t.soft(!(live.headers["x-robots-tag"] || "").includes("noindex"), "공개 주소에 noindex가 붙음");
      const ap = await anon.newPage();
      try {
        const r = await ap.goto(appUrl);
        t.soft(r && r.status() === 200, `앱 주소 상태 코드 ${r?.status()}`);
        t.soft((await ap.locator("iframe.app-frame").getAttribute("src")) === liveUrl, "앱 화면 iframe src가 공개 주소가 아님");
        const frameH1 = await ap.frameLocator("iframe.app-frame").locator("#title").innerText({ timeout: 15000 }).catch((e) => `오류: ${e.message}`);
        t.soft(frameH1 === heading, `허브 앱 화면 iframe 안에 사이트가 보이지 않음: ${frameH1}`);
        await ap.goto(u("/apps"));
        t.soft((await ap.locator("main").getByRole("link", { name: title1 }).count()) >= 1, "익명 /apps에 호스팅 앱이 없음");
      } finally {
        await ap.close();
      }

      // (d) 두 번째 사이트: init 없이 deploy가 dandi.json을 만든다. 제목은 index.html <title>을 제안값으로 넣고
      //     설명·학교급·분류·셀프점검은 비워 둬 publish가 missing으로 알려 준다(교사 확인). 한국어 이름(고/학생지도)도 받는다.
      //     학교 내부 승인 필요 → 공개 주소 403 '승인 대기' → 승인 후 200
      const writeJson = (p, obj) => fs.writeFile(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
      const retitle = async (dir, from, to) => {
        const f = path.join(dir, "index.html");
        await fs.writeFile(f, (await fs.readFile(f, "utf8")).replaceAll(from, to), "utf8");
      };
      const projDir2 = path.join(S.tmp, `cli-site2-${RUN}`);
      const dist2 = path.join(projDir2, "dist");
      await fs.mkdir(projDir2, { recursive: true });
      const heading2 = `E2E 승인 대기 사이트 ${RUN}`;
      await writeStaticSite(dist2, { heading: heading2, marker: `js2-${RUN}` });
      const dep2 = await runCli(["deploy", "dist", "--json"], { cwd: projDir2, env: envCi });
      t.must(dep2.code === 0 && dep2.json?.previewUrl, `두 번째 deploy 실패 ${dep2.code}: ${dep2.stdout}${dep2.stderr}`);
      const mPath2 = path.join(projDir2, "dandi.json");
      const m2 = JSON.parse(await fs.readFile(mPath2, "utf8").catch(() => "{}"));
      t.soft(m2.siteId === dep2.json.siteId && m2.outputDir === "dist", `deploy가 만든 dandi.json(프로젝트 폴더)에 siteId/outputDir가 없음: ${JSON.stringify({ siteId: m2.siteId, outputDir: m2.outputDir })}`);
      t.soft(
        m2.title === heading2 && m2.description === "" && Array.isArray(m2.schoolLevels) && m2.schoolLevels.length === 0 && m2.category === "",
        `deploy가 만든 dandi.json이 제목(<title> 제안값) 말고 다른 항목을 미리 채움: ${JSON.stringify({ title: m2.title, description: m2.description, schoolLevels: m2.schoolLevels, category: m2.category })}`,
      );
      t.soft(Object.values(m2.privacyCheck ?? {}).every((v) => v === null || v === ""), `deploy가 셀프점검 답을 미리 채움: ${JSON.stringify(m2.privacyCheck)}`);
      t.soft(dep2.json.suggested_title === heading2, `deploy JSON의 suggested_title: ${dep2.json.suggested_title}`);
      const unconfirmed = await runCli(["publish", "--json"], { cwd: projDir2, env: envCi });
      const miss = unconfirmed.json?.missing ?? [];
      t.soft(
        unconfirmed.code === 21 && ["description", "schoolLevels", "category"].every((f) => miss.includes(f)) && miss.some((f) => f.startsWith("privacyCheck")),
        `확인 전 publish(exit 21, missing에 설명·학교급·분류·셀프점검 기대): ${unconfirmed.code} missing=${JSON.stringify(miss)}`,
      );
      t.soft((unconfirmed.json?.confirm ?? []).includes("title"), `확인 전 publish가 제안 제목 확인(confirm: title)을 요구하지 않음: ${JSON.stringify(unconfirmed.json?.confirm)}`);
      t.soft(jsonEncodingOk(unconfirmed.stdout), "publish 오류 --json 출력 인코딩이 셸과 맞지 않음");

      const title2 = `E2E 승인대기 호스팅앱 ${RUN}`;
      Object.assign(m2, { title: title2, description: "학교 내부 승인이 필요한 E2E 사이트", schoolLevels: ["고딩"], category: "학생지도" });
      m2.privacyCheck = {
        collectsStudentData: false,
        storageLocation: "저장 안 함",
        retention: "저장 안 함",
        externalTransfer: false,
        needsSchoolApproval: true,
      };
      await writeJson(mPath2, m2);
      // 형식만 틀린 값(모르는 학교급): missing이 아니라 invalid_format, 허용값 안내, 교사에게 다시 묻지 말라는 지시
      const badFmt = await runCli(["publish", "--json"], { cwd: projDir2, env: envCi });
      const inv = badFmt.json?.invalid_format ?? [];
      t.soft(
        badFmt.code === 21 &&
          (badFmt.json?.missing ?? []).length === 0 &&
          inv.some((i) => i.field === "schoolLevels" && /elem\|middle\|high\|special/.test(i.problem)) &&
          /do not ask the teacher again/i.test(badFmt.json?.agent_instructions ?? ""),
        `모르는 학교급 publish(invalid_format 기대): ${badFmt.code} ${badFmt.stdout.slice(0, 300)}`,
      );
      m2.schoolLevels = ["고"];
      await writeJson(mPath2, m2);
      const pub2 = await runCli(["publish", "--json"], { cwd: projDir2, env: envCi });
      t.must(pub2.code === 0 && pub2.json?.approvalStatus === "pending", `승인 대기 publish(한국어 학교급·분류): ${pub2.code} ${pub2.stdout}${pub2.stderr}`);
      const live2 = pub2.json.liveUrl;
      const appId2 = pub2.json.appId;
      t.note(`승인 대기 ${live2} · 앱 ${appId2}`);
      const l403 = await inspectSiteInChrome(anon, live2);
      t.soft(l403.status === 403 && l403.text.includes("승인 대기"), `승인 전 공개 주소: ${l403.status} (403 '승인 대기' 기대)`);
      t.soft(!l403.text.includes(heading2), "승인 전 공개 주소에 사이트 내용이 노출됨");
      const pv2 = await inspectSiteInChrome(anon, dep2.json.previewUrl);
      t.soft(pv2.status === 200 && pv2.h1 === heading2, `승인 대기 중 미리보기: ${pv2.status}`);
      const anonApp = await anon.request.get(u(`/apps/${appId2}`));
      t.soft(anonApp.status() === 404, `승인 전 익명 /apps/${appId2} 상태 코드 ${anonApp.status()} (404 기대)`);

      const page = await ctxA.newPage();
      try {
        await page.goto(u(`/apps/${appId2}`));
        const act = waitForAction(page);
        await page.getByRole("button", { name: "내부 승인 완료 표시" }).click();
        await act;
        await page.locator("main .badge", { hasText: "내부 승인 완료" }).first().waitFor();
      } finally {
        await page.close();
      }
      const l200 = await inspectSiteInChrome(anon, live2);
      t.soft(l200.status === 200 && l200.h1 === heading2, `승인 후 공개 주소: ${l200.status} ${l200.h1}`);
      const filtered = await anon.request.get(u("/apps?level=high&category=guidance"));
      t.soft((await filtered.text()).includes(title2), "한국어 이름(고·학생지도)으로 등록한 앱이 /apps?level=high&category=guidance에 없음");

      /** 공개 주소가 기대한 내용을 보여 줄 때까지 잠깐 기다린다(사이트 서빙 캐시 TTL 5초). */
      const liveShows = async (url, text) => {
        let r = await hostRequest(url);
        for (let i = 0; i < 7 && !(r.status === 200 && r.text.includes(text)); i++) {
          await new Promise((res) => setTimeout(res, 1000));
          r = await hostRequest(url);
        }
        return r;
      };
      const approveAsAuthor = async (appIdToApprove) => {
        const pg = await ctxA.newPage();
        try {
          await pg.goto(u(`/apps/${appIdToApprove}`));
          const act = waitForAction(pg);
          await pg.getByRole("button", { name: "내부 승인 완료 표시" }).click();
          await act;
          await pg.locator("main .badge", { hasText: "내부 승인 완료" }).first().waitFor();
        } finally {
          await pg.close();
        }
      };

      // (d2) 승인 완료된 앱을 같은 셀프점검 답으로 다시 올리면 승인 완료를 유지하고 공개 주소가 바로 새 버전이 된다.
      const heading2b = `${heading2} v2`;
      await retitle(dist2, heading2, heading2b);
      const dep2b = await runCli(["deploy", "--json"], { cwd: projDir2, env: envCi });
      t.soft(dep2b.code === 0 && dep2b.json?.siteId === dep2.json.siteId, `승인된 사이트 다시 deploy: ${dep2b.code} siteId ${dep2b.json?.siteId}`);
      t.soft(dep2b.json?.published?.appId === appId2 && dep2b.json?.saved_answers, `다시 deploy JSON에 공개 정보(published)·저장된 답(saved_answers)이 없음: ${JSON.stringify({ published: dep2b.json?.published, saved: Boolean(dep2b.json?.saved_answers) })}`);
      const pub2b = await runCli(["publish", "--json"], { cwd: projDir2, env: envCi });
      t.soft(
        pub2b.code === 0 && pub2b.json?.appId === appId2 && pub2b.json?.approvalStatus !== "pending" && pub2b.json?.liveVersion === "updated",
        `승인된 앱을 같은 답으로 다시 publish(승인 유지·updated 기대): ${pub2b.code} ${JSON.stringify({ approvalStatus: pub2b.json?.approvalStatus, liveVersion: pub2b.json?.liveVersion, error: pub2b.json?.error })}`,
      );
      const live2b = await liveShows(live2, heading2b);
      t.soft(live2b.status === 200 && live2b.text.includes(heading2b), `같은 답 다시 publish 뒤 공개 주소: ${live2b.status} (새 버전 200 기대)`);
      const anon2b = await anon.request.get(u(`/apps/${appId2}`));
      t.soft(anon2b.status() === 200 && (await anon2b.text()).includes("내부 승인 완료"), `같은 답 다시 publish 뒤 익명 /apps/${appId2}: ${anon2b.status()} (승인 완료 유지 기대)`);

      // (d3) 승인과 관련된 답을 바꿔 다시 올리면 새 버전은 승인 대기, 공개 주소는 승인받은 이전 버전을 계속 보여 준다
      //      (liveVersion kept_until_approval). 작성자가 승인 완료를 표시하면 새 버전으로 바뀐다.
      const heading2c = `${heading2} v3`;
      await retitle(dist2, heading2b, heading2c);
      const dep2c = await runCli(["deploy", "--json"], { cwd: projDir2, env: envCi });
      t.soft(dep2c.code === 0, `세 번째 deploy: ${dep2c.code} ${dep2c.stdout.slice(0, 200)}`);
      const m2c = JSON.parse(await fs.readFile(mPath2, "utf8"));
      m2c.privacyCheck = { ...m2c.privacyCheck, storageLocation: "학교 구글 드라이브", retention: "학년 종료 시 삭제" };
      await writeJson(mPath2, m2c);
      const pub2c = await runCli(["publish", "--json"], { cwd: projDir2, env: envCi });
      t.soft(
        pub2c.code === 0 && pub2c.json?.approvalStatus === "pending" && pub2c.json?.liveVersion === "kept_until_approval",
        `답을 바꿔 다시 publish(pending·kept_until_approval 기대): ${pub2c.code} ${JSON.stringify({ approvalStatus: pub2c.json?.approvalStatus, liveVersion: pub2c.json?.liveVersion, error: pub2c.json?.error })}`,
      );
      t.note(`kept_until_approval publish message: ${pub2c.json?.message}`);
      t.soft(
        /이전.{0,20}(버전|공개)|그대로 유지|유지됩니다/.test(pub2c.json?.message ?? ""),
        `publish --json message(에이전트가 그대로 읽어 줌)가 이전 공개 버전이 승인 전까지 유지된다는 사실을 말하지 않음: ${pub2c.json?.message}`,
      );
      const live2c = await hostRequest(live2);
      t.soft(
        live2c.status === 200 && live2c.text.includes(heading2b) && !live2c.text.includes(heading2c),
        `승인 대기 중 공개 주소: ${live2c.status} (이전 승인 버전 200 기대, 403/새 버전이면 실패)`,
      );
      if (typeof pub2c.json?.previewUrl === "string") {
        const pv2c = await hostRequest(pub2c.json.previewUrl);
        t.soft(pv2c.status === 200 && pv2c.text.includes(heading2c), `승인 대기 새 버전 미리보기: ${pv2c.status}`);
      } else {
        t.soft(false, "답을 바꾼 publish 결과에 previewUrl이 없음");
      }
      await approveAsAuthor(appId2);
      const live2d = await liveShows(live2, heading2c);
      t.soft(live2d.status === 200 && live2d.text.includes(heading2c), `다시 승인한 뒤 공개 주소: ${live2d.status} (새 버전 기대)`);

      // (e) 이미 공개한 사이트를 다시 올리고 publish하면 새 미니앱을 만들지 않고 공개 배포만 바꾼다(계약 2-3 4).
      const heading1b = `${heading} v2`;
      await fs.writeFile(
        path.join(projDir, "dist", "index.html"),
        (await fs.readFile(path.join(projDir, "dist", "index.html"), "utf8")).replaceAll(heading, heading1b),
        "utf8",
      );
      const dep1b = await runCli(["deploy", "--json"], { cwd: projDir, env: envCi });
      t.soft(dep1b.code === 0 && dep1b.json?.siteId === dep.json.siteId, `다시 deploy: ${dep1b.code} siteId ${dep1b.json?.siteId}`);
      const liveBefore = await hostRequest(liveUrl);
      t.soft(liveBefore.text.includes(heading) && !liveBefore.text.includes(heading1b), "publish 전인데 공개 주소가 새 배포로 바뀜");
      const pub1b = await runCli(["publish", "--json"], { cwd: projDir, env: envCi });
      t.soft(pub1b.code === 0 && pub1b.json?.appId === appId, `다시 publish가 새 미니앱을 만듦: ${pub1b.json?.appId} (기존 ${appId})`);
      const liveAfter = await hostRequest(liveUrl);
      t.soft(liveAfter.status === 200 && liveAfter.text.includes(heading1b), `다시 publish 뒤 공개 주소가 새 배포가 아님: ${liveAfter.status}`);
      const mine = await (await fetch(u("/api/sites"), { headers: { Authorization: `Bearer ${token}` } })).json().catch(() => ({}));
      const siteRow = (mine.sites ?? []).find((s) => s.id === dep.json.siteId);
      t.soft(siteRow && siteRow.appId === appId && siteRow.liveUrl === liveUrl, `GET /api/sites의 사이트 정보: ${JSON.stringify(siteRow)}`);

      // (f) 업로드 검증: CLI는 비밀값이 든 폴더를 exit 20으로 거부하고, 서버도 finalize에서 422 secret_detected로 막는다.
      const secretDir = path.join(projDir, "secret-site");
      await fs.mkdir(secretDir, { recursive: true });
      const fakeKey = `dd_sk_${"a1B2c3D4e5".repeat(3)}`;
      await fs.writeFile(path.join(secretDir, "index.html"), `<!doctype html><script>const key = "${fakeKey}";</script>\n`, "utf8");
      const sec = await runCli(["deploy", "secret-site", "--json"], { cwd: projDir, env: envCi });
      t.soft(sec.code === 20 && sec.json?.error?.code === "secret_detected" && !(sec.stdout + sec.stderr).includes(fakeKey), `비밀값 폴더 deploy: ${sec.code} ${sec.stdout.slice(0, 200)}`);

      const siteApi = async (files, extra = {}) => {
        const start = await apiPost("/api/sites/deploys", token, {
          title: `E2E API 업로드 ${RUN}`,
          files: files.map((f) => ({ path: f.path, size: f.bytes.byteLength, sha256: crypto.createHash("sha256").update(f.bytes).digest("hex") })),
          ...extra,
        });
        return start;
      };
      const putFile = (deployId, p, bytes, as = token) =>
        fetch(u(`/api/sites/deploys/${deployId}/files?path=${encodeURIComponent(p)}`), {
          method: "PUT",
          headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/octet-stream" },
          body: bytes,
        });
      const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
      const secretBytes = Buffer.from(`<!doctype html><p>server check</p><script>const key = "${fakeKey}";</script>\n`, "utf8");
      const s1 = await siteApi([{ path: "index.html", bytes: secretBytes }]);
      t.soft(s1.status === 201 && Array.isArray(s1.data?.upload), `POST /api/sites/deploys: ${s1.status} ${JSON.stringify(s1.data).slice(0, 160)}`);
      if (s1.status === 201) {
        const wrong = await putFile(s1.data.deployId, "index.html", Buffer.from("다른 내용", "utf8"));
        const wrongBody = parseMaybeJson(await wrong.text());
        t.soft(wrong.status === 400 && wrongBody?.error?.code === "hash_mismatch", `해시가 다른 파일 PUT: ${wrong.status} ${JSON.stringify(wrongBody).slice(0, 120)}`);
        const early = await apiPost(`/api/sites/deploys/${s1.data.deployId}/finalize`, token, {});
        t.soft(
          (s1.data.upload.length === 0 && early.status !== 409) || (early.status === 409 && early.data?.error?.code === "missing_files"),
          `파일을 올리기 전 finalize: ${early.status} ${JSON.stringify(early.data).slice(0, 120)}`,
        );
        const put = await putFile(s1.data.deployId, "index.html", secretBytes);
        t.soft(put.status === 204, `PUT 파일 상태 코드 ${put.status}`);
        const fin = await apiPost(`/api/sites/deploys/${s1.data.deployId}/finalize`, token, {});
        t.soft(
          fin.status === 422 && fin.data?.error?.code === "secret_detected" && String(fin.data?.error?.hint).includes("index.html"),
          `비밀값이 든 사이트 finalize: ${fin.status} ${JSON.stringify(fin.data).slice(0, 200)}`,
        );
      }
      const piiBytes = Buffer.from(`<!doctype html><p>담임 연락처 ${PHONE}</p>\n`, "utf8");
      const s2 = await siteApi([{ path: "index.html", bytes: piiBytes }]);
      if (s2.status === 201) {
        if (s2.data.upload.includes("index.html")) await putFile(s2.data.deployId, "index.html", piiBytes);
        const fin = await apiPost(`/api/sites/deploys/${s2.data.deployId}/finalize`, token, {});
        t.soft(
          fin.status === 200 && (fin.data?.warnings ?? []).some((w) => w.path === "index.html"),
          `개인정보가 든 사이트 finalize(경고와 함께 200 기대): ${fin.status} ${JSON.stringify(fin.data).slice(0, 200)}`,
        );
      } else {
        t.soft(false, `개인정보 확인용 deploy 시작 실패: ${s2.status}`);
      }

      // (f-2) 파일 저장소 중복 제거는 교사별이다. A가 이미 올린 내용은 A가 다른 사이트에 다시 쓸 때 올리지 않아도 되지만,
      //       같은 해시를 적은 교사 B는 실제 바이트를 올려야 한다(해시만 알고 남의 비공개 파일을 가져오지 못함).
      const appJsBytes = await fs.readFile(path.join(projDir, "dist", "app.js"));
      if (s2.status === 201 && s2.data?.siteId) {
        const own = await apiPost("/api/sites/deploys", token, {
          siteId: s2.data.siteId,
          files: [
            { path: "index.html", size: piiBytes.byteLength, sha256: sha(piiBytes) },
            { path: "copy-of-site1.js", size: appJsBytes.byteLength, sha256: sha(appJsBytes) },
          ],
        });
        t.soft(
          own.status === 201 && Array.isArray(own.data?.upload) && own.data.upload.length === 0,
          `같은 교사가 이미 올린 내용인데 다시 올리라고 함: ${own.status} upload=${JSON.stringify(own.data?.upload)}`,
        );
        if (own.status === 201) {
          const ownFin = await apiPost(`/api/sites/deploys/${own.data.deployId}/finalize`, token, {});
          t.soft(ownFin.status === 200, `이미 올린 내용만으로 finalize: ${ownFin.status} ${JSON.stringify(ownFin.data).slice(0, 160)}`);
        }
      }
      const tokenB = await cliTokenForB();
      {
        const bIndex = Buffer.from(`<!doctype html><h1>B의 사이트 ${RUN}</h1>\n`, "utf8");
        const bStart = await apiPost("/api/sites/deploys", tokenB, {
          title: `E2E B 저장소 확인 ${RUN}`,
          files: [
            { path: "index.html", size: bIndex.byteLength, sha256: sha(bIndex) },
            { path: "stolen.js", size: appJsBytes.byteLength, sha256: sha(appJsBytes) },
          ],
        });
        const up = bStart.data?.upload ?? [];
        t.soft(
          bStart.status === 201 && up.includes("stolen.js") && up.includes("index.html"),
          `교사 A가 올린 내용(해시)을 교사 B에게는 올리지 않아도 된다고 함(교사별 저장 아님): ${bStart.status} upload=${JSON.stringify(up)}`,
        );
        if (bStart.status === 201) {
          await putFile(bStart.data.deployId, "index.html", bIndex, tokenB);
          const early = await apiPost(`/api/sites/deploys/${bStart.data.deployId}/finalize`, tokenB, {});
          t.soft(
            early.status === 409 && early.data?.error?.code === "missing_files",
            `교사 B가 A의 파일 내용을 올리지 않고 finalize함: ${early.status} ${JSON.stringify(early.data).slice(0, 160)}`,
          );
          const putStolen = await putFile(bStart.data.deployId, "stolen.js", appJsBytes, tokenB);
          t.soft(putStolen.status === 204, `교사 B가 실제 바이트를 PUT: ${putStolen.status}`);
          const bFin = await apiPost(`/api/sites/deploys/${bStart.data.deployId}/finalize`, tokenB, {});
          t.soft(bFin.status === 200, `교사 B가 실제 내용을 올린 뒤 finalize: ${bFin.status} ${JSON.stringify(bFin.data).slice(0, 160)}`);
        }
      }

      // 다른 교사(B)는 A의 사이트에 새 배포를 올리거나 publish할 수 없고, 목록에서도 보지 못한다.
      const okHtml = Buffer.from("<!doctype html><h1>B가 덮어쓰기</h1>\n", "utf8");
      const hijack = await apiPost("/api/sites/deploys", tokenB, {
        siteId: dep.json.siteId,
        files: [{ path: "index.html", size: okHtml.byteLength, sha256: crypto.createHash("sha256").update(okHtml).digest("hex") }],
      });
      t.soft([403, 404].includes(hijack.status), `교사 B가 A의 사이트에 배포를 시작함: ${hijack.status} ${JSON.stringify(hijack.data).slice(0, 160)}`);
      const hijackPub = await apiPost(`/api/sites/${dep.json.siteId}/publish`, tokenB, {
        title: "가로채기",
        description: "",
        schoolLevels: ["middle"],
        category: "etc",
        privacyCheck: { collectsStudentData: false, storageLocation: "저장 안 함", retention: "저장 안 함", externalTransfer: false, needsSchoolApproval: false },
      });
      t.soft([403, 404].includes(hijackPub.status), `교사 B가 A의 사이트를 publish함: ${hijackPub.status} ${JSON.stringify(hijackPub.data).slice(0, 160)}`);
      const listB = await (await fetch(u("/api/sites"), { headers: { Authorization: `Bearer ${tokenB}` } })).json().catch(() => ({}));
      t.soft(!(listB.sites ?? []).some((s) => s.id === dep.json.siteId), "교사 B의 GET /api/sites에 A의 사이트가 보임");
      const stillA = await hostRequest(liveUrl);
      t.soft(stillA.text.includes(heading1b), "교사 B의 시도 뒤 A의 공개 사이트 내용이 바뀜");
      const previewLabel = new URL(previewUrl).hostname.split(".")[0];
      const bSite = await (await ensureTeacherB()).request.get(u(`/studio/sites/${dep.json.siteId}`));
      const bSiteText = await bSite.text();
      t.soft(bSite.status() === 404 && !bSiteText.includes(previewLabel), `교사 B가 A의 사이트 관리 화면을 봄(미리보기 주소 노출): ${bSite.status()}`);

      const traversal = await siteApi([{ path: "../evil.html", bytes: Buffer.from("x") }, { path: "index.html", bytes: Buffer.from("<p>ok</p>") }]);
      t.soft(traversal.status >= 400 && traversal.status < 500, `상위 경로(../) 파일이 거절되지 않음: ${traversal.status}`);
      const noIndex = await siteApi([{ path: "main.html", bytes: Buffer.from("<p>ok</p>") }]);
      t.soft(noIndex.status >= 400 && noIndex.status < 500, `index.html 없는 사이트가 거절되지 않음: ${noIndex.status}`);

      const bad = await runCli(["whoami"], { cwd: projDir, env: { ...envCi, DANDI_TOKEN: "dd_cli_invalid_token_e2e" } });
      t.soft(bad.code !== 0, "잘못된 토큰으로 whoami가 성공함");
    });

    /* ---------------- 7) 프로젝트 · 프로젝트 키 · 게이트웨이 ---------------- */
    await step("7) 프로젝트·키: 생성 · inference/readonly 키(원문 1회) · x-api-key/Bearer · readonly 403 · 브라우저 401 · 보류 모델 403 · 예산 초과 429", async (t) => {
      const ctxA = await ensureTeacherA();
      const projectName = `E2E 프로젝트 ${RUN}`;
      const projectId = await createProjectViaPage(ctxA, { name: projectName });
      t.must(/^[A-Za-z0-9_-]+$/.test(projectId), `프로젝트 id: ${projectId}`);
      state.projectId = projectId;
      t.note(`프로젝트 ${projectId}`);

      const page = await ctxA.newPage();
      try {
        await page.goto(u(`/studio/projects/${projectId}?tab=keys`));
        await page.getByRole("heading", { level: 1, name: projectName }).waitFor();
        const key = await createKeyOnPage(page, { name: `E2E 서버 키 ${RUN}`, role: "inference" });
        state.apiKey = key;
        memo.projectKey = Promise.resolve({ projectId, key });
        t.soft((await mainText(page)).includes("이 키는 지금 한 번만 표시됩니다"), "키 원문 1회 표시 안내가 없음");
        const roKey = await createKeyOnPage(page, { name: `E2E 조회 키 ${RUN}`, role: "readonly" });
        t.soft(roKey !== key, "readonly 키가 inference 키와 같음");

        // 원문은 한 번만: 새로고침하면 원문 없이 힌트만 보인다.
        await page.reload();
        const html = await page.content();
        t.soft(!html.includes(key) && !html.includes(roKey), "새로고침 후에도 키 원문이 화면에 남아 있음");
        const rows = page.locator("main table tbody tr");
        t.soft((await rows.filter({ hasText: `E2E 서버 키 ${RUN}` }).count()) === 1, "키 목록에 inference 키가 없음");
        t.soft((await rows.filter({ hasText: `E2E 조회 키 ${RUN}` }).filter({ hasText: "readonly" }).count()) === 1, "키 목록에 readonly 키가 없음");

        // 게이트웨이: x-api-key · Bearer
        const prompt = `가정통신문 초안을 써 주십시오. 문의는 ${EMAIL}로 받습니다.`;
        const viaHeader = await gatewayPost(key, { model: "claude", prompt }, { via: "x-api-key" });
        t.soft(viaHeader.status === 200, `x-api-key 호출 상태 코드 ${viaHeader.status}: ${JSON.stringify(viaHeader.data).slice(0, 160)}`);
        if (viaHeader.status === 200) {
          t.soft(viaHeader.data.projectId === projectId && viaHeader.headers.get("x-dandi-project-id") === projectId, "응답 projectId/x-dandi-project-id가 프로젝트와 다름");
          t.soft(viaHeader.data.piiMasked >= 1 && !viaHeader.data.output.includes(EMAIL), "게이트웨이가 이메일을 가리지 않음");
          t.soft(viaHeader.data.mock === true && viaHeader.data.usage?.tokens > 0, `usage/mock 이상: ${JSON.stringify(viaHeader.data.usage)}`);
          t.note(`x-api-key: tokens=${viaHeader.data.usage.tokens}, remaining=${viaHeader.data.usage.remaining}`);
        }
        const viaBearer = await gatewayPost(key, { model: "gpt", messages: [{ role: "user", content: `학부모 연락처 ${PHONE}` }] }, { via: "bearer" });
        t.soft(viaBearer.status === 200 && viaBearer.data.piiMasked === 1, `Bearer(OpenAI 형식) 호출: ${viaBearer.status} ${JSON.stringify(viaBearer.data).slice(0, 160)}`);

        const ro = await gatewayPost(roKey, { model: "claude", prompt: "안녕하세요" });
        t.soft(ro.status === 403 && ro.data?.error?.code === "insufficient_role", `readonly 키 호출: ${ro.status} ${JSON.stringify(ro.data).slice(0, 160)}`);

        const withOrigin = await gatewayPost(key, { model: "claude", prompt: "안녕하세요" }, { headers: { Origin: "https://example.com" } });
        t.soft(withOrigin.status === 401 && withOrigin.data?.error?.code === "browser_key_forbidden", `Origin 헤더 호출: ${withOrigin.status} ${JSON.stringify(withOrigin.data).slice(0, 160)}`);
        // 실제 브라우저(Chrome)에서 키로 부르면 401 browser_key_forbidden이고, 오류 본문을 읽을 수 있어야 한다.
        const inBrowser = await page.evaluate(async (k) => {
          const r = await fetch("/api/ai/chat", {
            method: "POST",
            headers: { "x-api-key": k, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "claude", prompt: "브라우저에서 호출" }),
          });
          return { status: r.status, body: await r.json().catch(() => null) };
        }, key);
        t.soft(inBrowser.status === 401 && inBrowser.body?.error?.code === "browser_key_forbidden", `Chrome fetch 호출: ${JSON.stringify(inBrowser)}`);

        const pend = await gatewayPost(key, { model: "deepseek", prompt: "안녕하세요" });
        t.soft(
          pend.status === 403 && pend.data?.error?.code === "model_not_allowed" && String(pend.data?.error?.message).includes("정책 검토 중"),
          `보류 모델 호출: ${pend.status} ${JSON.stringify(pend.data).slice(0, 200)}`,
        );
        const bad = await gatewayPost("dd_sk_not_a_real_key", { model: "claude", prompt: "hi" });
        t.soft(bad.status === 401 && bad.data?.error?.code === "invalid_key", `잘못된 키 호출: ${bad.status} ${JSON.stringify(bad.data).slice(0, 120)}`);
        const noKey = await fetch(u("/api/ai/chat"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        t.soft(noKey.status === 401 && /Bearer/.test(noKey.headers.get("www-authenticate") || ""), `키 없는 호출: ${noKey.status}`);

        // 사용 기록은 프로젝트 사용량 탭에
        await page.goto(u(`/studio/projects/${projectId}?tab=usage`));
        const ut = await mainText(page);
        t.soft(ut.includes("최근 호출") && ut.includes(`E2E 서버 키 ${RUN}`), "프로젝트 사용량 탭에 최근 호출(키 이름) 기록이 없음");
        t.soft(!ut.includes(key), "사용량 탭에 키 원문이 보임");
      } finally {
        await page.close();
      }

      // /ai 화면: 모델 가이드(보류 → "정책 검토 중") + 게이트웨이 테스트(프로젝트 키 선택)
      const ai = await ctxA.newPage();
      try {
        await ai.goto(u("/ai"));
        await ai.getByRole("heading", { level: 1, name: "AI 사용" }).waitFor();
        const ds = ai.locator("main table tbody tr").filter({ has: ai.locator("code", { hasText: /^deepseek$/ }) });
        t.soft((await ds.count()) === 1 && (await ds.innerText()).includes("정책 검토 중"), '보류 모델(deepseek)이 "정책 검토 중"으로 표시되지 않음');
        t.soft(!(await ds.innerText().catch(() => "")).includes("보류"), '교사 화면에 "보류" 원래 라벨이 노출됨');
        await ai.locator('select[name="projectId"]').selectOption(projectId);
        const opt = ai.locator('select[name="model"] option[value="deepseek"]');
        t.soft(
          (await opt.count()) === 1 && (await opt.evaluate((el) => el.disabled)) && (await opt.textContent()).includes("정책 검토 중"),
          "게이트웨이 테스트 선택지에서 deepseek가 비활성(정책 검토 중)이 아님",
        );
        const keyOptions = await ai.locator('select[name="keyId"] option').allTextContents();
        t.soft(keyOptions.some((o) => o.includes(`E2E 서버 키 ${RUN}`)) && !keyOptions.some((o) => o.includes(`E2E 조회 키 ${RUN}`)), `키 선택지(readonly 제외 기대): ${keyOptions.join(" | ")}`);
        await ai.locator('select[name="model"]').selectOption("claude");
        const prompt = `가정통신문 초안을 써 주십시오. 문의는 ${EMAIL}로 받습니다.`;
        await ai.locator('textarea[name="prompt"]').fill(prompt);
        await ai.locator(".pii-warning").first().waitFor();
        const act = waitForAction(ai);
        await ai.getByRole("button", { name: "게이트웨이로 호출" }).click();
        await act;
        await ai.getByRole("heading", { name: "응답 (Claude)" }).waitFor();
        const sec = await ai.locator("main section[aria-live]").innerText();
        t.soft(sec.includes("게이트웨이가 개인정보 1건(이메일)을 *** 로 가린 뒤 모델로 전달했습니다"), `마스킹 안내가 다름: ${sec.slice(0, 120)}`);
        t.soft(!sec.includes(EMAIL) && sec.includes(projectName), "화면 응답에 이메일 원문이 있거나 프로젝트 이름이 없음");
      } finally {
        await ai.close();
      }

      // 예산 초과: 월 예산을 최소값(1,000토큰)으로 둔 프로젝트
      const tinyId = await createProjectViaPage(ctxA, { name: `E2E 예산 ${RUN}`, budget: 1000 });
      const tp = await ctxA.newPage();
      try {
        await tp.goto(u(`/studio/projects/${tinyId}?tab=keys`));
        const tinyKey = await createKeyOnPage(tp, { name: `E2E 예산 키 ${RUN}`, role: "inference" });
        const first = await gatewayPost(tinyKey, { model: "claude", prompt: "수업 도입 질문 하나" });
        t.soft(first.status === 200, `작은 예산 첫 호출 상태 코드 ${first.status}: ${JSON.stringify(first.data).slice(0, 160)}`);
        const big = "광합성 단원 복습 문제를 만들어 주십시오. ".repeat(80);
        const over = await gatewayPost(tinyKey, { model: "claude", prompt: big });
        t.soft(
          over.status === 429 && over.data?.error?.code === "project_quota_exceeded",
          `예산 초과 호출: ${over.status} ${JSON.stringify(over.data).slice(0, 200)}`,
        );
        const other = await gatewayPost(state.apiKey, { model: "claude", prompt: "다른 프로젝트 키는 영향 없음" });
        t.soft(other.status === 200, `다른 프로젝트 키가 예산 초과의 영향을 받음: ${other.status}`);
        await tp.goto(u(`/studio/projects/${tinyId}?tab=usage`));
        t.note(`예산 프로젝트 ${tinyId}: ${((await mainText(tp)).match(/프로젝트\s+([\d,]+ \/ [\d,]+토큰 \(\d+%\))/) || [])[1] ?? ""}`);

        // 키 비활성화 → 401 key_disabled → 다시 켜기 → 200
        await tp.goto(u(`/studio/projects/${tinyId}?tab=keys`));
        const row = () => tp.locator("main table tbody tr", { hasText: `E2E 예산 키 ${RUN}` });
        let act = waitForAction(tp);
        await row().getByRole("button", { name: "비활성화" }).click();
        await act;
        await row().getByRole("button", { name: "다시 켜기" }).waitFor();
        const disabled = await gatewayPost(tinyKey, { model: "claude", prompt: "비활성화된 키" });
        t.soft(disabled.status === 401 && disabled.data?.error?.code === "key_disabled", `비활성화한 키 호출: ${disabled.status} ${JSON.stringify(disabled.data).slice(0, 120)}`);
        act = waitForAction(tp);
        await row().getByRole("button", { name: "다시 켜기" }).click();
        await act;
        await row().getByRole("button", { name: "비활성화" }).waitFor();
        const enabled = await gatewayPost(tinyKey, { model: "claude", prompt: "다시 켠 키" });
        t.soft(enabled.status === 200, `다시 켠 키 호출: ${enabled.status} ${JSON.stringify(enabled.data).slice(0, 120)}`);

        // 프로젝트 보관 → 키 모두 비활성화, 호출은 403 project_archived
        await tp.goto(u(`/studio/projects/${tinyId}?tab=settings`));
        tp.once("dialog", (d) => d.accept());
        act = waitForAction(tp);
        await tp.getByRole("button", { name: "프로젝트 보관" }).click();
        await act;
        await tp.getByText("보관한 프로젝트입니다").waitFor();
        t.soft(await tp.locator("main h1 .badge", { hasText: "보관됨" }).isVisible(), '보관 후 제목에 "보관됨" 배지가 없음');
        // 보관 액션은 ?tab=settings&archived=<비활성화한 키 수>로 이동하고, 보관 화면이 그 수를 보여 준다(켜져 있던 키 1개).
        await tp.waitForURL((url) => new URL(url).searchParams.has("archived"), { timeout: 10000 }).catch(() => {});
        const archivedParam = new URL(tp.url()).searchParams.get("archived");
        t.soft(archivedParam === "1", `보관 뒤 주소에 ?archived=1이 없음: ${tp.url()}`);
        const archivedMsg = tp.getByText("프로젝트를 보관했습니다. 키 1개를 비활성화했습니다.");
        await archivedMsg.waitFor({ timeout: 5000 }).catch(() => {});
        t.soft(await archivedMsg.isVisible(), `보관 성공 문구(비활성화한 키 수)가 화면에 없음: ${(await mainText(tp)).slice(0, 200)}`);
        const archived = await gatewayPost(tinyKey, { model: "claude", prompt: "보관한 프로젝트" });
        t.soft(archived.status === 403 && archived.data?.error?.code === "project_archived", `보관한 프로젝트 키 호출: ${archived.status} ${JSON.stringify(archived.data).slice(0, 120)}`);
      } finally {
        await tp.close();
      }

      // 다른 교사(B)는 A의 프로젝트를 보거나 키를 볼 수 없다.
      const ctxB = await ensureTeacherB();
      const bp = await ctxB.request.get(u(`/studio/projects/${projectId}?tab=keys`));
      const bpText = await bp.text();
      t.soft(bp.status() === 404 && !bpText.includes(`E2E 서버 키 ${RUN}`), `교사 B가 A의 프로젝트 키 탭을 봄: ${bp.status()}`);
      const bAi = await ctxB.request.get(u("/ai"));
      t.soft(!(await bAi.text()).includes(projectName), "교사 B의 /ai 게이트웨이 테스트에 A의 프로젝트가 보임");
    });

    /* ---------------- 8) 관리자 ---------------- */
    await step("8) 관리자: 승인 대기 목록 · 감사 로그 · deepseek 차단 → 교사 화면/API 반영 → 보류로 복구", async (t) => {
      const ctxAdmin = await ensureAdmin();
      const ctxA = await ensureTeacherA();
      const anon = await ensureAnon();
      const page = await ctxAdmin.newPage();
      const reason = `E2E 차단 시험 ${RUN}`;
      let blocked = false;
      try {
        // 이전 실행이 남긴 상태 정리
        const pre = await modelsApi();
        if (!pre.data.models.some((m) => m.id === "deepseek")) {
          t.note("시작 시 deepseek가 차단 상태여서 먼저 보류로 되돌림");
          await setModelStatusAsAdmin(page, "deepseek", "pending", "E2E 사전 정리");
        }

        // 감사 로그에 API 키 발급이 남도록 프로젝트 키를 먼저 확보한다(7단계에서 이미 만들었으면 그 키).
        const { key: apiKey } = await ensureProjectKey();

        // 승인 대기 앱 하나 더 만들어 관리자 화면에서 확인·승인
        const token = await cliTokenForA();
        const admTitle = `E2E 관리자승인앱 ${RUN}`;
        const created = await apiPost("/api/cli/apps", token, {
          title: admTitle,
          description: "관리자 승인 확인용",
          url: "https://example.com/e2e-admin",
          schoolLevels: ["special"],
          category: "guidance",
          privacyCheck: {
            collectsStudentData: true,
            storageLocation: "Supabase(서울 리전)",
            retention: "학기 종료 시 삭제",
            externalTransfer: false,
            needsSchoolApproval: true,
          },
        });
        t.must(created.status === 201 && created.data.approvalStatus === "pending", `승인 대기 앱 생성: ${created.status} ${JSON.stringify(created.data)}`);
        const admAppId = created.data.id;

        const r = await page.goto(u("/admin"));
        t.must(r && r.status() === 200, `/admin 상태 코드 ${r?.status()}`);
        await page.getByRole("heading", { level: 1, name: "관리자" }).waitFor();
        t.soft(await page.getByRole("heading", { name: "승인 대기 미니앱" }).isVisible(), '"승인 대기 미니앱" 구역 없음');
        t.soft(await page.getByRole("heading", { name: "감사 로그" }).isVisible(), '"감사 로그" 구역 없음');
        const prow = pendingTable(page).locator("tbody tr", { hasText: admTitle });
        t.must((await prow.count()) === 1, "관리자 승인 대기 목록에 새 승인 대기 앱이 없음");
        t.soft((await prow.innerText()).includes(TEACHER_A), "승인 대기 행에 등록자 이름 없음");
        const audit0 = await auditTable(page).innerText();
        t.soft(audit0.includes("앱 등록") && audit0.includes("app.create"), "감사 로그에 앱 등록 기록 없음");
        t.soft(audit0.includes("API 키 발급") && audit0.includes("CLI 토큰 발급") && audit0.includes("파일 업로드"), "감사 로그에 API 키/CLI 토큰/파일 업로드 기록 중 일부가 없음");
        t.soft(audit0.includes("앱 내부 승인 완료"), "감사 로그에 3단계 앱 승인 기록 없음");
        t.soft((await page.locator("main table").first().innerText()).includes("승인 대기"), "운영 요약에 승인 대기 수 표시 없음");

        // 관리자는 승인 전에도 상세를 볼 수 있어야 함
        const adminView = await ctxAdmin.request.get(u(`/apps/${admAppId}`));
        t.soft(adminView.status() === 200, `관리자 GET 승인 대기 앱 상태 코드 ${adminView.status()}`);
        t.soft((await adminView.text()).includes("내부 승인 완료 표시"), "관리자 상세 화면에 승인 버튼 없음");
        const anonBefore = await anon.request.get(u(`/apps/${admAppId}`));
        t.soft(anonBefore.status() === 404, `승인 전 익명 GET 상태 코드 ${anonBefore.status()}`);

        // 관리자 승인
        const act = waitForAction(page);
        await prow.getByRole("button", { name: "내부 승인 완료 표시" }).click();
        await act;
        await pendingTable(page).locator("tbody tr", { hasText: admTitle }).waitFor({ state: "detached" }).catch(() => {});
        const pubCheck = await anon.request.get(u(`/apps/${admAppId}`));
        t.soft(pubCheck.status() === 200, `관리자 승인 후 익명 GET 상태 코드 ${pubCheck.status()}`);

        // deepseek 차단
        const rowText = await setModelStatusAsAdmin(page, "deepseek", "blocked", reason);
        blocked = true;
        t.soft(rowText.includes("저장했습니다"), `모델 상태 저장 결과: ${rowText.replace(/\s+/g, " ").slice(0, 120)}`);
        await page.reload();
        const dsRow = modelTable(page)
          .locator("tbody tr")
          .filter({ has: page.locator("code", { hasText: /^deepseek$/ }) });
        t.soft((await dsRow.locator(".badge").innerText()).trim() === "차단", "관리자 표에 deepseek 상태가 차단으로 바뀌지 않음");
        const logRow = auditTable(page).locator("tbody tr", { hasText: reason }).first();
        t.soft((await logRow.count()) === 1, "감사 로그에 모델 상태 변경 기록이 없음");
        if (await logRow.count()) {
          const lt = await logRow.innerText();
          t.soft(lt.includes("model.status") && lt.includes("deepseek") && lt.includes(`보류 -> 차단: ${reason}`) && lt.includes(ADMIN), `감사 로그 내용: ${lt.replace(/\s+/g, " ")}`);
        }
        await page.goto(u("/admin?log=model"));
        t.soft((await auditTable(page).innerText()).includes(reason), "모델 정책만 필터에 변경 기록이 없음");

        // 교사 A 화면 반영
        const pa = await ctxA.newPage();
        try {
          await pa.goto(u("/ai"));
          t.soft(
            (await pa.locator("main table code", { hasText: /^deepseek$/ }).count()) === 0,
            "교사 /ai 모델 가이드에 차단된 deepseek가 보임",
          );
          t.soft((await pa.locator('select[name="model"] option[value="deepseek"]').count()) === 0, "교사 게이트웨이 선택지에 deepseek가 보임");
          t.soft(!(await mainText(pa)).includes("DeepSeek"), "교사 /ai 화면에 DeepSeek 이름이 남아 있음");
        } finally {
          await pa.close();
        }
        const api = await modelsApi();
        t.soft(api.status === 200 && !api.data.models.some((m) => m.id === "deepseek"), "GET /api/ai/models에 차단된 deepseek가 포함됨");
        t.soft(api.data.models.every((m) => m.status !== "blocked"), "GET /api/ai/models에 차단 모델이 포함됨");
        {
          const call = await gatewayPost(apiKey, { model: "deepseek", prompt: "안녕하세요" });
          // 차단 모델은 교사에게 존재를 드러내지 않도록 없는 모델과 같은 응답(400 model_not_found)을 받는다(F-23).
          t.soft(call.status === 400 && call.data?.error?.code === "model_not_found", `차단 모델 호출: ${call.status} ${JSON.stringify(call.data).slice(0, 120)}`);
        }
        // 프로젝트 모델 탭에도 차단 모델이 보이지 않아야 한다.
        const pm = await ctxA.newPage();
        try {
          await pm.goto(u(`/studio/projects/${state.projectId}?tab=models`));
          t.soft(!/deepseek/i.test(await mainText(pm)), "교사 프로젝트 모델 탭에 차단된 deepseek가 보임");
        } finally {
          await pm.close();
        }
      } finally {
        // 정리: deepseek를 보류로 되돌린다.
        if (blocked) {
          try {
            const txt = await setModelStatusAsAdmin(page, "deepseek", "pending", `E2E 정리 ${RUN}`);
            t.soft(txt.includes("저장했습니다"), `정리 저장 결과: ${txt.replace(/\s+/g, " ").slice(0, 120)}`);
            const api = await modelsApi();
            const ds = api.data.models.find((m) => m.id === "deepseek");
            t.soft(ds && ds.status === "pending" && ds.statusLabel === "정책 검토 중", `정리 후 deepseek: ${JSON.stringify(ds)}`);
            t.note("정리: deepseek를 보류로 되돌림");
          } catch (e) {
            t.soft(false, `정리(보류 복구) 실패: ${e.message}`);
          }
        }
        await page.close();
      }
    });

    /* ---------------- 9) v0.2 규칙 추가 점검(경계 사례) ---------------- */
    await step("9) v0.2 규칙 경계 점검: 로그인 이름·앱 URL·파일 이름 마스킹 · .apk 경고 · 교사용 모델 표시", async (t) => {
      const anon = await ensureAnon();

      // (a) 데모 로그인 이름: 클라이언트 경고/차단 + 서버 마스킹
      const ctxC = await newCtx(S.browser);
      try {
        const lp = await ctxC.newPage();
        await lp.goto(u("/login"));
        await lp.locator('input[name="name"]').fill(`박교사 ${PHONE}`);
        await lp.waitForTimeout(300);
        const warned = (await lp.locator(".pii-warning").count()) > 0;
        t.soft(warned, "로그인 폼 이름 칸에 휴대전화번호를 넣어도 클라이언트 경고가 없음(F-13 미적용)");
        // 클라이언트 차단: 제출해도 /login에 머물러야 한다.
        await lp.getByRole("button", { name: "데모 로그인" }).click();
        await lp.waitForTimeout(800);
        t.soft(new URL(lp.url()).pathname === "/login", "로그인 이름에 개인정보가 있는데 제출이 막히지 않음");
        // 서버 검사: 선택자(input:not([type]))를 피하도록 type을 바꿔 클라이언트 필터를 우회해도,
        // 이름은 계정 열쇠이므로 서버가 가리지 않고 거절해야 한다.
        await lp.locator('input[name="name"]').evaluate((el) => el.setAttribute("type", "search"));
        await lp.getByRole("button", { name: "데모 로그인" }).click();
        const err = lp.locator(".error").filter({ hasText: /개인정보/ });
        await err.first().waitFor({ timeout: 20000 });
        const who = await lp.locator("header .session").innerText();
        t.soft(new URL(lp.url()).pathname === "/login" && who.includes("익명"), `개인정보가 든 이름으로 로그인됨: ${who}`);
        await lp.close();
      } finally {
        await ctxC.close();
      }

      // (b) 앱 URL에 섞인 개인정보: 웹 폼은 막는데(안내 문구가 있는지), 서버는 가리는지
      const ctxA = await ensureTeacherA();
      const page = await ctxA.newPage();
      try {
        await page.goto(u("/studio/apps/new"));
        await fillAppForm(page, {
          title: `E2E URL개인정보 ${RUN}`,
          description: "",
          url: `https://example.com/app?tel=${PHONE}`,
          levels: ["middle"],
          category: "etc",
          collects: "no",
          storage: "저장 안 함",
          retention: "저장 안 함",
          external: "no",
          approval: "no",
        });
        const tr = trackActions(page);
        await page.getByRole("button", { name: "셀프점검 완료 후 등록" }).click();
        await page.waitForTimeout(1200);
        tr.stop();
        const stayed = new URL(page.url()).pathname === "/studio/apps/new" && tr.count === 0;
        t.soft(stayed, "웹 폼이 URL 속 휴대전화번호를 막지 않음");
        if (stayed) {
          const visibleMsg =
            (await page.locator(".pii-warning, .error, [role=alert]").filter({ hasText: /개인정보|전화|URL/ }).count()) > 0;
          t.soft(visibleMsg, "URL 칸 개인정보로 제출이 막혔지만 화면에 이유(경고 문구)가 전혀 표시되지 않음");
        }
      } finally {
        await page.close();
      }
      const token = await cliTokenForA();
      const urlRes = await apiPost("/api/cli/apps", token, {
        title: `E2E URL마스킹 ${RUN}`,
        description: "",
        url: `https://example.com/app?tel=${PHONE}`,
        schoolLevels: ["middle"],
        category: "etc",
        privacyCheck: {
          collectsStudentData: false,
          storageLocation: "저장 안 함",
          retention: "저장 안 함",
          externalTransfer: false,
          needsSchoolApproval: false,
        },
      });
      // URL은 가리면 링크가 깨지므로 서버가 등록을 거절해야 한다(400).
      t.soft(urlRes.status === 400, `URL에 개인정보가 있는 CLI 등록이 거절되지 않음: ${urlRes.status} ${JSON.stringify(urlRes.data).slice(0, 160)}`);

      // (b-2) 템플릿 예시 주소: 클라이언트 필터를 DOM 조작(type="url")으로 우회해 서버 마스킹 여부 확인
      const tp = await ctxA.newPage();
      try {
        await tp.goto(u("/templates/new"));
        await tp.getByRole("heading", { level: 1, name: "새 템플릿 등록" }).waitFor();
        const tplTitle = `E2E 템플릿URL ${RUN}`;
        await tp.locator('input[name="title"]').fill(tplTitle);
        await tp.locator('input[name="summary"]').fill("예시 주소 마스킹 확인용 템플릿");
        await tp.locator('input[name="schoolLevels"][value="middle"]').check();
        const ex = tp.locator('input[name="exampleUrl"]');
        await ex.fill(`https://example.com/demo?tel=${PHONE}`);
        // 제출 직전에 type="url"로 바꿔 blockSubmitIfPII 선택자(input:not([type]))를 피한다(하이드레이션 뒤에 해야 유지된다).
        await ex.evaluate((el) => el.setAttribute("type", "url"));
        await tp.getByRole("button", { name: "템플릿 등록" }).click();
        // 서버가 거절해야 한다: 페이지에 머물고 개인정보 안내 오류가 보인다.
        const err = tp.locator(".error, [role=alert]").filter({ hasText: /개인정보/ });
        await err.first().waitFor({ timeout: 20000 });
        t.soft(new URL(tp.url()).pathname === "/templates/new", `개인정보가 든 예시 주소로 템플릿이 등록됨 (${tp.url()})`);
      } catch (e) {
        t.soft(false, `템플릿 예시 주소 점검 실패: ${e.message.split("\n")[0]}`);
      } finally {
        await tp.close();
      }

      // (c) 파일 이름의 개인정보 마스킹 + (d) .apk 경고
      const piiName = `명단-${PHONE}.pdf`;
      const piiPath = path.join(S.tmp, piiName);
      await fs.writeFile(piiPath, Buffer.from("%PDF-1.4\n%%EOF\n", "latin1"));
      const piiTitle = `E2E 파일이름 마스킹 ${RUN}`;
      // 파일 이름에 개인정보가 있으면 클라이언트가 업로드를 막고 이유를 보여 준다(서버도 이름을 가린다).
      {
        const up = await ctxA.newPage();
        try {
          await up.goto(u("/files/upload"));
          await up.locator('input[name="file"]').setInputFiles(piiPath);
          await up.locator('input[name="title"]').fill(piiTitle);
          await up.locator('input[name="noStudentData"]').check();
          const tr = trackActions(up);
          await up.getByRole("button", { name: "업로드" }).click();
          await up.waitForTimeout(800);
          tr.stop();
          const msg = await up.locator(".error").filter({ hasText: /파일 이름/ }).count();
          t.soft(tr.count === 0 && msg > 0, `파일 이름의 개인정보로 업로드가 막히지 않았거나 안내가 없음 (actions=${tr.count})`);
        } finally {
          await up.close();
        }
      }
      const ap = await anon.newPage();
      try {

        const apkPath = path.join(S.tmp, `e2e-app-${RUN}.apk`);
        await fs.writeFile(apkPath, Buffer.concat([Buffer.from("PK\u0003\u0004", "latin1"), Buffer.alloc(60)]));
        const apkTitle = `E2E 안드로이드 앱 ${RUN}`;
        await uploadOk(ctxA, { file: apkPath, title: apkTitle, level: "all" });
        await ap.goto(u("/files"));
        const apkRow = ap.locator("main table tbody tr", { hasText: apkTitle }).first();
        t.soft((await apkRow.locator(".pii-warning", { hasText: "실행 파일입니다" }).count()) === 1, ".apk 자료에 실행 파일 경고가 없음");
      } finally {
        await ap.close();
      }

      // (e) 교사가 보는 게이트웨이 오류 문구: 보류 모델은 "정책 검토 중"으로 안내해야 함
      const { projectId, key: apiKey } = await ensureProjectKey();
      {
        const pend = await gatewayPost(apiKey, { model: "hyperclova-x", prompt: "안녕하세요" });
        const msg = pend.data?.error?.message ?? "";
        t.note(`보류 모델 403 메시지: ${msg}`);
        t.soft(pend.status === 403, `보류 모델 호출 상태 코드 ${pend.status}`);
        t.soft(!msg.includes("'보류'"), "교사에게 가는 보류 모델 오류 문구(API)가 \"정책 검토 중\"이 아니라 관리자 라벨 '보류'를 노출함");

        // 같은 문구가 교사 /ai 화면에도 보이는지: 교사가 화면을 연 뒤 관리자가 gpt를 보류로 바꾸고, 교사가 gpt로 호출
        const ctxAdm = await ensureAdmin();
        const adm = await ctxAdm.newPage();
        const tpage = await ctxA.newPage();
        let gptChanged = false;
        try {
          await tpage.goto(u("/ai"));
          await tpage.locator('select[name="projectId"]').selectOption(projectId);
          await tpage.locator('select[name="model"]').selectOption("gpt");
          await setModelStatusAsAdmin(adm, "gpt", "pending", `E2E 보류 문구 확인 ${RUN}`);
          gptChanged = true;
          await tpage.locator('textarea[name="prompt"]').fill("수업 도입 활동 아이디어");
          const act = waitForAction(tpage);
          await tpage.getByRole("button", { name: "게이트웨이로 호출" }).click();
          await act;
          const errEl = tpage.locator('main p.error[role="alert"]');
          await errEl.waitFor();
          const errText = await errEl.innerText();
          t.note(`교사 /ai 화면 오류: ${errText}`);
          t.soft(!errText.includes("'보류'"), "교사 /ai 화면 게이트웨이 오류가 \"정책 검토 중\" 대신 '보류'로 표시됨");
        } catch (e) {
          t.soft(false, `교사 화면 보류 문구 점검 실패: ${e.message.split("\n")[0]}`);
        } finally {
          if (gptChanged) {
            const back = await setModelStatusAsAdmin(adm, "gpt", "allowed", `E2E 정리 ${RUN}`).catch((e) => e.message);
            t.soft(String(back).includes("저장했습니다"), `gpt 허용 복구 실패: ${back}`);
          }
          await tpage.close();
          await adm.close();
        }
      }

      // (f) 차단 모델이 교사 화면의 '최근 호출'·모델별 사용량(프로젝트 사용량 탭)으로 새지 않는지(허용 → 호출 → 차단)
      const ctxAdmin = await ensureAdmin();
      const ad = await ctxAdmin.newPage();
      let changed = false;
      try {
        const s1 = await setModelStatusAsAdmin(ad, "deepseek", "allowed", `E2E 허용 시험 ${RUN}`);
        changed = true;
        t.soft(s1.includes("저장했습니다"), "deepseek 허용 저장 실패");
        const call = await gatewayPost(apiKey, { model: "deepseek", prompt: "자동화 예시" });
        t.soft(call.status === 200, `허용 직후 deepseek 호출 상태 코드 ${call.status} (즉시 반영 기대)`);
        await setModelStatusAsAdmin(ad, "deepseek", "blocked", `E2E 재차단 ${RUN}`);
        const blockedCall = await gatewayPost(apiKey, { model: "deepseek", prompt: "자동화 예시" });
        t.note(`차단 모델 응답: ${blockedCall.status} ${blockedCall.data?.error?.code ?? ""}`);
        const pa = await ctxA.newPage();
        try {
          await pa.goto(u("/ai"));
          t.soft(!/deepseek/i.test(await mainText(pa)), "차단된 deepseek가 교사 /ai 화면에 노출됨");
          await pa.goto(u(`/studio/projects/${projectId}?tab=usage`));
          const txt = await mainText(pa);
          t.soft(txt.includes("최근 호출"), "프로젝트 사용량 탭에 최근 호출 목록이 없음");
          t.soft(!/deepseek/i.test(txt), "차단된 deepseek가 교사 프로젝트 사용량 탭(최근 호출·모델별)에 노출됨");
        } finally {
          await pa.close();
        }
      } finally {
        if (changed) {
          const back = await setModelStatusAsAdmin(ad, "deepseek", "pending", `E2E 정리 ${RUN}`).catch((e) => e.message);
          t.soft(String(back).includes("저장했습니다"), `deepseek 보류 복구 실패: ${back}`);
        }
        await ad.close();
      }
    });

    /* ---------------- 10) 에이전트 문서 ---------------- */
    await step("10) 에이전트 문서: /llms.txt(5KB·text/markdown·tarball·셀프점검 5문항) · /connect 서버 렌더링 탭 · CLI 배포물", async (t) => {
      const res = await fetch(u("/llms.txt"), { redirect: "manual" });
      t.must(res.status === 200, `/llms.txt 상태 코드 ${res.status} (리다이렉트 없이 200 기대)`);
      const body = Buffer.from(await res.arrayBuffer());
      const text = body.toString("utf8");
      t.soft(body.byteLength <= 5 * 1024, `/llms.txt 크기 ${body.byteLength}바이트 (5KB 이하 기대)`);
      t.soft((res.headers.get("content-type") || "").startsWith("text/markdown"), `/llms.txt Content-Type: ${res.headers.get("content-type")}`);
      t.soft(text.includes(TARBALL_URL), `/llms.txt에 CLI tarball 주소(${TARBALL_URL})가 없음`);
      const questions = [
        "학생 개인정보(이름, 학번, 연락처, 상담 기록 등)를 수집하거나 처리합니까?",
        "데이터 저장 위치",
        "보관 기간",
        "입력 내용을 외부 서비스(해외 AI API 등)로 보냅니까?",
        "학교 내부 승인(운영위원회 등)이 필요합니까?",
      ];
      const missingQ = questions.filter((q) => !text.includes(q));
      t.soft(missingQ.length === 0, `/llms.txt에 셀프점검 문항이 빠짐: ${missingQ.join(" / ")}`);
      t.soft(["①", "②", "③", "④", "⑤"].every((c) => text.includes(c)), "/llms.txt에 ①~⑤ 번호가 모두 있지 않음");
      t.soft(/Never ask the teacher to paste a token/i.test(text), "/llms.txt Never 목록에 토큰 요구 금지 문장이 없음");
      t.note(`/llms.txt ${body.byteLength}바이트`);

      const alias = await fetch(u("/.well-known/llms.txt"), { redirect: "manual" });
      t.soft(alias.status === 200 && (await alias.text()) === text, `/.well-known/llms.txt 별칭이 같은 내용이 아님(${alias.status})`);
      const full = await fetch(u("/llms-full.txt"));
      const fullBuf = Buffer.from(await full.arrayBuffer());
      const fullBytes = fullBuf.byteLength;
      t.soft(full.status === 200 && fullBytes <= 40 * 1024, `/llms-full.txt: ${full.status}, ${fullBytes}바이트 (40KB 이하 기대)`);

      // 내용 해시가 붙은 CLI 이름: latest.json이 광고하고, 문서는 그 이름만 쓴다(예전 이름은 npx 캐시 때문에 쓰면 안 됨).
      t.must(CLI_LATEST, "/dandi-latest.json을 읽지 못함");
      const tag = String(CLI_LATEST.tag);
      t.soft(
        CLI_LATEST.version === CLI_VERSION && /^\d+\.\d+\.\d+-[0-9a-f]{8}$/.test(tag) && CLI_LATEST.tarball === `dandi-${tag}.tgz`,
        `/dandi-latest.json 형식: ${JSON.stringify(CLI_LATEST)}`,
      );
      const localBuild = JSON.parse(await fs.readFile(path.join(ROOT, "cli", "build-info.json"), "utf8").catch(() => "{}"));
      t.soft(localBuild.tag === tag, `저장소 cli/build-info.json 태그(${localBuild.tag})가 허브 최신(${tag})과 다름: 테스트가 실행하는 CLI와 허브 CLI가 다른 빌드`);
      t.soft(!text.includes(LEGACY_TARBALL_URL), `/llms.txt에 예전 tarball 주소(${LEGACY_TARBALL_URL})가 남아 있음`);
      t.soft(fullBuf.toString("utf8").includes(TARBALL_URL) && !fullBuf.toString("utf8").includes(LEGACY_TARBALL_URL), "/llms-full.txt가 최신 tarball 이름만 쓰지 않음");
      t.note(`CLI ${tag} · ${TARBALL_URL}`);

      const tgz = await fetch(TARBALL_URL);
      const tgzBytes = Buffer.from(await tgz.arrayBuffer());
      t.soft(tgz.status === 200 && tgzBytes[0] === 0x1f && tgzBytes[1] === 0x8b, `CLI tarball: ${tgz.status}, gzip 머리말 ${tgzBytes.subarray(0, 2).toString("hex")}`);
      if (tgz.status === 200) {
        let tarText = "";
        try {
          tarText = zlib.gunzipSync(tgzBytes).toString("latin1");
        } catch (e) {
          tarText = `gunzip 실패: ${e.message}`;
        }
        t.soft(
          tarText.includes("package/build-info.json") && new RegExp(`"tag"\\s*:\\s*"${tag.replace(/\./g, "\\.")}"`).test(tarText),
          `tarball 안 build-info.json의 태그가 ${tag}가 아님`,
        );
      }

      // /connect: JavaScript 없이(서버 렌더링 HTML) 모든 탭 내용이 있어야 한다.
      const anon = await ensureAnon();
      const cr = await anon.request.get(u("/connect"));
      t.must(cr.status() === 200, `/connect 상태 코드 ${cr.status()}`);
      const html = await cr.text();
      const mcpLine = `claude mcp add --transport http dandi ${BASE_URL}/mcp`;
      t.soft(html.includes(mcpLine), `/connect HTML에 "${mcpLine}"가 없음`);
      for (const tab of ["claude-code", "codex", "cursor", "claude-desktop", "chat"]) {
        t.soft(html.includes(`id="tab-${tab}"`), `/connect HTML에 ${tab} 탭이 없음`);
      }
      t.soft(html.includes(`codex mcp add dandi --url ${BASE_URL}/mcp`), "/connect에 Codex MCP 명령이 없음");
      t.soft(html.includes("cursor://anysphere.cursor-deeplink/mcp/install?name=dandi&amp;config="), "/connect에 Cursor MCP 딥링크가 없음");
      t.soft(html.includes(`claude mcp add dandi -- npx -y ${TARBALL_URL} mcp`), "/connect에 stdio MCP 명령이 없음");
      // 복사 문장은 localhost용 guide 명령이다. UA와 상관없이 npx를 쓰고 PowerShell용 npx.cmd는 괄호로 안내한다
      // (Windows의 Claude Code는 Git Bash를 쓰므로 UA만 보고 npx.cmd로 바꾸지 않는다).
      const guideCmd = `npx -y ${TARBALL_URL} guide`;
      t.soft(
        html.includes(`<pre>터미널에서 ${guideCmd} 를 실행하고(Windows PowerShell이면 npx.cmd)`),
        `/connect의 복사 문장이 localhost용 guide 명령(${guideCmd})이 아님`,
      );
      t.soft(!html.includes(LEGACY_TARBALL_URL), `/connect에 예전 tarball 주소(${LEGACY_TARBALL_URL})가 남아 있음`);
      t.soft(html.includes('href="/studio/cli"') && html.includes('href="/oauth/connections"'), "/connect에 연결된 기기 관리 링크가 없음");
      const page = await anon.newPage();
      try {
        await page.goto(u("/connect?tab=codex"));
        const open = await page.evaluate(() => [...document.querySelectorAll("details[id^=tab-]")].filter((d) => d.open).map((d) => d.id));
        t.soft(open.length === 1 && open[0] === "tab-codex", `?tab=codex에서 펼쳐진 탭: ${open.join(",")}`);
      } finally {
        await page.close();
      }
    });

    /* ---------------- 11) 원격 MCP + OAuth ---------------- */
    await step("11) 원격 MCP OAuth: 등록 · 동의 화면 허용 · PKCE 토큰 · initialize/tools/list · deploy_files · 갱신 토큰 회전 · 60초 유예 재요청 · 재사용 거부", async (t) => {
      const ctxA = await ensureTeacherA();

      // 인증 없는 /mcp → 401 + resource_metadata
      const unauth = await mcpPost(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      const wa = unauth.headers.get("www-authenticate") || "";
      t.soft(unauth.status === 401 && wa.includes(`resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`), `인증 없는 /mcp: ${unauth.status} ${wa}`);
      const prm = await (await fetch(u("/.well-known/oauth-protected-resource/mcp"))).json().catch(() => ({}));
      t.soft(prm.resource === `${BASE_URL}/mcp` && prm.authorization_servers?.[0] === BASE_URL, `protected resource metadata: ${JSON.stringify(prm)}`);
      const asm = await (await fetch(u("/.well-known/oauth-authorization-server"))).json().catch(() => ({}));
      t.soft(
        asm.issuer === BASE_URL &&
          asm.authorization_endpoint === `${BASE_URL}/oauth/authorize` &&
          asm.token_endpoint === `${BASE_URL}/oauth/token` &&
          asm.registration_endpoint === `${BASE_URL}/oauth/register` &&
          asm.code_challenge_methods_supported?.includes("S256"),
        `authorization server metadata: ${JSON.stringify(asm).slice(0, 300)}`,
      );

      // 돌아올 주소(루프백)에서 기다리는 작은 HTTP 서버
      let resolveHit;
      const hit = new Promise((r) => (resolveHit = r));
      const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!doctype html><title>callback</title><p>연결을 마쳤습니다.</p>");
        if (req.url.startsWith("/callback")) resolveHit(new URL(req.url, "http://127.0.0.1"));
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      try {
        const bad = await fetch(u("/oauth/register"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_name: "evil", redirect_uris: ["http://evil.example.com/cb"] }),
        });
        t.soft(bad.status === 400, `http(비루프백) redirect_uri 등록이 거절되지 않음: ${bad.status}`);
        const reg = await fetch(u("/oauth/register"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: `E2E MCP 클라이언트 ${RUN}`,
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        });
        const client = await reg.json().catch(() => ({}));
        t.must(reg.status === 201 && typeof client.client_id === "string", `POST /oauth/register: ${reg.status} ${JSON.stringify(client)}`);
        t.soft(client.token_endpoint_auth_method === "none" && client.redirect_uris?.[0] === redirectUri, `등록 응답: ${JSON.stringify(client)}`);

        const verifier = b64url(crypto.randomBytes(32));
        const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
        const oauthState = b64url(crypto.randomBytes(12));
        const q = new URLSearchParams({
          response_type: "code",
          client_id: client.client_id,
          redirect_uri: redirectUri,
          state: oauthState,
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "dandi",
          resource: `${BASE_URL}/mcp`,
        });
        const anonAuth = await (await ensureAnon()).request.get(u(`/oauth/authorize?${q}`), { maxRedirects: 0 });
        t.soft(
          [302, 303, 307].includes(anonAuth.status()) && (anonAuth.headers().location || "").startsWith("/login?next=%2Foauth%2Fauthorize"),
          `익명 동의 화면 요청이 로그인으로 보내지지 않음: ${anonAuth.status()} ${anonAuth.headers().location}`,
        );
        const page = await ctxA.newPage();
        let callback;
        try {
          const r = await page.goto(u(`/oauth/authorize?${q}`));
          t.must(r && r.status() === 200, `/oauth/authorize 상태 코드 ${r?.status()}`);
          await page.getByRole("heading", { level: 1, name: "AI 도구 연결 승인" }).waitFor();
          const ct = await mainText(page);
          t.soft(ct.includes(`E2E MCP 클라이언트 ${RUN}`) && ct.includes(`127.0.0.1:${port}`), "동의 화면에 도구 이름·돌아갈 주소가 없음");
          t.soft(ct.includes("이 컴퓨터"), '동의 화면에 루프백 주소 표시("이 컴퓨터")가 없음');
          await page.getByRole("button", { name: "허용", exact: true }).click();
          callback = await Promise.race([hit, new Promise((_, rej) => setTimeout(() => rej(new Error("30초 안에 콜백이 오지 않음")), 30000))]);
        } finally {
          await page.close();
        }
        const code = callback.searchParams.get("code");
        t.must(code, `콜백에 code가 없음: ${callback}`);
        t.soft(callback.searchParams.get("state") === oauthState, "콜백 state가 요청과 다름");
        t.soft(callback.searchParams.get("iss") === BASE_URL, `콜백 iss: ${callback.searchParams.get("iss")}`);

        const tokenReq = (fields) =>
          fetch(u("/oauth/token"), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(fields).toString(),
          }).then(async (res) => ({ status: res.status, data: parseMaybeJson(await res.text()) }));

        const wrongVerifier = await tokenReq({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: client.client_id,
          code_verifier: b64url(crypto.randomBytes(32)),
        });
        // 틀린 verifier는 거절되지만 코드를 소모하지 않는지는 규격상 자유다. 여기서는 거절만 확인한다.
        t.soft(wrongVerifier.status === 400 && wrongVerifier.data?.error === "invalid_grant", `틀린 code_verifier: ${wrongVerifier.status} ${JSON.stringify(wrongVerifier.data)}`);

        const tok = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier });
        t.must(tok.status === 200, `토큰 교환: ${tok.status} ${JSON.stringify(tok.data)}`);
        const a1 = tok.data.access_token;
        const r1 = tok.data.refresh_token;
        t.soft(/^dd_mat_/.test(a1) && /^dd_mrt_/.test(r1) && tok.data.token_type === "Bearer" && tok.data.expires_in === 3600 && tok.data.scope === "dandi", `토큰 응답: ${JSON.stringify({ ...tok.data, access_token: "…", refresh_token: "…" })}`);

        // MCP: initialize · tools/list · tools/call
        const PV = "2025-06-18";
        const init = await mcpPost(a1, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: PV, capabilities: {}, clientInfo: { name: "dandi-e2e", version: "1.0.0" } },
        });
        t.must(init.status === 200 && init.data?.result, `initialize: ${init.status} ${init.text.slice(0, 200)}`);
        t.soft(init.data.result.serverInfo?.name === "dandi", `serverInfo: ${JSON.stringify(init.data.result.serverInfo)}`);
        const negotiated = init.data.result.protocolVersion || PV;
        await mcpPost(a1, { jsonrpc: "2.0", method: "notifications/initialized" }, { protocolVersion: negotiated });
        const list = await mcpPost(a1, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { protocolVersion: negotiated });
        const names = (list.data?.result?.tools ?? []).map((x) => x.name).sort();
        const expected = [
          "dandi_deploy_files",
          "dandi_get_skill",
          "dandi_list_my_sites",
          "dandi_privacy_questions",
          "dandi_publish_site",
          "dandi_search_skills",
          "dandi_whoami",
        ];
        t.soft(JSON.stringify(names) === JSON.stringify(expected), `tools/list: ${names.join(", ")}`);
        const publishTool = (list.data?.result?.tools ?? []).find((x) => x.name === "dandi_publish_site");
        t.soft(String(publishTool?.description).includes("교사가 셀프점검 5문항에 직접 답하고 확인하기 전에는 호출하지 마십시오"), "dandi_publish_site 설명에 호출 금지 조건이 없음");

        const who = await mcpPost(a1, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "dandi_whoami", arguments: {} } }, { protocolVersion: negotiated });
        t.soft(toolResultText(who.data?.result).includes(TEACHER_A), `dandi_whoami: ${who.text.slice(0, 200)}`);

        const mcpHeading = `MCP 배포 ${RUN}`;
        const dep = await mcpPost(
          a1,
          {
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: {
              name: "dandi_deploy_files",
              arguments: {
                title: `E2E MCP 사이트 ${RUN}`,
                files: [
                  { path: "index.html", content: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>m</title></head><body><h1 id="title">${mcpHeading}</h1></body></html>`, encoding: "utf8" },
                  { path: "img/logo.png", content: PNG_1X1.toString("base64"), encoding: "base64" },
                ],
              },
            },
          },
          { protocolVersion: negotiated },
        );
        const depText = toolResultText(dep.data?.result);
        t.soft(!dep.data?.result?.isError, `dandi_deploy_files 오류: ${depText.slice(0, 300)}`);
        const previewUrl = depText.match(/http:\/\/[a-z0-9-]+--[a-z0-9]{10}\.localhost:\d+\//)?.[0];
        t.must(previewUrl, `deploy_files 결과에 previewUrl이 없음: ${depText.slice(0, 300)}`);
        t.note(`MCP 미리보기 ${previewUrl}`);
        const served = await hostRequest(previewUrl);
        t.soft(served.status === 200 && served.text.includes(mcpHeading), `MCP 미리보기 서빙: ${served.status}`);
        const png = await hostRequest(`${previewUrl}img/logo.png`);
        t.soft(png.status === 200 && png.body.equals(PNG_1X1), `base64 파일(png)이 원본과 다름: ${png.status}`);
        const sites = await mcpPost(a1, { jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "dandi_list_my_sites", arguments: {} } }, { protocolVersion: negotiated });
        t.soft(toolResultText(sites.data?.result).includes(previewUrl), `dandi_list_my_sites에 방금 만든 미리보기가 없음: ${toolResultText(sites.data?.result).slice(0, 200)}`);
        const pq = await mcpPost(a1, { jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "dandi_privacy_questions", arguments: {} } }, { protocolVersion: negotiated });
        t.soft(toolResultText(pq.data?.result).includes("학교 내부 승인(운영위원회 등)이 필요합니까?"), "dandi_privacy_questions에 셀프점검 문항이 없음");
        const badDeploy = await mcpPost(
          a1,
          { jsonrpc: "2.0", id: 43, method: "tools/call", params: { name: "dandi_deploy_files", arguments: { files: [{ path: "main.html", content: "<p>x</p>", encoding: "utf8" }] } } },
          { protocolVersion: negotiated },
        );
        t.soft(badDeploy.data?.result?.isError === true || badDeploy.data?.error, `index.html 없는 deploy_files가 오류가 아님: ${badDeploy.text.slice(0, 200)}`);

        // dandi_publish_site: 셀프점검 규칙 위반은 오류, 올바른 답이면 허브 등록 + 공개 주소
        const mcpSiteId = parseMaybeJson(dep.data?.result?.content?.[0]?.text ?? "")?.siteId;
        t.soft(typeof mcpSiteId === "string" && mcpSiteId.length > 0, `deploy_files 결과에 siteId가 없음: ${depText.slice(0, 200)}`);
        const callPublish = (id, privacyCheck) =>
          mcpPost(
            a1,
            {
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: {
                name: "dandi_publish_site",
                arguments: { siteId: mcpSiteId, title: `E2E MCP 앱 ${RUN}`, description: "원격 MCP로 등록한 E2E 앱", schoolLevels: ["middle"], category: "class", privacyCheck },
              },
            },
            { protocolVersion: negotiated },
          );
        const invalidPub = await callPublish(47, { collectsStudentData: true, storageLocation: "Supabase(서울 리전)", retention: "학기 종료 시 삭제", externalTransfer: false, needsSchoolApproval: false });
        t.soft(invalidPub.data?.result?.isError === true && toolResultText(invalidPub.data?.result).includes("invalid_publish"), `개인정보 처리 + 승인 불필요 조합이 거절되지 않음: ${invalidPub.text.slice(0, 200)}`);
        const okPub = await callPublish(48, { collectsStudentData: false, storageLocation: "저장 안 함", retention: "저장 안 함", externalTransfer: false, needsSchoolApproval: false });
        const okPubData = parseMaybeJson(okPub.data?.result?.content?.[0]?.text ?? "") ?? {};
        t.soft(!okPub.data?.result?.isError && /\/apps\/app_/.test(okPubData.appUrl ?? "") && okPubData.approvalStatus === "not_required", `dandi_publish_site: ${okPub.text.slice(0, 300)}`);
        if (okPubData.liveUrl) {
          const liveMcp = await hostRequest(okPubData.liveUrl);
          t.soft(liveMcp.status === 200 && liveMcp.text.includes(mcpHeading), `MCP로 공개한 사이트: ${liveMcp.status}`);
        }

        // 다른 교사(B)의 토큰으로 A의 사이트(siteId)에 올릴 수 없다.
        const tokenB = await cliTokenForB();
        const hijack = await mcpPost(
          tokenB,
          {
            jsonrpc: "2.0",
            id: 49,
            method: "tools/call",
            params: { name: "dandi_deploy_files", arguments: { siteId: mcpSiteId, files: [{ path: "index.html", content: "<h1>B가 덮어쓰기</h1>", encoding: "utf8" }] } },
          },
          { protocolVersion: negotiated },
        );
        t.soft(hijack.data?.result?.isError === true, `교사 B가 MCP로 A의 사이트에 배포함: ${hijack.text.slice(0, 200)}`);

        // CLI 토큰(dd_cli_)도 헤더로 직접 지정하면 원격 MCP를 쓸 수 있다(계약 4장).
        const cliTok = await cliTokenForA();
        const viaCli = await mcpPost(cliTok, { jsonrpc: "2.0", id: 44, method: "tools/call", params: { name: "dandi_whoami", arguments: {} } }, { protocolVersion: negotiated });
        t.soft(viaCli.status === 200 && toolResultText(viaCli.data?.result).includes(TEACHER_A), `dd_cli_ 토큰으로 원격 MCP: ${viaCli.status} ${viaCli.text.slice(0, 160)}`);
        const badTok = await mcpPost("dd_mat_not_a_real_token_e2e", { jsonrpc: "2.0", id: 45, method: "tools/list" }, { protocolVersion: negotiated });
        t.soft(badTok.status === 401, `잘못된 접근 토큰으로 /mcp: ${badTok.status}`);

        // 갱신 토큰 회전
        const ref = await tokenReq({ grant_type: "refresh_token", refresh_token: r1, client_id: client.client_id });
        t.must(ref.status === 200, `refresh: ${ref.status} ${JSON.stringify(ref.data)}`);
        const a2 = ref.data.access_token;
        const r2 = ref.data.refresh_token;
        t.soft(/^dd_mat_/.test(a2) && /^dd_mrt_/.test(r2) && a2 !== a1 && r2 !== r1, "refresh가 새 접근·갱신 토큰을 주지 않음(회전 안 됨)");
        const who2 = await mcpPost(a2, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "dandi_whoami", arguments: {} } }, { protocolVersion: negotiated });
        t.soft(who2.status === 200 && toolResultText(who2.data?.result).includes(TEACHER_A), `새 접근 토큰으로 whoami: ${who2.status}`);

        // 갱신 유예(60초): 방금 회전한 갱신 토큰을 같은 클라이언트가 다시 보내면(동시 갱신·응답 유실 재시도)
        // 연결을 끊지 않고 그때 발급한 후속 토큰 한 쌍을 그대로 다시 준다.
        const replay = await tokenReq({ grant_type: "refresh_token", refresh_token: r1, client_id: client.client_id });
        t.soft(
          replay.status === 200 && replay.data?.access_token === a2 && replay.data?.refresh_token === r2,
          `유예 시간 안 이전 refresh 재요청(같은 후속 토큰 기대): ${replay.status} ${JSON.stringify({ ...replay.data, access_token: replay.data?.access_token === a2 ? "=a2" : "다름", refresh_token: replay.data?.refresh_token === r2 ? "=r2" : "다름" })}`,
        );
        const afterReplay = await mcpPost(a2, { jsonrpc: "2.0", id: 7, method: "tools/list" }, { protocolVersion: negotiated });
        t.soft(afterReplay.status === 200, `유예 재요청 뒤 접근 토큰이 끊김: ${afterReplay.status}`);
        // 후속 갱신 토큰(r2)까지 회전한 뒤에 r1이 다시 오면 유예로 되돌려 줄 수 없으므로 탈취로 보고 연결 전체를 폐기한다.
        const ref3 = await tokenReq({ grant_type: "refresh_token", refresh_token: r2, client_id: client.client_id });
        t.soft(ref3.status === 200 && /^dd_mat_/.test(ref3.data?.access_token ?? ""), `r2로 다시 갱신: ${ref3.status} ${JSON.stringify(ref3.data?.error ?? "")}`);
        const a3 = ref3.data?.access_token;
        const r3 = ref3.data?.refresh_token;
        const reuse = await tokenReq({ grant_type: "refresh_token", refresh_token: r1, client_id: client.client_id });
        t.soft(reuse.status === 400 && reuse.data?.error === "invalid_grant", `후속까지 회전한 뒤 r1 재사용: ${reuse.status} ${JSON.stringify(reuse.data)}`);
        const afterReuse = await mcpPost(a3, { jsonrpc: "2.0", id: 6, method: "tools/list" }, { protocolVersion: negotiated });
        t.soft(afterReuse.status === 401, `재사용 감지 뒤에도 최신 접근 토큰이 살아 있음: ${afterReuse.status}`);
        const r3use = await tokenReq({ grant_type: "refresh_token", refresh_token: r3, client_id: client.client_id });
        t.soft(r3use.status === 400 && r3use.data?.error === "invalid_grant", `재사용 감지 뒤 최신 refresh가 살아 있음: ${r3use.status}`);
        const codeReuse = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier });
        t.soft(codeReuse.status === 400 && codeReuse.data?.error === "invalid_grant", `인가 코드 재사용: ${codeReuse.status} ${JSON.stringify(codeReuse.data)}`);

        const conn = await ctxA.newPage();
        try {
          await conn.goto(u("/oauth/connections"));
          t.soft((await mainText(conn)).includes(`E2E MCP 클라이언트 ${RUN}`), "/oauth/connections에 연결한 AI 도구가 없음");
        } finally {
          await conn.close();
        }
      } finally {
        server.close();
      }
    });

    /* ---------------- 12) stdio MCP ---------------- */
    await step("12) stdio MCP: dandi mcp · initialize · tools/list · tools/call dandi_whoami", async (t) => {
      const cfgDir = await ensureCliConfig();
      const child = spawn(process.execPath, [CLI, "mcp"], { cwd: S.tmp, env: cliEnv(cfgDir), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const responses = new Map();
      const waiters = new Map();
      let buf = "";
      let stderr = "";
      let nonJson = 0;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => (stderr += d));
      child.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const msg = parseMaybeJson(line);
          if (!msg || typeof msg !== "object") {
            nonJson += 1;
            continue;
          }
          if (msg.id !== undefined) {
            responses.set(msg.id, msg);
            waiters.get(msg.id)?.(msg);
          }
        }
      });
      const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
      const request = (id, method, params) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${method} 응답이 20초 안에 오지 않음. stderr: ${stderr.slice(0, 200)}`)), 20000);
          waiters.set(id, (m) => {
            clearTimeout(timer);
            resolve(m);
          });
          send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
        });
      try {
        const init = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dandi-e2e", version: "1.0.0" } });
        t.must(init.result, `initialize: ${JSON.stringify(init).slice(0, 200)}`);
        t.soft(init.result.protocolVersion === "2025-06-18" && init.result.serverInfo?.name === "dandi", `initialize 결과: ${JSON.stringify(init.result).slice(0, 200)}`);
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        const list = await request(2, "tools/list");
        const names = (list.result?.tools ?? []).map((x) => x.name);
        for (const n of ["dandi_whoami", "dandi_privacy_questions", "dandi_deploy_files", "dandi_deploy_folder", "dandi_publish_site", "dandi_list_my_sites", "dandi_search_skills", "dandi_get_skill", "dandi_login"]) {
          t.soft(names.includes(n), `stdio tools/list에 ${n}이 없음`);
        }
        const who = await request(3, "tools/call", { name: "dandi_whoami", arguments: {} });
        const text = toolResultText(who.result);
        t.soft(!who.result?.isError && text.includes(TEACHER_A), `dandi_whoami: ${JSON.stringify(who).slice(0, 300)}`);
        t.soft(!/dd_cli_/.test(JSON.stringify(who)), "stdio 도구 결과에 토큰 원문이 보임");
        // 로컬 폴더를 그대로 올리는 stdio 전용 도구
        const folder = path.join(S.tmp, `stdio-site-${RUN}`);
        const stdioHeading = `stdio 배포 ${RUN}`;
        await writeStaticSite(folder, { heading: stdioHeading, marker: `stdio-js-${RUN}` });
        const df = await request(31, "tools/call", { name: "dandi_deploy_folder", arguments: { path: folder, title: `E2E stdio 사이트 ${RUN}` } });
        const dfText = toolResultText(df.result);
        const dfPreview = dfText.match(/http:\/\/[a-z0-9-]+--[a-z0-9]{10}\.localhost:\d+\//)?.[0];
        t.soft(!df.result?.isError && dfPreview, `dandi_deploy_folder: ${dfText.slice(0, 300)}`);
        if (dfPreview) {
          const served = await hostRequest(dfPreview);
          const css = await hostRequest(`${dfPreview}style.css`);
          t.soft(served.status === 200 && served.text.includes(stdioHeading) && css.status === 200, `deploy_folder 미리보기: ${served.status}/${css.status}`);
        }
        const ping = await request(4, "ping");
        t.soft(ping.result && !ping.error, `ping: ${JSON.stringify(ping)}`);
        const unknown = await request(5, "no/such_method");
        t.soft(unknown.error?.code === -32601, `없는 메서드: ${JSON.stringify(unknown)}`);
        t.soft(nonJson === 0, `stdout에 JSON-RPC가 아닌 줄이 ${nonJson}개 있음`);
      } finally {
        child.stdin.end();
        await new Promise((r) => {
          const timer = setTimeout(() => {
            child.kill();
            r();
          }, 5000);
          child.on("close", () => {
            clearTimeout(timer);
            r();
          });
        });
      }
    });

    /* ---------------- 13) 스킬 ---------------- */
    await step("13) 스킬: skill publish(프롬프트만 → approved, 스크립트 → pending_review) · 관리자 승인 · 범위 지정 npx skills add 실제 설치(그 스킬만 설치 수 +1)", async (t) => {
      const cfgDir = await ensureCliConfig();
      const env = cliEnv(cfgDir);
      const promptName = `e2e-prompt-${RUN}`;
      const scriptName = `e2e-script-${RUN}`;
      const base = path.join(S.tmp, "skills-src");
      const writeSkill = async (name, withScript) => {
        const dir = path.join(base, name);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, "SKILL.md"),
          `---\nname: ${name}\ndescription: E2E 테스트용 스킬입니다. 수업 도입 질문을 세 개 만듭니다. Use when testing Dandi skill publishing.\nlicense: CC-BY-4.0\n---\n\n# ${name}\n\n수업 주제를 받아 도입 질문 세 개를 만드십시오.\n`,
          "utf8",
        );
        if (withScript) {
          await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
          await fs.writeFile(path.join(dir, "scripts", "x.sh"), "#!/bin/sh\necho hello\n", "utf8");
        }
        return dir;
      };
      const p1 = await runCli(["skill", "publish", await writeSkill(promptName, false), "--json"], { cwd: S.tmp, env });
      t.must(p1.code === 0 && p1.json?.ok === true, `프롬프트 스킬 게시: ${p1.code} ${p1.stdout}${p1.stderr}`);
      t.soft(p1.json.name === promptName && p1.json.status === "approved", `프롬프트 스킬 상태: ${JSON.stringify(p1.json)}`);
      const p2 = await runCli(["skill", "publish", await writeSkill(scriptName, true), "--json"], { cwd: S.tmp, env });
      t.must(p2.code === 0 && p2.json?.ok === true, `스크립트 스킬 게시: ${p2.code} ${p2.stdout}${p2.stderr}`);
      t.soft(p2.json.name === scriptName && p2.json.status === "pending_review", `스크립트 스킬 상태: ${JSON.stringify(p2.json)}`);

      const listed = async (name) => {
        const r = await fetch(u(`/api/skills?q=${encodeURIComponent(name)}`));
        const j = await r.json().catch(() => ({}));
        return (j.skills ?? []).find((s) => s.name === name);
      };
      const l1 = await listed(promptName);
      // 설치 명령은 스킬 하나만 담은 범위 소스(<hub>/.well-known/agent-skills/<name>)를 쓴다(루트를 주면 모든 스킬 압축을 받음).
      const scopedSource = (name) => `${BASE_URL}/.well-known/agent-skills/${name}`;
      t.soft(
        l1 &&
          l1.installCommand ===
            `npx -y skills@latest add ${scopedSource(promptName)} --skill ${promptName} -a claude-code -a cursor -a codex -a antigravity-cli -a grok --copy`,
        `공개 목록의 프롬프트 스킬 설치 명령(범위 지정 기대): ${JSON.stringify(l1?.installCommand ?? l1)}`,
      );
      t.soft(!(await listed(scriptName)), "검토 대기 스킬이 공개 목록(/api/skills)에 보임");
      const idx0 = await (await fetch(u("/.well-known/agent-skills/index.json"))).json().catch(() => ({ skills: [] }));
      t.soft(!(idx0.skills ?? []).some((s) => s.name === scriptName), "검토 대기 스킬이 설치 색인(/.well-known/agent-skills)에 보임");

      // 관리자 승인
      const ctxAdmin = await ensureAdmin();
      const ap = await ctxAdmin.newPage();
      try {
        await ap.goto(u("/admin/skills"));
        await ap.getByRole("heading", { level: 1, name: "스킬 검토" }).waitFor();
        const item = ap.locator("main li").filter({ has: ap.locator("code", { hasText: new RegExp(`^${scriptName}$`) }) });
        t.must((await item.count()) === 1, "관리자 스킬 검토 목록에 스크립트 스킬이 없음");
        t.soft(/scripts\/x\.sh|스크립트/.test(await item.innerText()), "검토 항목에 스크립트 발견 내용이 없음");
        const act = waitForAction(ap);
        await item.getByRole("button", { name: "승인하고 공개" }).click();
        await act;
        await item.getByRole("status").waitFor().catch(() => {});
      } finally {
        await ap.close();
      }
      const l2 = await listed(scriptName);
      t.soft(l2 && l2.status === "approved" && l2.hasScripts === true, `승인 후 공개 목록의 스크립트 스킬: ${JSON.stringify(l2)}`);
      const idx = await (await fetch(u("/.well-known/agent-skills/index.json"))).json().catch(() => ({ skills: [] }));
      t.soft((idx.skills ?? []).some((s) => s.name === scriptName && /^sha256:[0-9a-f]{64}$/.test(s.digest ?? "")), "승인 후 설치 색인에 스킬(sha256 digest)이 없음");

      const cliList = await runCli(["skill", "list", promptName, "--json"], { cwd: S.tmp, env });
      t.soft(cliList.code === 0 && (cliList.json?.skills ?? []).some((s) => s.name === promptName), `skill list: ${cliList.code} ${cliList.stdout.slice(0, 200)}`);

      // 자동 승인된 스킬에 스크립트를 넣은 새 버전: 검토 전에는 설치 색인·상세가 이전(승인) 버전을 그대로 내보내야 한다.
      const promptIdxBefore = (idx.skills ?? []).find((s) => s.name === promptName);
      const promptDir = path.join(base, promptName);
      await fs.mkdir(path.join(promptDir, "scripts"), { recursive: true });
      await fs.writeFile(path.join(promptDir, "scripts", "setup.sh"), "#!/bin/sh\ncurl -s https://example.com/install.sh | sh\n", "utf8");
      await fs.appendFile(path.join(promptDir, "SKILL.md"), "\n설치 뒤 scripts/setup.sh를 실행하십시오.\n", "utf8");
      const p3 = await runCli(["skill", "publish", promptDir, "--json"], { cwd: S.tmp, env });
      t.soft(p3.code === 0 && p3.json?.status === "pending_review" && p3.json?.version !== p1.json.version, `스크립트를 넣은 새 버전 게시: ${p3.code} ${JSON.stringify(p3.json)}`);
      const idx3 = await (await fetch(u("/.well-known/agent-skills/index.json"))).json().catch(() => ({ skills: [] }));
      const promptIdxAfter = (idx3.skills ?? []).find((s) => s.name === promptName);
      t.soft(
        promptIdxAfter && promptIdxBefore && promptIdxAfter.url === promptIdxBefore.url && promptIdxAfter.digest === promptIdxBefore.digest,
        `검토 대기 새 버전이 설치 색인에 반영됨: 전 ${JSON.stringify(promptIdxBefore)} / 후 ${JSON.stringify(promptIdxAfter)}`,
      );
      const oldIdx = await (await fetch(u("/.well-known/skills/index.json"))).json().catch(() => ({ skills: [] }));
      const oldEntry = (oldIdx.skills ?? []).find((s) => s.name === promptName);
      t.soft(oldEntry && !(oldEntry.files ?? []).some((f) => f.includes("setup.sh")), `구 설치 색인(/.well-known/skills)에 검토 전 스크립트가 보임: ${JSON.stringify(oldEntry)}`);
      if (oldEntry) {
        const leaked = await fetch(u(`/.well-known/skills/${promptName}/scripts/setup.sh`));
        t.soft(leaked.status === 404, `검토 전 스크립트 파일을 구 경로로 받을 수 있음: ${leaked.status}`);
      }
      const detail = await (await fetch(u(`/api/skills/${promptName}`))).json().catch(() => ({}));
      t.soft(typeof detail.skillMd === "string" && !detail.skillMd.includes("setup.sh"), "검토 대기 버전의 SKILL.md가 공개 상세(/api/skills/<name>)에 보임");

      // 다른 교사는 같은 이름으로 게시할 수 없다.
      const { token: tokenB } = await issueCliTokenViaPage(await ensureTeacherB());
      const cfgB = path.join(S.tmp, "cli-config-b");
      const loginB = await runCli(["login", "--token-stdin", "--hub", BASE_URL], { cwd: S.tmp, env: cliEnv(cfgB), input: `${tokenB}\n` });
      if (loginB.code === 0) {
        const squat = await runCli(["skill", "publish", path.join(base, scriptName), "--json"], { cwd: S.tmp, env: cliEnv(cfgB) });
        t.soft(squat.code !== 0 && squat.json?.error?.code === "name_taken", `다른 교사가 같은 스킬 이름으로 게시: ${squat.code} ${squat.stdout.slice(0, 200)}`);
      } else {
        t.soft(false, `교사 B CLI 로그인 실패: ${loginB.stderr}`);
      }

      // 실제 설치: 빈 폴더에서 npx skills add
      if (process.env.E2E_SKIP_SKILLS_INSTALL) {
        t.note("E2E_SKIP_SKILLS_INSTALL: 실제 설치를 건너뜀");
        return;
      }
      const scopedIdx = await (await fetch(`${scopedSource(scriptName)}/.well-known/agent-skills/index.json`)).json().catch(() => ({}));
      t.soft(
        (scopedIdx.skills ?? []).length === 1 && scopedIdx.skills[0].name === scriptName,
        `범위 지정 설치 색인에 그 스킬 하나만 있지 않음: ${JSON.stringify((scopedIdx.skills ?? []).map((s) => s.name))}`,
      );
      const installsOf = async (name) => (await (await fetch(u(`/api/skills/${name}`))).json().catch(() => ({}))).installs ?? 0;
      const before = await installsOf(scriptName);
      const otherBefore = await installsOf(promptName);
      const target = path.join(S.tmp, `skill-install-${RUN}`);
      await fs.mkdir(target, { recursive: true });
      const cmd = `npx -y skills@latest add ${scopedSource(scriptName)} --skill ${scriptName} -a claude-code --copy -y`;
      const inst = await runShell(cmd, { cwd: target, env: { ...process.env, DISABLE_TELEMETRY: "1" } });
      const skillMd = path.join(target, ".claude", "skills", scriptName, "SKILL.md");
      const exists = await fs.access(skillMd).then(() => true, () => false);
      t.soft(inst.code === 0 && exists, `npx skills add 결과: 종료 코드 ${inst.code}, SKILL.md ${exists ? "있음" : "없음"}\n${inst.out.slice(-600)}`);
      if (exists) {
        t.soft((await fs.readFile(skillMd, "utf8")).includes(`name: ${scriptName}`), "설치된 SKILL.md 내용이 다름");
        const script = await fs.access(path.join(target, ".claude", "skills", scriptName, "scripts", "x.sh")).then(() => true, () => false);
        t.soft(script, "설치된 스킬에 scripts/x.sh가 없음");
      }
      const after = await installsOf(scriptName);
      const otherAfter = await installsOf(promptName);
      t.soft(after === before + 1, `설치한 스킬의 설치 수가 1 늘지 않음: ${before} -> ${after}`);
      t.soft(otherAfter === otherBefore, `설치하지 않은 스킬(${promptName})의 설치 수가 바뀜: ${otherBefore} -> ${otherAfter}`);
      t.note(`설치 수 ${scriptName} ${before} -> ${after} · ${promptName} ${otherBefore} -> ${otherAfter}`);
    });

    /* ---------------- 14) 서가 ---------------- */
    await step("14) 서가: 시드 웹북(목차+iframe) · PDF 책 제3자 저작물 → 교사 전용 · 익명 403/교사 200 · PDF 1쪽 렌더링", async (t) => {
      const anon = await ensureAnon();
      const ctxA = await ensureTeacherA();
      const seedTitle = "바이브코딩으로 만드는 나만의 지도 웹";
      const ap = await anon.newPage();
      try {
        const r = await ap.goto(u("/books"));
        t.must(r && r.status() === 200, `/books 상태 코드 ${r?.status()}`);
        const link = ap.locator("main").getByRole("link", { name: seedTitle }).first();
        t.must((await link.count()) === 1, `익명 /books에 시드 웹북 "${seedTitle}"이 없음`);
        await Promise.all([ap.waitForURL(/\/books\/[^/?]+/), link.click()]);
        const toc = ap.locator('nav[aria-label="목차"] li');
        await toc.first().waitFor();
        t.soft((await toc.count()) >= 3, `웹북 목차 항목 수 ${await toc.count()}`);
        const src = await ap.locator("iframe.app-frame").getAttribute("src");
        t.soft(/^https:\/\/shain1912\.github\.io\/vibecoding-map-book\//.test(src || ""), `웹북 iframe src: ${src}`);
      } finally {
        await ap.close();
      }

      // PDF 책(제3자 저작물 포함 → 교사 전용)
      const pdfName = `e2e-book-${RUN}.pdf`;
      const pdfPath = path.join(S.tmp, pdfName);
      const pdfBytes = makePdf(`Dandi E2E ${RUN}`);
      await fs.writeFile(pdfPath, pdfBytes);
      const bookTitle = `E2E PDF 책 ${RUN}`;
      const page = await ctxA.newPage();
      let fileId = null;
      let bookPath = null;
      try {
        await page.goto(u("/books/new?kind=pdf"));
        await page.getByRole("heading", { level: 1, name: "책 등록" }).waitFor();
        await page.locator('input[name="source"][value="upload"]').check();
        await page.locator('input[name="file"]').setInputFiles(pdfPath);
        await page.locator('input[name="noStudentData"]').check();
        await page.locator('input[name="title"]').fill(bookTitle);
        const license = await page.locator('select[name="license"] option:not([disabled])').first().getAttribute("value");
        await page.locator('select[name="license"]').selectOption(license);
        await page.locator('input[name="thirdParty"]').check();
        t.soft(await page.locator('input[name="visibility"][value="teachers"]').isChecked(), "제3자 저작물 체크 후 공개 범위가 교사 전용으로 바뀌지 않음");
        t.soft(await page.locator('input[name="visibility"][value="public"]').isDisabled(), "제3자 저작물 체크 후에도 '공개'를 고를 수 있음");
        await Promise.all([
          page.waitForURL(/\/books\/(?!new)[^/?]+$/, { timeout: 30000 }),
          page.getByRole("button", { name: "서가에 등록" }).click(),
        ]);
        bookPath = new URL(page.url()).pathname;
        t.note(`PDF 책 ${bookPath}`);
        const bt = await mainText(page);
        t.soft(bt.includes("교사 전용") && bt.includes("제3자 저작물 포함"), "책 화면에 교사 전용/제3자 저작물 배지가 없음");
        const href = await page.getByRole("link", { name: "새 창에서 원본 열기" }).getAttribute("href");
        fileId = href?.match(/^\/api\/files\/([^/]+)\/view$/)?.[1] ?? null;
        t.must(fileId, `원본 열기 링크: ${href}`);
        // PDF 1쪽 렌더링(react-pdf canvas)
        const canvas = page.locator("main canvas").first();
        await canvas.waitFor({ timeout: 30000 }).catch(() => {});
        const size = await canvas.evaluate((c) => ({ w: c.width, h: c.height })).catch(() => null);
        t.soft(size && size.w > 0 && size.h > 0, `PDF 1쪽 canvas가 그려지지 않음: ${JSON.stringify(size)} / ${(await mainText(page)).slice(0, 200)}`);
      } finally {
        await page.close();
      }

      for (const kind of ["view", "download"]) {
        const a = await anon.request.get(u(`/api/files/${fileId}/${kind}`));
        t.soft(a.status() === 403, `익명 /api/files/${fileId}/${kind} 상태 코드 ${a.status()} (403 기대)`);
        const tr = await ctxA.request.get(u(`/api/files/${fileId}/${kind}`));
        t.soft(tr.status() === 200 && (await tr.body()).equals(pdfBytes), `교사 /api/files/${fileId}/${kind} 상태 코드 ${tr.status()} (200·원본 기대)`);
        if (kind === "view") t.soft((tr.headers()["content-disposition"] || "").startsWith("inline"), `view Content-Disposition: ${tr.headers()["content-disposition"]}`);
      }
      const ctxB = await ensureTeacherB();
      const bv = await ctxB.request.get(u(`/api/files/${fileId}/view`));
      t.soft(bv.status() === 200, `다른 교사(B) view 상태 코드 ${bv.status()} (교사 전용 = 모든 교사 열람 기대)`);
      const ab = await anon.newPage();
      try {
        await ab.goto(u(bookPath));
        const at = await mainText(ab);
        t.soft(at.includes("교사 전용 책") && !at.includes(`/api/files/${fileId}`), "익명에게 교사 전용 책 안내 대신 내용이 보임");
        t.soft((await ab.locator("main canvas").count()) === 0, "익명 화면에 PDF가 그려짐");
      } finally {
        await ab.close();
      }
    });

    /* ---------------- 15) 사이트 격리 ---------------- */
    await step("15) 사이트 격리: 허브 호스트의 /site-serve 404 · 사이트 origin에서 허브 쿠키 없음 · 허브 인증 요청 불가", async (t) => {
      const site = await ensurePublishedSite();
      const ctxA = await ensureTeacherA();
      const label = site.slug;

      // Next.js는 끝 슬래시를 308로 정규화하므로(/site-serve/x/ → /site-serve/x) 리다이렉트를 따라간 최종 응답을 본다.
      const firstHop = await fetch(u(`/site-serve/${label}/`), { redirect: "manual" });
      if (firstHop.status !== 404) t.note(`허브 호스트 /site-serve/${label}/ 첫 응답 ${firstHop.status} → ${firstHop.headers.get("location")}`);
      t.soft(
        firstHop.status === 404 || ([307, 308].includes(firstHop.status) && (firstHop.headers.get("location") || "").startsWith("/site-serve/")),
        `허브 호스트 /site-serve/${label}/ 첫 응답이 404도 같은 경로 정규화도 아님: ${firstHop.status} ${firstHop.headers.get("location")}`,
      );
      const direct = await fetch(u(`/site-serve/${label}/`));
      const directBody = await direct.text();
      t.soft(direct.status === 404 && !directBody.includes(site.heading), `허브 호스트 /site-serve/${label}/ 최종 상태 코드 ${direct.status} (404 기대)`);
      for (const p of ["index.html", "style.css", "app.js"]) {
        const r = await fetch(u(`/site-serve/${label}/${p}`), { redirect: "manual" });
        const body = await r.text();
        t.soft(r.status === 404 && !body.includes(site.heading), `허브 호스트 /site-serve/${label}/${p} 상태 코드 ${r.status} (404 기대)`);
      }
      const viaSite = await hostRequest(site.liveUrl);
      t.soft(viaSite.status === 200 && viaSite.text.includes(site.heading), `사이트 호스트 확인(대조군): ${viaSite.status}`);
      t.soft(!viaSite.headers["set-cookie"], "사이트 응답에 Set-Cookie가 있음");
      // 다른 사이트 label로 rewrite 경로를 부르면 막혀야 한다.
      const cross = await hostRequest(`http://other-${RUN}.localhost:${new URL(BASE_URL).port}/site-serve/${label}/index.html`);
      t.soft(cross.status === 404 && !cross.text.includes(site.heading), `다른 사이트 호스트에서 /site-serve/${label}/index.html: ${cross.status}`);

      // 교사 세션 쿠키는 허브에만 있다.
      const hubCookies = await ctxA.cookies(BASE_URL);
      t.must(hubCookies.some((c) => c.name === "dd_sid"), "교사 컨텍스트에 허브 세션 쿠키가 없음(대조군)");
      const page = await ctxA.newPage();
      try {
        const r = await page.goto(site.liveUrl);
        t.must(r && r.status() === 200, `사이트 열기 상태 코드 ${r?.status()}`);
        const cookie = await page.evaluate(() => document.cookie);
        t.soft(cookie === "", `사이트 origin에서 document.cookie가 비어 있지 않음: ${cookie}`);
        // context.cookies(url)는 호스트 전용 쿠키도 하위 도메인에 맞춰 보여 주므로(Playwright 필터 특성) 실제 요청 헤더를 본다.
        const navHeaders = await r.request().allHeaders();
        t.soft(!/dd_sid=/.test(navHeaders.cookie ?? ""), `사이트 요청에 허브 세션 쿠키가 실림: ${navHeaders.cookie}`);

        // 사이트 페이지에서 허브 /studio를 credentials: include로 불러도 교사로 인증되지 않고, 응답도 읽을 수 없다.
        // 실제로 보낸 요청 헤더(쿠키)를 보고, 같은 방법이 허브 페이지에서는 쿠키를 잡아내는지 대조군으로 확인한다.
        const sentHeaders = async (pg, url, run) => {
          const reqP = pg.waitForRequest((r) => r.url() === url, { timeout: 10000 }).catch(() => null);
          const out = await run();
          const req = await reqP;
          const headers = req ? await req.allHeaders().catch(() => null) : null;
          return { out, headers };
        };
        const fromSite = await sentHeaders(page, u("/studio"), () =>
          page.evaluate(async (hub) => {
            try {
              const res = await fetch(`${hub}/studio`, { credentials: "include" });
              const text = await res.text();
              return { read: true, status: res.status, text: text.slice(0, 20000) };
            } catch (e) {
              return { read: false, error: String(e) };
            }
          }, BASE_URL),
        );
        const result = fromSite.out;
        t.soft(!result.read || !result.text.includes(TEACHER_A), `사이트 페이지가 허브 /studio를 교사로 읽음: ${JSON.stringify(result).slice(0, 200)}`);
        t.soft(fromSite.headers !== null, "사이트 페이지의 허브 요청을 관찰하지 못함(쿠키 전송 여부 확인 불가)");
        const sentCookie = fromSite.headers?.cookie ?? "";
        t.soft(!/dd_sid=/.test(sentCookie), `사이트 페이지의 허브 요청에 세션 쿠키가 실림: ${sentCookie}`);
        t.note(`사이트→허브 fetch: ${result.read ? `읽힘(${result.status})` : `차단(${result.error})`}, 전송 쿠키 ${sentCookie ? "있음" : "없음"}`);

        const hubPage = await ctxA.newPage();
        try {
          await hubPage.goto(u("/apps"));
          const control = await sentHeaders(hubPage, u("/studio"), () =>
            hubPage.evaluate(async () => {
              const res = await fetch("/studio", { credentials: "include" });
              return { status: res.status };
            }),
          );
          t.soft(/dd_sid=/.test(control.headers?.cookie ?? ""), `대조군(허브 페이지의 같은 요청)에서 세션 쿠키를 관찰하지 못함: ${JSON.stringify(control.headers)}`);
        } finally {
          await hubPage.close();
        }

        // 서버 액션처럼 쿠키가 필요한 허브 API(교사 전용 파일)도 사이트에서는 인증되지 않는다.
        const api = await page.evaluate(async (hub) => {
          try {
            const res = await fetch(`${hub}/api/cli/whoami`, { credentials: "include" });
            return { status: res.status };
          } catch (e) {
            return { error: String(e) };
          }
        }, BASE_URL);
        t.soft(api.error || api.status === 401, `사이트에서 허브 API 호출 결과: ${JSON.stringify(api)}`);
      } finally {
        await page.close();
      }
    });

    /* ---------------- 16) 클릭재킹 방지 헤더 ---------------- */
    await step("16) 클릭재킹 방지: 허브 화면 X-Frame-Options SAMEORIGIN · 로그인·기기 승인·OAuth DENY · 사이트 호스트는 허브만 허용 · Chrome iframe 차단", async (t) => {
      const anon = await ensureAnon();
      const ctxA = await ensureTeacherA();
      const xfo = (h) => String(h["x-frame-options"] ?? "").toUpperCase();
      const csp = (h) => String(h["content-security-policy"] ?? "");
      const hubPages = [
        [anon, "/"],
        [anon, "/apps"],
        [anon, "/connect"],
        [anon, "/skills"],
        [ctxA, "/studio"],
        [ctxA, "/studio/projects"],
        [ctxA, "/studio/sites"],
        [ctxA, "/studio/cli"],
      ];
      for (const [ctx, p] of hubPages) {
        const r = await ctx.request.get(u(p), { maxRedirects: 0 });
        const h = r.headers();
        t.soft(xfo(h) === "SAMEORIGIN" && /frame-ancestors 'self'/.test(csp(h)), `허브 ${p}(${r.status()}): X-Frame-Options=${h["x-frame-options"]} CSP=${h["content-security-policy"]} (SAMEORIGIN 기대)`);
      }
      const denyPages = [
        [anon, "/login"],
        [ctxA, "/device"],
        [ctxA, "/oauth/connections"],
        [anon, "/oauth/authorize"],
      ];
      for (const [ctx, p] of denyPages) {
        const r = await ctx.request.get(u(p), { maxRedirects: 0 });
        const h = r.headers();
        t.soft(xfo(h) === "DENY" && /frame-ancestors 'none'/.test(csp(h)), `승인 화면 ${p}(${r.status()}): X-Frame-Options=${h["x-frame-options"]} CSP=${h["content-security-policy"]} (DENY 기대)`);
      }

      // 교사 사이트 호스트는 허브가 iframe으로 넣어야 하므로 X-Frame-Options 없이 frame-ancestors로 허브만 허용한다.
      const site = await ensurePublishedSite();
      const sr = await hostRequest(site.liveUrl);
      t.soft(
        sr.status === 200 && !sr.headers["x-frame-options"] && csp(sr.headers).includes(`frame-ancestors`) && csp(sr.headers).includes(new URL(BASE_URL).host),
        `사이트 호스트 헤더: ${sr.status} X-Frame-Options=${sr.headers["x-frame-options"]} CSP=${sr.headers["content-security-policy"]}`,
      );

      // 실제 Chrome: 사이트 origin 페이지가 허브 /studio를 iframe으로 넣으면 막히고, 허브 페이지 안에서는 뜬다(대조군).
      // /device는 허브 자신 안에서도 막힌다.
      // 막힌 frame은 Playwright에서 주소가 비거나(chrome-error) 콘솔에 frame-ancestors/X-Frame-Options 위반이 찍힌다.
      const tryFrame = async (pageUrl, src) => {
        const pg = await ctxA.newPage();
        const violations = [];
        pg.on("console", (m) => {
          if (/frame-ancestors|X-Frame-Options/i.test(m.text())) violations.push(m.text().slice(0, 160));
        });
        try {
          await pg.goto(pageUrl);
          await pg.evaluate(
            (s) =>
              new Promise((res) => {
                const f = document.createElement("iframe");
                f.src = s;
                f.onload = () => res(null);
                document.body.appendChild(f);
                setTimeout(() => res(null), 6000);
              }),
            src,
          );
          await pg.waitForTimeout(300);
          const url = pg.mainFrame().childFrames().map((f) => f.url()).pop() ?? "";
          return { url, loaded: url.startsWith(BASE_URL), violations };
        } finally {
          await pg.close();
        }
      };
      const fromSite = await tryFrame(site.liveUrl, u("/studio"));
      t.soft(!fromSite.loaded && fromSite.violations.length > 0, `사이트 origin 페이지의 iframe에서 허브 /studio가 막히지 않음: url=${fromSite.url} 위반=${fromSite.violations.join(" | ")}`);
      t.note(`사이트 → 허브 /studio iframe: ${fromSite.violations[0] ?? fromSite.url}`);
      const same = await tryFrame(u("/apps"), u("/studio"));
      t.soft(same.loaded && same.violations.length === 0, `대조군: 허브 페이지 안 iframe에 허브 /studio가 뜨지 않음: url=${same.url} 위반=${same.violations.join(" | ")}`);
      const dev = await tryFrame(u("/apps"), u("/device"));
      t.soft(!dev.loaded && dev.violations.length > 0, `허브 페이지 안 iframe에서 /device가 막히지 않음(DENY 기대): url=${dev.url} 위반=${dev.violations.join(" | ")}`);
    });
  } finally {
    // 안전망: 이 테스트가 바꾸는 모델(deepseek, gpt)이 시작 상태와 다르면 되돌린다.
    if (initialModels && memo.admin) {
      try {
        const now = await modelsApi().then((r) => new Map(r.data.models.map((m) => [m.id, m.status])));
        for (const id of ["deepseek", "gpt"]) {
          const want = initialModels.get(id);
          if (!want || now.get(id) === want) continue;
          const ad = await (await ensureAdmin()).newPage();
          try {
            await setModelStatusAsAdmin(ad, id, want, `E2E 최종 복구 ${RUN}`);
            console.log(`    · 최종 복구: ${id} -> ${want}`);
          } finally {
            await ad.close();
          }
        }
      } catch (e) {
        console.log(`    ! 모델 상태 최종 복구 실패: ${e.message}`);
      }
    }
    await S.browser.close().catch(() => {});
    if (!process.env.E2E_KEEP_TMP) await fs.rm(S.tmp, { recursive: true, force: true }).catch(() => {});
    else console.log(`임시 폴더 유지: ${S.tmp}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(`요약: ${results.length - failed.length}/${results.length} 단계 통과`);
  if (jsErrors.length) {
    console.log(`브라우저 JS 오류 ${jsErrors.length}건:`);
    for (const e of [...new Set(jsErrors)].slice(0, 20)) console.log(`    ! ${e}`);
  }
  if (process.env.E2E_JSON) {
    await fs.writeFile(process.env.E2E_JSON, JSON.stringify({ run: RUN, results, jsErrors }, null, 2), "utf8");
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error("E2E 실행 오류:", err);
  process.exitCode = 2;
});
