#!/usr/bin/env node
// dandi: Dandi 교사용 CLI (F-53 브라우저 승인 로그인, F-54 에이전트 친화 CLI, F-58 stdio MCP, F-41 스킬 명령).
// Node.js 18 이상에서 외부 의존성 없이 동작한다. 순수 도우미는 ./lib.mjs, 허브 API·파일 입출력은 ./core.mjs,
// stdio MCP 서버는 ./mcp.mjs에 있다. 허브와는 HTTP로만 이야기한다.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ANSWERS_TEMPLATE,
  BUILD_DIRS,
  CLI_TAG,
  CLI_VERSION,
  DEFAULT_HUB,
  DEFAULT_SKILL_AGENTS,
  DEPLOY_SKILL,
  EXIT,
  LLMS_FILE,
  LOGIN_TOKEN_ARG_ERROR,
  MANIFEST_FILE,
  applyOverrides,
  builtinRunbook,
  configPath,
  defaultManifest,
  describeUser,
  displayPath,
  errorJson,
  extractLastHttpsUrl,
  formatBytes,
  formatJsonOutput,
  fromMsysPath,
  helpJson,
  helpText,
  humanErrorLines,
  isShellSafeArg,
  isValidSiteId,
  isValidSlug,
  llmsTxtSkeleton,
  loginPendingJson,
  manifestString,
  nextStep,
  npxPrefix,
  okJson,
  parseAgentList,
  parseArgs,
  parseTimeout,
  redactSecrets,
  SETUP_PROMPT,
  shellArg,
  skillAddArgs,
  stringFlag,
  tokenStdinUsage,
  validateCommand,
} from "./lib.mjs";
import * as core from "./core.mjs";
import { CliError } from "./core.mjs";
import { runMcpStdio } from "./mcp.mjs";

/**
 * @typedef {{ command: string, args: string[], flags: Record<string, string | boolean>, errors: string[] }} Parsed
 * @typedef {{ json: boolean, prefix: string, printJson: (obj: unknown) => void, out: (text: string) => void, err: (text: string) => void }} Ui
 */

/** @param {boolean} json @param {string} prefix @param {Record<string, string | undefined>} env @returns {Ui} */
function createUi(json, prefix, env) {
  return {
    json,
    prefix,
    // --json 출력은 UTF-8 그대로다. Windows PowerShell·cmd(MSYSTEM 없음)나 DANDI_JSON_ASCII=1이면 한글을 \uXXXX로 적는다.
    printJson: (obj) => process.stdout.write(`${redactSecrets(formatJsonOutput(obj, env))}\n`),
    out: (text) => process.stdout.write(`${redactSecrets(text)}\n`),
    err: (text) => process.stderr.write(`${redactSecrets(text)}\n`),
  };
}

/**
 * 성공 결과 출력: --json이면 JSON 한 개, 아니면 사람용 줄.
 * @param {Ui} ui
 * @param {Record<string, unknown>} data
 * @param {string[]} lines
 */
function emit(ui, data, lines) {
  if (ui.json) ui.printJson(okJson(data));
  else for (const line of lines) ui.out(line);
}

/** @param {Ui} ui */
function helpStep(ui) {
  return nextStep(ui.prefix, ui.json ? "help --json" : "help");
}

/** @param {Ui} ui @param {CliError} err */
function printError(ui, err) {
  // nextStep이 null이면 그대로 실행할 명령이 없다는 뜻이다(next_step을 내지 않는다).
  const next = err.nextStep === null ? undefined : err.nextStep ?? (err.nextStepTemplate ? undefined : helpStep(ui));
  if (ui.json) {
    ui.printJson(
      errorJson({ code: err.code, message: err.message, hint: err.hint, nextStep: next, nextStepTemplate: err.nextStepTemplate, extra: err.extra }),
    );
    return;
  }
  const problems = err.extra && Array.isArray(err.extra.problems) ? err.extra.problems.map(String) : [];
  const lines = humanErrorLines({ message: err.message, hint: problems.length ? undefined : err.hint, nextStep: next, nextStepTemplate: err.nextStepTemplate });
  if (problems.length) lines.splice(1, 0, ...problems.map((p) => `  - ${p}`));
  for (const line of lines) ui.err(line);
}

/** 설정 파일이 깨져 있어도 허브 주소는 정한다(안내 명령·로그인 시작용). @param {core.Ctx} ctx */
async function hubIgnoringConfigErrors(ctx) {
  let saved = null;
  try {
    saved = await core.loadConfig(ctx);
  } catch {
    saved = null;
  }
  return core.resolveHub(ctx, saved);
}

/** @param {core.Ctx} ctx @param {Record<string, string | boolean>} flags */
async function resolveProjectDir(ctx, flags) {
  const flag = stringFlag(flags, "dir");
  const dir = path.resolve(ctx.cwd, flag ? fromMsysPath(flag) : ".");
  let stat = null;
  try {
    stat = await fs.stat(dir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    throw new CliError("folder_not_found", `폴더를 찾을 수 없습니다: ${dir}`, { exitCode: EXIT.USAGE, nextStep: null });
  }
  return dir;
}

/**
 * 다른 폴더에서 실행할 명령에 붙일 --dir 부분. 현재 폴더면 "", 안전하게 적을 수 없으면 null.
 * @param {core.Ctx} ctx
 * @param {string} dir
 */
function dirOption(ctx, dir) {
  if (core.samePath(dir, ctx.cwd)) return "";
  const arg = shellArg(displayPath(dir, ctx.cwd));
  return arg ? `--dir ${arg} ` : null;
}

/* ---------- 브라우저 열기 ---------- */

/** @param {string} url @param {Record<string, string | undefined>} env */
function openBrowser(url, env) {
  if (env.DANDI_NO_BROWSER || env.BROWSER === "none") return false;
  if (!/^https?:\/\/[^\s"'<>^&|%]+$/.test(url)) return false;
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/* ---------- login / logout / whoami ---------- */

/**
 * 저장된(또는 DANDI_TOKEN) 토큰이 이 허브에서 아직 유효하면 그 계정. 아니면 null.
 * @param {core.Ctx} ctx
 * @param {string} hub
 */
async function currentLogin(ctx, hub) {
  let s;
  try {
    s = await core.trySession(ctx);
  } catch {
    return null;
  }
  if (!s.token || s.hub !== hub) return null;
  try {
    return await core.whoami(ctx, { hub, token: s.token });
  } catch (err) {
    if (err instanceof CliError && err.exitCode === EXIT.LOGIN_REQUIRED) return null;
    throw err;
  }
}

/**
 * @param {core.Ctx} ctx
 * @param {Ui} ui
 * @param {Awaited<ReturnType<typeof core.waitForApproval>>} r
 * @param {core.Pending} pending
 */
function reportLogin(ctx, ui, r, pending) {
  const prefix = core.prefixFor(ctx, pending.hub);
  if (r.status === "logged_in") {
    emit(ui, { status: "logged_in", done: true, hub: r.hub, user: r.user }, [
      `로그인했습니다: ${describeUser(r.user)}`,
      `허브: ${r.hub}`,
      `설정 파일: ${configPath(ctx.env)}`,
    ]);
    return EXIT.OK;
  }
  if (r.status === "pending") {
    if (ui.json) {
      ui.printJson(loginPendingJson({ ...pending, expires_in: core.remainingSeconds(pending) }, prefix));
    } else {
      ui.out("아직 승인되지 않았습니다. 브라우저에서 아래 주소를 열고 코드가 같으면 [승인]을 누르십시오.");
      ui.out(pending.verification_uri_complete);
      ui.out(`코드: ${pending.user_code}`);
      ui.out(`다음 실행: ${nextStep(prefix, "login --wait")}`);
    }
    return EXIT.PENDING;
  }
  const again = nextStep(prefix, ctx.agent || ui.json ? "login --json" : "login");
  if (r.status === "denied") {
    // 교사가 [거부]를 눌렀다. 모르는 요청이었을 수 있으므로 바로 다시 시작하지 않는다(next_step 없음).
    throw new CliError("access_denied", "브라우저에서 로그인을 거부했습니다.", {
      hint: `직접 요청한 로그인이 아니었다면 아무것도 하지 않아도 됩니다. 직접 요청한 것이 맞다면 다시 시작하십시오: ${again}`,
      nextStep: null,
      extra: {
        agent_instructions: `The teacher pressed [거부] (deny) in the browser. Do not start a new login on your own. ASK the teacher whether they want to log in to Dandi now. Only if they say yes, run: ${again}`,
      },
    });
  }
  throw new CliError("expired_token", "승인 코드가 만료되었거나 이미 사용되었습니다.", {
    hint: "로그인을 처음부터 다시 하십시오. 코드는 10분 동안만 쓸 수 있습니다.",
    nextStep: again,
  });
}

/** @param {number} limit */
async function readStdin(limit) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > limit) throw new CliError("usage", "표준입력이 너무 깁니다.", { exitCode: EXIT.USAGE });
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** @param {core.Ctx} ctx @param {Ui} ui */
async function loginWithStdin(ctx, ui) {
  const hub = await hubIgnoringConfigErrors(ctx);
  const prefix = core.prefixFor(ctx, hub);
  ui.prefix = prefix;
  const usage = tokenStdinUsage(prefix).join(" / ");
  if (process.stdin.isTTY) ui.err("토큰을 붙여 넣고 Enter를 누른 뒤 Ctrl+D(Windows는 Ctrl+Z, Enter)를 누르십시오.");
  const text = await readStdin(64 * 1024);
  const token = text.replace(/^﻿/, "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
  if (!token) {
    throw new CliError("usage", "표준입력에서 토큰을 받지 못했습니다.", { hint: `사용법: ${usage}`, nextStep: nextStep(prefix, "login"), exitCode: EXIT.USAGE });
  }
  if (!token.startsWith("dd_cli_")) {
    throw new CliError("usage", "CLI 토큰은 dd_cli_로 시작합니다.", {
      hint: `허브의 /studio/cli에서 발급한 토큰을 표준입력으로 넘기십시오. 사용법: ${usage}`,
      nextStep: nextStep(prefix, "login"),
      exitCode: EXIT.USAGE,
    });
  }
  const user = await core.whoami(ctx, { hub, token });
  const file = await core.saveConfig(ctx, { hub, token, user });
  await core.deletePending(ctx);
  emit(ui, { status: "logged_in", done: true, hub, user }, [`로그인했습니다: ${describeUser(user)}`, `허브: ${hub}`, `설정 파일: ${file}`]);
  return EXIT.OK;
}

/** @param {core.Ctx} ctx @param {Parsed} parsed @param {Ui} ui */
async function cmdLogin(ctx, parsed, ui) {
  const { flags } = parsed;
  if (flags["token-stdin"]) return loginWithStdin(ctx, ui);
  // 에이전트·비대화형 환경에서는 항상 JSON 한 개를 출력한다(계약 3-2).
  if (ctx.agent) ui.json = true;
  const hub = await hubIgnoringConfigErrors(ctx);
  const prefix = core.prefixFor(ctx, hub);
  ui.prefix = prefix;

  if (flags.wait) {
    const pending = await core.loadPending(ctx);
    const explicitHub = Boolean(ctx.flagHub || ctx.env.DANDI_HUB);
    if (!pending || (explicitHub && pending.hub !== hub)) {
      throw new CliError("no_pending_login", "기다릴 로그인 요청이 없습니다.", {
        hint: "로그인을 먼저 시작하십시오.",
        nextStep: nextStep(prefix, ctx.agent || ui.json ? "login --json" : "login"),
      });
    }
    const timeout = parseTimeout(flags.timeout) ?? 90;
    if (!ui.json) ui.err(`승인을 기다리는 중입니다(최대 ${timeout}초).`);
    const r = await core.waitForApproval(ctx, pending, { timeoutMs: timeout * 1000 });
    return reportLogin(ctx, ui, r, pending);
  }

  // 이미 로그인되어 있으면 새 승인 요청을 만들지 않는다(--force면 새로 로그인).
  if (!flags.force) {
    const user = await currentLogin(ctx, hub);
    if (user) {
      emit(ui, { status: "logged_in", done: true, already: true, hub, user }, [
        `이미 로그인되어 있습니다: ${describeUser(user)}`,
        `허브: ${hub}`,
        `다른 계정으로 로그인하려면: ${nextStep(prefix, "login --force")}`,
      ]);
      return EXIT.OK;
    }
  }

  const start = await core.deviceStart(ctx, hub);
  if (ui.json) {
    ui.printJson(loginPendingJson(start, prefix));
    return EXIT.PENDING;
  }
  const opened = openBrowser(start.verification_uri_complete, ctx.env);
  ui.out(opened ? "브라우저를 열었습니다. 화면의 코드가 아래 코드와 같으면 [승인]을 누르십시오." : "브라우저에서 아래 주소를 열고, 화면의 코드가 아래 코드와 같으면 [승인]을 누르십시오.");
  ui.out(start.verification_uri_complete);
  ui.out(`코드: ${start.user_code}`);
  ui.err(`승인을 기다리는 중입니다(최대 ${Math.ceil(start.expires_in / 60)}분). 그만두려면 Ctrl+C를 누르십시오.`);
  const r = await core.waitForApproval(ctx, start, { timeoutMs: Math.min(start.expires_in, 600) * 1000 + 5_000 });
  return reportLogin(ctx, ui, r, start);
}

/** @param {core.Ctx} ctx @param {Parsed} _parsed @param {Ui} ui */
async function cmdLogout(ctx, _parsed, ui) {
  const removed = await core.deleteConfig(ctx);
  if (!removed) {
    throw new CliError("not_logged_in", "저장된 로그인 정보가 없습니다.", {
      hint: "이미 로그아웃된 상태입니다.",
      nextStep: core.loginNextStep(ctx, await hubIgnoringConfigErrors(ctx)),
    });
  }
  emit(ui, { status: "logged_out" }, [
    "로그아웃했습니다. 이 컴퓨터에 저장된 로그인 정보를 지웠습니다.",
    "토큰 자체를 무효로 하려면 허브의 /studio/cli(로그인된 기기)에서 폐기하십시오.",
  ]);
  return EXIT.OK;
}

/**
 * 허브의 최신 CLI와 다르면 알려 준다(사람용은 stderr, JSON은 cli_update 필드).
 * @param {core.Ctx} ctx
 * @param {Ui} ui
 * @param {string} hub
 * @returns {Promise<Record<string, unknown>>} JSON에 덧붙일 필드
 */
async function updateFields(ctx, ui, hub) {
  const update = await core.cliUpdateNotice(ctx, hub);
  if (!update) return {};
  if (!ui.json) ui.err(update.message);
  return {
    cli_update: { current: update.current, latest: update.latest, prefix: update.prefix },
    agent_instructions: core.CLI_UPDATE_INSTRUCTIONS,
  };
}

/** @param {core.Ctx} ctx @param {Parsed} _parsed @param {Ui} ui */
async function cmdWhoami(ctx, _parsed, ui) {
  const session = await core.requireSession(ctx);
  const user = await core.whoami(ctx, session);
  const extra = await updateFields(ctx, ui, session.hub);
  emit(ui, { status: "logged_in", hub: session.hub, user, ...extra }, [describeUser(user), `허브: ${session.hub}`]);
  return EXIT.OK;
}

/* ---------- init / deploy / publish ---------- */

/** @param {core.Ctx} ctx @param {Parsed} parsed @param {Ui} ui */
async function cmdInit(ctx, parsed, ui) {
  const dir = await resolveProjectDir(ctx, parsed.flags);
  let htmlTitle = null;
  for (const d of [".", ...BUILD_DIRS]) {
    htmlTitle = await core.htmlTitleOf(path.join(dir, d));
    if (htmlTitle) break;
  }
  const title = stringFlag(parsed.flags, "title") ?? htmlTitle ?? "";
  const files = [
    [MANIFEST_FILE, `${JSON.stringify(defaultManifest(title), null, 2)}\n`],
    [LLMS_FILE, llmsTxtSkeleton(title || path.basename(dir))],
  ];
  /** @type {string[]} */
  const created = [];
  /** @type {string[]} */
  const skipped = [];
  for (const [name, content] of files) {
    try {
      // "wx": 파일이 이미 있으면 실패한다. 기존 파일은 절대 덮어쓰지 않는다.
      await fs.writeFile(path.join(dir, name), content, { flag: "wx" });
      created.push(name);
    } catch (err) {
      if (core.errCode(err) !== "EEXIST") throw err;
      skipped.push(name);
    }
  }
  const dirPart = dirOption(ctx, dir) ?? "";
  emit(ui, { dir, created, skipped, next_step: nextStep(ui.prefix, `deploy ${dirPart}--json`) }, [
    ...created.map((n) => `만들었습니다: ${n}`),
    ...skipped.map((n) => `이미 있으므로 건너뜁니다: ${n}`),
    "",
    "다음 순서로 진행하십시오.",
    `  1) 사이트를 만든 뒤 ${nextStep(ui.prefix, `deploy ${dirPart}`.trim())} 로 허브에 비공개 미리보기를 만드십시오.`,
    `  2) ${MANIFEST_FILE}의 title, description, schoolLevels, category를 교사에게 확인해 채우십시오.`,
    "  3) privacyCheck(배포 전 개인정보 셀프점검 5항목)를 교사가 직접 답해 채우십시오. 비어 있으면 등록되지 않습니다.",
    `  4) ${nextStep(ui.prefix, `publish ${dirPart}`.trim())} 로 허브에 등록하십시오. 다른 곳에 배포했다면 --url <배포 URL>을 붙이십시오.`,
  ]);
  return EXIT.OK;
}

/** @param {core.Ctx} ctx @param {Parsed} parsed @param {Ui} ui */
async function cmdDeploy(ctx, parsed, ui) {
  const { flags } = parsed;
  if (flags.vercel) return cmdDeployVercel(ctx, parsed, ui);
  const slug = stringFlag(flags, "slug");
  const siteId = stringFlag(flags, "site");
  if (slug && !isValidSlug(slug)) {
    throw new CliError("usage", `사이트 주소 이름 형식이 올바르지 않습니다: ${slug}`, {
      hint: "소문자·숫자·하이픈 3~30자로 적고, 양 끝은 영문자·숫자, 하이픈 두 개(--)는 쓰지 마십시오.",
      exitCode: EXIT.USAGE,
    });
  }
  if (siteId && !isValidSiteId(siteId)) {
    throw new CliError("usage", `사이트 ID 형식이 올바르지 않습니다: ${siteId}`, { exitCode: EXIT.USAGE });
  }
  const projectDir = await resolveProjectDir(ctx, flags);
  const session = await core.requireSession(ctx);
  const prefix = core.prefixFor(ctx, session.hub);
  ui.prefix = prefix;
  const folderArg = parsed.args[0] !== undefined ? fromMsysPath(parsed.args[0]) : undefined;
  const r = await core.deployFolder(
    ctx,
    session,
    {
      folder: folderArg,
      projectDir,
      siteId,
      newSite: flags["new-site"] === true,
      // --project를 줄 때만 기존 사이트를 옮긴다(dandi.json의 projectId는 새 사이트를 만들 때의 기본값).
      projectId: stringFlag(flags, "project"),
      slug,
      title: stringFlag(flags, "title"),
      manifestMode: "create",
      via: "cli",
      allowSource: flags["allow-source"] === true,
    },
    {
      onInfo: (t) => {
        if (!ui.json) ui.err(t);
      },
      onProgress: (done, total) => {
        if (!ui.json && (done === total || done % 20 === 0)) ui.err(`파일 보내는 중: ${done}/${total}`);
      },
    },
  );
  const dirPart = dirOption(ctx, r.manifestDir);
  const publishJson = dirPart === null ? null : nextStep(prefix, `publish ${dirPart}--json`);
  const publishHuman = dirPart === null ? null : nextStep(prefix, `publish ${dirPart}`.trim());
  const d = core.describeDeploy(r, session.hub, { publishHow: "run next_step" });
  const lines = [...d.lines];
  lines.push(`사이트 ID: ${r.siteId}${r.manifestFile ? ` (${r.manifestFile}에 기록했습니다)` : ""}`);
  lines.push(`새로 보낸 파일 ${r.uploaded}개, 허브에 이미 있던 파일 ${r.reused}개 (합계 ${formatBytes(r.totalBytes)})`);
  if (r.published && r.answers.complete) {
    lines.push(`다음 단계: 저장된 답이 그대로인지 교사에게 확인한 뒤 등록하면 공개 버전이 바뀝니다.`);
  } else {
    lines.push(`다음 단계: ${MANIFEST_FILE}의 제목·설명·학교급·분류와 셀프점검 5항목을 교사가 직접 확인해 채운 뒤 허브에 등록하십시오.`);
  }
  lines.push(publishHuman ? `다음 실행: ${publishHuman}` : `다음 실행: ${r.manifestDir} 폴더에서 ${nextStep(prefix, "publish")}`);
  emit(
    ui,
    {
      status: "preview",
      message: d.message,
      siteId: r.siteId,
      deployId: r.deployId,
      slug: r.slug,
      previewUrl: r.previewUrl,
      preview_url: r.previewUrl,
      ...(r.projectId ? { projectId: r.projectId } : {}),
      warnings: d.warnings,
      notes: d.notes,
      uploaded: r.uploaded,
      reused: r.reused,
      skipped: r.skipped,
      folder: r.folder,
      manifest: r.manifestFile,
      outputDir: r.outputDir,
      published: r.published,
      ...(r.answers.complete ? { saved_answers: r.answers.saved } : { missing: r.answers.missing }),
      ...(d.privacy_questions ? { privacy_questions: d.privacy_questions } : {}),
      ...(r.htmlTitle ? { suggested_title: r.htmlTitle } : {}),
      ...(publishJson ? { next_step: publishJson } : { next_step_template: nextStep(prefix, 'publish --dir "<폴더>" --json') }),
      agent_instructions: d.agent_instructions,
    },
    lines,
  );
  return EXIT.OK;
}

/** @param {core.Ctx} ctx @param {Parsed} parsed @param {Ui} ui */
async function cmdPublish(ctx, parsed, ui) {
  const { flags } = parsed;
  const projectDir = await resolveProjectDir(ctx, flags);
  const hub = await hubIgnoringConfigErrors(ctx);
  const prefix = core.prefixFor(ctx, hub);
  ui.prefix = prefix;
  const dirPart = dirOption(ctx, projectDir);
  /** 이 폴더(--dir)에서 실행할 명령. 폴더를 안전하게 적을 수 없으면 null. @param {string} name @param {string} rest */
  const cmd = (name, rest) => (dirPart === null ? null : nextStep(prefix, `${name} ${dirPart}${rest}`.trim()));
  const retry = cmd("publish", "--json") ?? undefined;
  const { file: manifestFile, manifest } = await core.readManifest(projectDir);
  if (!manifest) {
    throw new CliError("manifest_missing", `${MANIFEST_FILE} 파일이 없습니다: ${projectDir}`, {
      hint: "deploy로 사이트를 올린 폴더(dandi.json이 있는 폴더)에서 실행하거나 --dir로 그 폴더를 적으십시오. 처음이면 deploy를 먼저 실행하십시오(다른 곳에 배포한 주소만 등록하려면 init 뒤 publish --url).",
      nextStep: cmd("deploy", "--json"),
    });
  }
  const urlFlag = stringFlag(flags, "url");
  const siteId = manifestString(manifest, "siteId");
  const merged = applyOverrides(manifest, { url: urlFlag, title: stringFlag(flags, "title") });

  if (siteId) {
    if (urlFlag) {
      throw new CliError("usage", "허브에 올린 사이트(siteId)가 연결된 폴더에서는 --url을 쓸 수 없습니다.", {
        hint: `외부 주소를 따로 등록하려면 ${MANIFEST_FILE}의 siteId를 비운 뒤 실행하십시오.`,
        nextStep: cmd("publish", ""),
        exitCode: EXIT.USAGE,
      });
    }
    const payload = core.checkManifest(merged, prefix, { requireUrl: false, retry });
    const session = await core.requireSession(ctx);
    let r;
    try {
      r = await core.publishSite(ctx, session, siteId, payload, manifestString(manifest, "lastDeployId"), {
        retry,
        deploy: cmd("deploy", "--json"),
      });
    } catch (err) {
      if (err instanceof CliError && err.code === "site_not_found") {
        // dandi.json은 비우지 않는다. 교사가 계정을 확인한 뒤에만 새 사이트로 올린다.
        throw await core.explainSiteNotFound(ctx, session, err, {
          siteId,
          fromManifest: true,
          via: "cli",
          newSiteStep: cmd("deploy", "--new-site --json") ?? nextStep(prefix, 'deploy --dir "<폴더>" --new-site --json'),
        });
      }
      throw err;
    }
    // 허브가 준 message를 그대로 쓴다(승인 유지·이전 버전 유지 같은 설명이 들어 있다).
    const p = core.describePublish(r);
    const lines = [`허브에 등록했습니다: ${payload.title}`, `앱 주소: ${r.appUrl}`];
    if (r.liveUrl) lines.push(`${p.keepsLive ? "공개 주소(승인 전까지 이전 버전)" : "공개 주소"}: ${r.liveUrl}`);
    if (p.keepsLive && typeof r.previewUrl === "string") lines.push(`새 버전 미리보기: ${r.previewUrl}`);
    lines.push(p.message);
    emit(
      ui,
      {
        status: "published",
        title: payload.title,
        siteId,
        ...r,
        message: p.message,
        agent_instructions: p.agent_instructions,
      },
      lines,
    );
    return EXIT.OK;
  }

  if (!manifestString(merged, "url")) {
    throw new CliError("nothing_to_publish", "등록할 사이트나 주소가 없습니다.", {
      hint: `먼저 deploy로 허브에 올리거나, 다른 곳에 배포한 주소를 --url로 넘기십시오.`,
      nextStep: cmd("deploy", "--json"),
    });
  }
  const payload = core.checkManifest(merged, prefix, { requireUrl: true, retry });
  const session = await core.requireSession(ctx);
  const r = await core.publishExternalApp(ctx, session, payload, { projectId: manifestString(manifest, "projectId"), retry });
  if (typeof r.projectId === "string" && r.projectId && r.projectId !== manifestString(manifest, "projectId")) {
    await core.writeManifestPatch(manifestFile, {}, { projectId: r.projectId });
  }
  const lines = [`허브에 등록했습니다: ${r.title}`, `앱 주소: ${r.appUrl}`];
  if (r.approvalStatus === "pending") {
    lines.push(
      '⑤(학교 내부 승인 필요)에 "예"라고 답해 승인 대기 상태로 등록했습니다. 승인을 받은 뒤 허브의 /studio/apps에서 "내부 승인 완료 표시"를 누르면 공개됩니다.',
    );
  }
  lines.push("같은 주소를 다시 publish하면 새 항목으로 등록됩니다. 이전 항목은 허브의 /studio/apps에서 삭제하십시오.");
  emit(ui, { status: "published", ...r }, lines);
  return EXIT.OK;
}

/* ---------- deploy --vercel (v0.1 방식 유지) ---------- */

/**
 * npx vercel deploy --prod --yes를 실행한다. stderr는 그대로 보여 주고 stdout은 모아서 주소를 찾는다.
 * @param {string} dir
 * @param {boolean} json
 * @returns {Promise<{ code: number | null, stdout: string, error: Error | null }>}
 */
function runVercel(dir, json) {
  return new Promise((resolve) => {
    /** @type {import("node:child_process").SpawnOptions} */
    const options = { cwd: dir, stdio: ["inherit", "pipe", "inherit"] };
    // Windows에서는 npx가 .cmd 파일이므로 셸을 거쳐야 한다. 명령 문자열은 고정값이다.
    const child =
      process.platform === "win32"
        ? spawn("npx vercel deploy --prod --yes", { ...options, shell: true })
        : spawn("npx", ["vercel", "deploy", "--prod", "--yes"], options);
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      (json ? process.stderr : process.stdout).write(chunk);
    });
    child.on("error", (error) => resolve({ code: null, stdout, error }));
    child.on("close", (code) => resolve({ code, stdout, error: null }));
  });
}

/** @param {core.Ctx} ctx @param {Parsed} parsed @param {Ui} ui */
async function cmdDeployVercel(ctx, parsed, ui) {
  const dir = parsed.args[0] ? path.resolve(ctx.cwd, fromMsysPath(parsed.args[0])) : await resolveProjectDir(ctx, parsed.flags);
  const hub = await hubIgnoringConfigErrors(ctx);
  const prefix = core.prefixFor(ctx, hub);
  ui.prefix = prefix;
  const { manifest } = await core.readManifest(dir);
  if (!manifest) {
    throw new CliError("manifest_missing", `${MANIFEST_FILE} 파일이 없습니다: ${dir}`, { nextStep: nextStep(prefix, "init") });
  }
  const withTitle = applyOverrides(manifest, { title: stringFlag(parsed.flags, "title") });
  // 배포 전에 셀프점검과 로그인을 먼저 확인한다. 배포만 되고 등록이 실패하는 일을 줄이기 위해서다.
  core.checkManifest(withTitle, prefix, { requireUrl: false });
  const session = await core.requireSession(ctx);
  await core.whoami(ctx, session);
  if (!ui.json) ui.err(`Vercel에 배포합니다: npx vercel deploy --prod --yes (${dir})`);
  const run = await runVercel(dir, ui.json);
  const guidance = `Vercel 로그인(npx vercel login)과 이 폴더의 직접 배포(npx vercel deploy --prod)를 확인하십시오. 허브 호스팅을 쓰려면 --vercel 없이 deploy를 실행하십시오.`;
  if (run.error || run.code !== 0) {
    const reason = run.error ? `실행 오류: ${run.error.message}` : `종료 코드 ${run.code}`;
    throw new CliError("vercel_failed", `Vercel 배포에 실패했습니다(${reason}).`, { hint: guidance, nextStep: nextStep(prefix, "deploy --json") });
  }
  const url = extractLastHttpsUrl(run.stdout);
  if (!url) throw new CliError("vercel_failed", "Vercel 출력에서 배포 주소를 찾지 못했습니다.", { hint: guidance });
  const payload = core.checkManifest(applyOverrides(withTitle, { url }), prefix, { requireUrl: true });
  const r = await core.publishExternalApp(ctx, session, payload, { projectId: manifestString(manifest, "projectId") });
  emit(ui, { status: "published", deployUrl: url, ...r }, [`배포 주소: ${url}`, `허브에 등록했습니다: ${r.title}`, `앱 주소: ${r.appUrl}`]);
  return EXIT.OK;
}

/* ---------- guide / mcp ---------- */

/** @param {core.Ctx} ctx @param {Parsed} _parsed @param {Ui} ui */
async function cmdGuide(ctx, _parsed, ui) {
  const hub = await hubIgnoringConfigErrors(ctx);
  const prefix = core.prefixFor(ctx, hub);
  const [text, extra] = await Promise.all([core.fetchGuide(hub), updateFields(ctx, ui, hub)]);
  if (text) {
    // 허브 런북 원문을 그대로 출력한다(WebFetch 요약·localhost 차단의 탈출구).
    if (ui.json) ui.printJson(okJson({ source: "hub", hub, text, ...extra }));
    else process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return EXIT.OK;
  }
  const fallback = builtinRunbook(hub, prefix);
  if (ui.json) {
    ui.printJson(okJson({ source: "builtin", hub, text: fallback, ...extra }));
  } else {
    ui.err(`허브(${hub})의 /llms.txt를 받지 못해 CLI에 들어 있는 요약 런북을 보여 줍니다.`);
    process.stdout.write(fallback);
  }
  return EXIT.OK;
}

async function cmdMcp() {
  if (process.stdin.isTTY) {
    process.stderr.write("dandi stdio MCP 서버입니다. AI 도구(Claude 데스크톱·Cursor 등)의 MCP 설정에 등록해 사용하십시오. 끝내려면 Ctrl+C를 누르십시오.\n");
  }
  await runMcpStdio({ env: process.env, cwd: process.cwd() });
  // 백그라운드 로그인 확인이 남아 있어도 입력이 끝나면 종료한다.
  process.exit(0);
}

/* ---------- skill ---------- */

/**
 * @param {string[]} args
 * @param {boolean} json
 * @returns {Promise<number>}
 */
function runNpx(args, json) {
  return new Promise((resolve) => {
    const env = { ...process.env, DISABLE_TELEMETRY: "1" };
    /** @type {import("node:child_process").StdioOptions} */
    const stdio = ["inherit", json ? process.stderr : "inherit", "inherit"];
    // Windows의 npx는 .cmd라 셸이 필요하다. 인자는 isShellSafeArg로 모두 확인했다.
    const child =
      process.platform === "win32"
        ? spawn(`npx ${args.join(" ")}`, { stdio, env, shell: true })
        : spawn("npx", args, { stdio, env });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** @param {core.Ctx} ctx @param {Parsed} parsed @param {Ui} ui */
async function cmdSkill(ctx, parsed, ui) {
  const [sub, ...rest] = parsed.args;
  if (sub === "add") {
    const name = rest[0];
    const agents = parseAgentList(stringFlag(parsed.flags, "agent"));
    const hub = await hubIgnoringConfigErrors(ctx);
    const prefix = core.prefixFor(ctx, hub);
    ui.prefix = prefix;
    if (!agents) {
      throw new CliError("usage", "--agent 형식이 올바르지 않습니다.", { hint: `예: --agent ${DEFAULT_SKILL_AGENTS.join(",")}`, exitCode: EXIT.USAGE });
    }
    const args = skillAddArgs(hub, name, agents, { global: parsed.flags.global === true, yes: ctx.agent });
    if (!args.every(isShellSafeArg)) {
      throw new CliError("usage", "허브 주소나 스킬 이름에 명령으로 쓸 수 없는 문자가 있습니다.", { exitCode: EXIT.USAGE });
    }
    const display = `npx ${args.join(" ")}`;
    if (!ui.json) ui.err(`실행: ${display}`);
    const code = await runNpx(args, ui.json);
    if (code !== 0) {
      throw new CliError("skill_install_failed", `스킬 설치 명령이 실패했습니다(종료 코드 ${code}).`, {
        hint: "위 출력의 오류를 확인하십시오. 스킬 이름은 skill list로 찾을 수 있습니다.",
        nextStep: nextStep(prefix, "skill list"),
        exitCode: EXIT.ERROR,
      });
    }
    emit(ui, { status: "installed", name, agents, global: parsed.flags.global === true, command: display }, [`설치했습니다: ${name} (${agents.join(", ")})`]);
    return EXIT.OK;
  }

  if (sub === "publish") {
    const folder = path.resolve(ctx.cwd, fromMsysPath(rest[0] ?? "."));
    const session = await core.requireSession(ctx);
    ui.prefix = core.prefixFor(ctx, session.hub);
    const r = await core.publishSkillFolder(ctx, session, folder, { title: stringFlag(parsed.flags, "title") });
    const statusText =
      r.status === "approved"
        ? "검토를 통과해 바로 공개되었습니다."
        : r.status === "pending_review"
          ? "스크립트나 훅이 있어 관리자 검토 뒤 공개됩니다."
          : `상태: ${r.status}`;
    const lines = [`스킬을 게시했습니다: ${r.name}${r.version ? ` v${r.version}` : ""}`, statusText, `주소: ${r.url}`];
    if (r.findings.length) {
      lines.push("검토 결과:");
      for (const f of r.findings) lines.push(`  - ${f}`);
    }
    emit(ui, { name: r.name, version: r.version, status: r.status, findings: r.findings, url: r.url, files: r.files }, lines);
    return EXIT.OK;
  }

  // list
  const query = rest.join(" ").trim();
  let session;
  try {
    session = await core.trySession(ctx);
  } catch {
    session = { hub: await hubIgnoringConfigErrors(ctx), token: null };
  }
  ui.prefix = core.prefixFor(ctx, session.hub);
  const skills = await core.listSkills(ctx, session, query);
  /** @type {string[]} */
  const lines = skills.length ? [] : [query ? `"${query}"에 맞는 스킬이 없습니다.` : "공개된 스킬이 없습니다."];
  for (const k of skills) {
    lines.push(`${String(k.name)}  ${String(k.title ?? "")}${typeof k.installs === "number" ? ` (설치 ${k.installs}회)` : ""}`);
    if (k.description) lines.push(`  ${String(k.description)}`);
    lines.push(`  설치: ${nextStep(ui.prefix, `skill add ${String(k.name)}`)}`);
  }
  emit(ui, { hub: session.hub, query, skills }, lines);
  return EXIT.OK;
}

/* ---------- setup ---------- */

/**
 * 배포 스킬(dandi-deploy)을 지금 폴더의 AI 코딩 도구에 설치하고, AI에게 보낼 문장을 보여 준다.
 * npx -y skills@latest add <hub>/.well-known/agent-skills/dandi-deploy --skill dandi-deploy -a <도구>... --copy -y
 * @param {core.Ctx} ctx @param {Parsed} parsed @param {Ui} ui
 */
async function cmdSetup(ctx, parsed, ui) {
  const agents = parseAgentList(stringFlag(parsed.flags, "agent"));
  const hub = await hubIgnoringConfigErrors(ctx);
  const prefix = core.prefixFor(ctx, hub);
  ui.prefix = prefix;
  if (!agents) {
    throw new CliError("usage", "--agent 형식이 올바르지 않습니다.", { hint: `예: --agent ${DEFAULT_SKILL_AGENTS.join(",")}`, exitCode: EXIT.USAGE });
  }
  const global = parsed.flags.global === true;
  // 설치를 묻는 확인 화면이 없어야 에이전트·스크립트에서도 멈추지 않는다.
  const args = skillAddArgs(hub, DEPLOY_SKILL, agents, { global, yes: true });
  if (!args.every(isShellSafeArg)) {
    throw new CliError("usage", "허브 주소에 명령으로 쓸 수 없는 문자가 있습니다.", { exitCode: EXIT.USAGE });
  }
  const display = `npx ${args.join(" ")}`;
  if (!ui.json) ui.err(`실행: ${display}`);
  const code = await runNpx(args, ui.json);
  if (code !== 0) {
    throw new CliError("skill_install_failed", `스킬 설치 명령이 실패했습니다(종료 코드 ${code}).`, {
      hint: "위 출력의 오류를 확인하십시오. Node.js 18 이상과 인터넷 연결이 필요합니다.",
      nextStep: nextStep(prefix, ui.json ? "setup --json" : "setup"),
      exitCode: EXIT.ERROR,
    });
  }
  const promptWithAnswers = `${SETUP_PROMPT} ${ANSWERS_TEMPLATE}`;
  // Grok은 신뢰한 폴더에서만 프로젝트 스킬을 읽는다(grok 1.0.30, 사용자 폴더 설치는 해당 없음).
  const grokNote =
    agents.includes("grok") && !global
      ? "Grok은 신뢰한 폴더에서만 이 폴더의 스킬을 읽습니다. 처음이면 Grok에서 /hooks-trust를 실행하고, grok -p로 한 번에 실행할 때는 --trust를 붙이십시오."
      : null;
  emit(
    ui,
    {
      status: "installed",
      skill: DEPLOY_SKILL,
      agents,
      global,
      folder: global ? null : ctx.cwd,
      command: display,
      prompt: SETUP_PROMPT,
      prompt_with_answers: promptWithAnswers,
      ...(grokNote ? { notes: [grokNote] } : {}),
    },
    [
      `${DEPLOY_SKILL} 스킬을 설치했습니다: ${agents.join(", ")}`,
      global ? "설치 위치: 사용자 폴더(모든 프로젝트)" : `설치 위치: ${ctx.cwd}`,
      "",
      "이 폴더에서 AI 코딩 도구를 열고 아래 문장을 보내십시오. 로그인이 필요하면 AI가 승인 링크를 보여 줍니다.",
      SETUP_PROMPT,
      "",
      "제목·설명·학교급·분류와 셀프점검 ①~⑤ 답을 함께 적으면 AI가 다시 묻지 않고 바로 등록합니다. 괄호를 채워 보내십시오.",
      promptWithAnswers,
      ...(grokNote ? ["", grokNote] : []),
    ],
  );
  return EXIT.OK;
}

/* ---------- main ---------- */

/** @type {Record<string, (ctx: core.Ctx, parsed: Parsed, ui: Ui) => Promise<number>>} */
const COMMANDS = {
  login: cmdLogin,
  logout: cmdLogout,
  whoami: cmdWhoami,
  init: cmdInit,
  deploy: cmdDeploy,
  publish: cmdPublish,
  guide: cmdGuide,
  mcp: cmdMcp,
  skill: cmdSkill,
  setup: cmdSetup,
};

/** @param {string[]} argv @returns {Promise<number>} */
async function main(argv) {
  const parsed = parseArgs(argv);
  const ctx = core.createCtx({ flagHub: stringFlag(parsed.flags, "hub") });
  const ui = createUi(parsed.flags.json === true, npxPrefix(DEFAULT_HUB, ctx.env), ctx.env);
  try {
    if (typeof fetch !== "function") {
      throw new CliError("unsupported_node", "Node.js 18 이상이 필요합니다.", { hint: "https://nodejs.org 에서 LTS 버전을 설치하십시오." });
    }
    const hub = await hubIgnoringConfigErrors(ctx).catch(() => DEFAULT_HUB);
    ui.prefix = core.prefixFor(ctx, hub);
    if ((parsed.flags.version && !parsed.command) || parsed.command === "version") {
      if (ui.json) ui.printJson(okJson({ version: CLI_VERSION, tag: CLI_TAG }));
      else ui.out(CLI_TAG);
      return EXIT.OK;
    }
    if (!parsed.command || parsed.command === "help" || parsed.flags.help) {
      if (parsed.errors.length === 0) {
        if (ui.json) ui.printJson(helpJson(ui.prefix, hub));
        else process.stdout.write(helpText(ui.prefix, hub));
        return EXIT.OK;
      }
    }
    const problems = [...parsed.errors, ...(parsed.command ? validateCommand(parsed) : [])];
    if (problems.length) {
      const tokenArg = problems.includes(LOGIN_TOKEN_ARG_ERROR);
      const rest = problems.filter((p) => p !== problems[0]);
      throw new CliError("usage", problems[0], {
        hint: tokenArg ? `사용법(CI): ${tokenStdinUsage(ui.prefix).join(" / ")}` : rest.join(" ") || undefined,
        nextStep: parsed.command === "login" ? nextStep(ui.prefix, ctx.agent || ui.json ? "login --json" : "login") : helpStep(ui),
        exitCode: EXIT.USAGE,
      });
    }
    const run = COMMANDS[parsed.command];
    return await run(ctx, parsed, ui);
  } catch (err) {
    if (err instanceof CliError) {
      printError(ui, err);
      return err.exitCode;
    }
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    if (ui.json) ui.printJson(errorJson({ code: "internal_error", message: "예상하지 못한 오류가 발생했습니다.", hint: core.errText(err), nextStep: helpStep(ui) }));
    else ui.err(`예상하지 못한 오류가 발생했습니다.\n${detail}\n다음 실행: ${helpStep(ui)}`);
    return EXIT.ERROR;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
