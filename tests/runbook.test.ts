import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ANSWERS_TEMPLATE as CLI_ANSWERS_TEMPLATE,
  DEFAULT_SKILL_AGENTS,
  DEPLOY_SKILL as CLI_DEPLOY_SKILL,
  skillAddArgs,
} from "../cli/lib.mjs";
import { renderSkillTemplate, SEED_RETIRED_VERSIONS, SEED_SKILL_BLOBS, SEED_SKILLS, SKILL_TEMPLATE_BLOBS } from "../src/lib/seed-skills.ts";
import {
  ANSWERS_TEMPLATE,
  APPROVAL_RULE,
  buildFullReference,
  buildRunbook,
  CLI_VERSION_FALLBACK,
  cliPrefix,
  connectPrompt,
  connectPromptWithAnswers,
  DEPLOY_SKILL,
  FULL_REFERENCE_MAX_BYTES,
  isLocalHub,
  isLoopbackHub,
  isPublicHttpsHub,
  markdownResponse,
  mcpInstall,
  normalizeHubOrigin,
  POWERSHELL_UTF8,
  PRIVACY_QUESTIONS,
  readCliVersion,
  RUNBOOK_MAX_BYTES,
  secretGuidance,
  SHELL_NPX_RULE,
  SKILL_AGENTS,
  SKILLS_CLI,
  skillsAddCommand,
  windowsCli,
} from "../src/lib/runbook.ts";

// F-55·F-56 에이전트 문서. 크기 상한, 계약서 3장 명령 형식, 셀프점검 원문 일치, 연결 명령 형식을 확인한다.

const LOCAL = "http://localhost:3000";
const LAN = "http://192.168.0.5:3100";
const PUBLIC = "https://dandi.gne.go.kr";
// 긴 운영 주소(60자)에서도 상한을 지키는지 본다.
const LONG = "https://dandi-hubprototype.teachers.gyeongnam-edu.example.kr"; // 60자
const HUBS = [LOCAL, LAN, PUBLIC, LONG];
// scripts/pack-cli.mjs가 만드는 내용 해시 태그 형식
const TAG = "0.2.0-1a2b3c4d";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** 사람이 읽는 사용 문서(/docs)의 원문. 예전 /guide 화면은 /docs로 옮겨졌다(src/lib/docs/pages). */
function docsSource(): string {
  const dir = new URL("../src/lib/docs/pages/", import.meta.url);
  if (!existsSync(dir)) return readFileSync(new URL("../src/app/guide/page.tsx", import.meta.url), "utf8");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(new URL(f, dir), "utf8"))
    .join("\n");
}

test("크기 상한: /llms.txt 5KB 이하, /llms-full.txt 40KB 이하", () => {
  assert.equal(RUNBOOK_MAX_BYTES, 5120);
  assert.equal(FULL_REFERENCE_MAX_BYTES, 40960);
  assert.equal(LONG.length, 60);
  for (const hub of HUBS) {
    for (const version of ["0.2.0", TAG, "10.20.30-beta.1"]) {
      const runbook = buildRunbook(hub, version);
      const full = buildFullReference(hub, version);
      assert.ok(bytes(runbook) <= RUNBOOK_MAX_BYTES, `${hub} ${version} runbook ${bytes(runbook)}B`);
      assert.ok(bytes(full) <= FULL_REFERENCE_MAX_BYTES, `${hub} ${version} full ${bytes(full)}B`);
    }
  }
});

test("런북: 단계별 명령은 모두 npx -y <hub>/dandi-<태그>.tgz 형식", () => {
  const md = buildRunbook(PUBLIC, TAG);
  const cli = `npx -y ${PUBLIC}/dandi-${TAG}.tgz`;
  assert.equal(cliPrefix(PUBLIC, TAG), cli);
  for (const cmd of ["whoami --json", `login --hub ${PUBLIC} --json`, "deploy --json", "guide"]) {
    assert.ok(md.includes(`\`${cli} ${cmd}\``), cmd);
  }
  // login --wait·publish는 CLI가 셸에 맞게 적어 주는 next_step으로 실행한다(B1: PowerShell이면 npx.cmd).
  assert.ok(md.includes("run next_step (login --wait) now"));
  assert.ok(md.includes("Then run deploy's next_step (publish)."));
  assert.ok(md.includes(`CLI ${TAG}.`));
  // 다른 실행 방식(npm 레지스트리 이름, 태그 없는 별칭)을 섞지 않는다.
  assert.ok(!md.includes("dandi@latest"));
  assert.ok(!md.includes("dandi-0.2.0.tgz"));
  for (const m of md.matchAll(/`(npx -y [^`]+)`/g)) assert.ok(m[1].startsWith(cli), m[1]);
  // 셸별 npx(B1·R2): Git Bash·macOS·Linux는 npx, PowerShell·cmd는 npx.cmd. "Git Bash에서도 npx.cmd" 주장은 없다.
  assert.equal(
    SHELL_NPX_RULE,
    "Git Bash·macOS·Linux: npx / Windows PowerShell·cmd: npx.cmd — the CLI's next_step already uses the right one.",
  );
  assert.ok(md.includes(`${SHELL_NPX_RULE} Run next_step as given.`));
  assert.ok(!md.includes("Windows PowerShell: npx.cmd, not npx."));
  // PowerShell 인코딩(B5·R4)
  assert.equal(POWERSHELL_UTF8, "[Console]::OutputEncoding=[Text.Encoding]::UTF8");
  assert.ok(md.includes(`PowerShell: first run ${POWERSHELL_UTF8}; parse --json with ConvertFrom-Json.`));
});

test("런북: ASK·WAIT, Never 목록, 종료 코드, 셸 없을 때 안내", () => {
  const md = buildRunbook(PUBLIC, TAG);
  assert.match(md, /^# Dandi\n> /);
  assert.ok(md.includes("WAIT: don't end your turn; run next_step (login --wait) now"));
  assert.ok(md.includes("stop only at ASK"));
  assert.ok(!md.includes("pause only at ASK and WAIT"));
  assert.ok(md.includes("ASK in ONE message"));
  assert.ok(md.includes("Never ask the teacher to paste a token, password or API key into chat"));
  assert.ok(md.includes("Never answer the privacy questions yourself"));
  assert.ok(md.includes("Never put real student data"));
  assert.ok(md.includes("never obfuscate or split a key"));
  for (const code of ["exit 1", "2 usage", "4 login", "5 pending", "6 denied", "7 expired", "20 upload rejected", "21 self-check"]) {
    assert.ok(md.includes(code), code);
  }
  assert.ok(md.includes(`${PUBLIC}/connect`));
  assert.ok(md.includes(`${PUBLIC}/studio/sites`));
  assert.ok(md.includes("dandi_publish_site"));
  // 전체 레퍼런스와 사람용 문서(/docs)·AI용 문서(/docs/index.md) 안내
  assert.ok(md.includes("More: /llms-full.txt (reference) · /docs (people) · /docs/index.md (AI)"));
  // 교사에게 할 한국어 문장
  assert.ok(md.includes("[승인]을 누르십시오."));
  assert.ok(md.includes("비공개 미리보기입니다."));
  // 느낌표·토큰 원문 없음
  assert.ok(!md.includes("!"));
  assert.doesNotMatch(md, /dd_(cli|sk|mat|mrt|dev)_[A-Za-z0-9_-]{8,}/);
});

test("런북: 로그인 단계(F12·UX-14)와 오류 안내(UX-05·08·09·13)", () => {
  const md = buildRunbook(PUBLIC, TAG);
  // exit 0이면 다음 단계, 거부(6)면 다시 시작하기 전에 묻는다, 만료(7)는 한 번만.
  assert.ok(md.includes("exit 0 → step 3 ·"));
  assert.ok(md.includes("6 denied → ASK before retrying"));
  assert.ok(md.includes("7 expired → step 2 once"));
  assert.ok(md.includes('"done":false'));
  assert.ok(!/6\/7 → step 2/.test(md));
  // 빠진 파일(skipped), 소스 폴더, 남의 siteId, 등록할 것 없음, 비밀값
  assert.ok(md.includes("`skipped`"));
  assert.ok(md.includes("source_folder: deploy the build output (--allow-source only if the teacher confirms"));
  // site_not_found(B7·R9): 계정부터 묻고, --new-site는 확인 뒤 next_step_template으로만
  assert.ok(md.includes("site_not_found: ASK if the account named in the error is the teacher's."));
  assert.ok(md.includes("No → login --force; yes → next_step_template (--new-site)."));
  assert.ok(!md.includes("site_not_found: add --new-site"));
  assert.ok(md.includes("next_step_template (fill in; run after any ASK)"));
  assert.ok(md.includes("nothing_to_publish: step 3"));
  assert.ok(md.includes("20 upload rejected: fix per hint, step 3"));
  // 비밀값(R8): 허브의 한 가지 문장(hint)을 그대로 전한다.
  assert.ok(md.includes("secret_detected: say error.hint as written."));
  assert.ok(!md.includes("환경변수"));
  // warnings(개인정보)와 notes(참고)를 섞지 않는다(B3).
  assert.ok(md.includes("`warnings` (personal data)"));
  assert.ok(md.includes("`notes` are info only."));
  // dandi.json 인코딩(B2)과 위치(deploy 결과의 manifest)
  assert.ok(
    md.includes(
      "the dandi.json named in `manifest` (UTF-8, keep siteId; PowerShell: Set-Content -Encoding UTF8)",
    ),
  );
  // publish 결과(B4·R7): message를 그대로, 쓴 답도 보여 주고, kept_until_approval이면 liveUrl도
  assert.ok(md.includes("say `message` as written; show `appUrl`; list the answers used."));
  assert.ok(
    md.includes("`liveVersion` kept_until_approval: also show `liveUrl` (any previous public version stays until approval is marked)."),
  );
  // 빌드 결과 폴더를 올린다(UX-07).
  assert.ok(md.includes("the project folder only without package.json"));
  // 이미 공개한 사이트 고치기(F5)
  assert.ok(md.includes("Updating: steps 1, 3, 4; show `saved_answers`"));
  assert.ok(md.includes("지금 공개된 버전은 다시 등록할 때까지 그대로입니다."));
});

test("런북: 셸이 없을 때는 원격 MCP 도구만, 공개 HTTPS가 아니면 바로 웹 업로드로", () => {
  const pub = buildRunbook(PUBLIC, TAG);
  const noShell = (md: string) => md.slice(md.indexOf("## No shell?"), md.indexOf("## Steps"));
  assert.ok(noShell(pub).includes("dandi_deploy_files"));
  assert.ok(!noShell(pub).includes("dandi_deploy_folder"));
  assert.ok(noShell(pub).includes(`${PUBLIC}/connect`));
  for (const hub of [LOCAL, LAN]) {
    const part = noShell(buildRunbook(hub, TAG));
    assert.ok(part.includes("cannot reach this hub"), hub);
    assert.ok(part.includes(`${hub}/studio/sites 에서 사이트 폴더를 올려 주십시오.`), hub);
    assert.ok(!part.includes("/connect"), hub);
    assert.ok(!part.includes("dandi_deploy_folder"), hub);
  }
});

test("런북: 로컬·내부망 허브면 WebFetch 대신 guide 명령을 쓰라고 안내한다", () => {
  for (const hub of [LOCAL, LAN]) {
    const md = buildRunbook(hub, TAG);
    assert.ok(md.includes("WebFetch cannot read it"), hub);
    assert.ok(md.includes(`\`npx -y ${hub}/dandi-${TAG}.tgz guide\``), hub);
    assert.ok(buildFullReference(hub, TAG).includes("refuse localhost"), hub);
  }
  assert.ok(!buildRunbook(PUBLIC, TAG).includes("WebFetch cannot read it"));
  // *.localhost 미리보기 확인 방법은 localhost 허브에서만(UX-19)
  assert.ok(buildRunbook(LOCAL, TAG).includes("not Invoke-WebRequest"));
  assert.ok(!buildRunbook(LAN, TAG).includes("Invoke-WebRequest"));
  assert.ok(!buildRunbook(PUBLIC, TAG).includes("Invoke-WebRequest"));
});

test("셀프점검 5문항: 등록 폼 원문과 같고 두 문서와 스킬 파일에 모두 들어간다", () => {
  const form = readFileSync(new URL("../src/app/studio/apps/new/new-app-form.tsx", import.meta.url), "utf8");
  assert.deepEqual(
    PRIVACY_QUESTIONS.map((q) => q.key),
    ["collectsStudentData", "storageLocation", "retention", "externalTransfer", "needsSchoolApproval"],
  );
  for (const q of PRIVACY_QUESTIONS) {
    assert.ok(form.includes(`"${q.question}"`), `폼에 없는 문항: ${q.question}`);
    if (q.type === "text") assert.ok(form.includes(`placeholder="${q.answer}"`), `폼에 없는 예시: ${q.answer}`);
  }
  const skill = readFileSync(new URL("../public/downloads/SKILL.md", import.meta.url), "utf8");
  for (const doc of [buildRunbook(LOCAL, TAG), buildFullReference(LOCAL, TAG), skill]) {
    for (const q of PRIVACY_QUESTIONS) assert.ok(doc.includes(`${q.mark} ${q.question} (${q.answer})`), q.key);
  }
});

test("승인 대기 문구: ⑤가 정한다(①만으로 승인 대기라고 말하지 않는다)", () => {
  assert.equal(APPROVAL_RULE, '⑤가 "예"이면 승인 대기(①이 "예"면 ⑤도 반드시 "예")');
  const skill = readFileSync(new URL("../public/downloads/SKILL.md", import.meta.url), "utf8");
  const connect = readFileSync(new URL("../src/app/connect/page.tsx", import.meta.url), "utf8");
  assert.ok(buildFullReference(PUBLIC, TAG).includes(APPROVAL_RULE));
  assert.ok(skill.includes(APPROVAL_RULE));
  assert.ok(connect.includes("APPROVAL_RULE"));
  for (const doc of [buildRunbook(PUBLIC, TAG), buildFullReference(PUBLIC, TAG), skill, connect]) {
    assert.ok(!/①이 "예"이면[^\n]*승인 대기/.test(doc));
  }
});

test("배포 스킬 파일(/downloads/SKILL.md): v0.2 브라우저 승인 로그인, 토큰 붙여 넣기 없음", () => {
  const skill = readFileSync(new URL("../public/downloads/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^---\nname: dandi-deploy\ndescription: .+\n---\n/);
  assert.ok(skill.includes("login --hub HUB --json"));
  assert.ok(skill.includes("login --wait --json"));
  assert.ok(skill.includes("HUB/llms.txt"));
  assert.ok(skill.includes("npx.cmd"));
  assert.ok(
    skill.includes(
      "npx -y skills@latest add HUB/.well-known/agent-skills/dandi-deploy --skill dandi-deploy -a claude-code -a cursor -a codex -a antigravity-cli -a grok --copy",
    ),
  );
  // 1.3.0 흐름: 묻지 않고 바로 올리기, 요청에 적은 답 사용, headless 도구 안내
  assert.ok(skill.includes("CLI deploy --json"));
  assert.ok(skill.includes("다시 묻지 않습니다"));
  assert.ok(skill.includes("grok -p") && skill.includes("agy -p") && skill.includes("codex exec"));
  // v0.1 흐름(토큰 발급 후 login <토큰>, Vercel 경유 배포)이 남아 있지 않다.
  assert.ok(!/login <(토큰|token)>/.test(skill));
  assert.ok(!skill.includes("/studio/cli"));
  assert.ok(!skill.includes("vercel --prod"));
  assert.ok(!skill.includes("dandi-0.2.0.tgz"));
  assert.ok(!skill.includes("!"));
});

test("허브 주소 정리: 경로·계정 정보를 버리고 이상한 호스트는 기본값으로", () => {
  assert.equal(normalizeHubOrigin("https://Dandi.Example.kr/some/path?x=1"), "https://dandi.example.kr");
  assert.equal(normalizeHubOrigin("http://localhost:3000/"), LOCAL);
  assert.equal(normalizeHubOrigin("http://[::1]:3000"), "http://[::1]:3000");
  assert.equal(normalizeHubOrigin("https://user:pw@evil.example"), LOCAL);
  assert.equal(normalizeHubOrigin("javascript:alert(1)"), LOCAL);
  assert.equal(normalizeHubOrigin("http://a`b.example"), LOCAL);
  assert.equal(normalizeHubOrigin("not a url"), LOCAL);
  // 버전 문자열도 명령에 들어가므로 형식이 아니면 기본값
  assert.equal(cliPrefix(LOCAL, "0.2.0; rm -rf /"), `npx -y ${LOCAL}/dandi-${CLI_VERSION_FALLBACK}.tgz`);
  assert.ok(buildRunbook(LOCAL, "`bad`").includes(`CLI ${CLI_VERSION_FALLBACK}.`));
});

test("로컬·공개 HTTPS 판별(UX-04: http, IP, 내부망 이름은 로컬)", () => {
  for (const hub of [
    LOCAL,
    LAN,
    "http://127.0.0.1:3000",
    "http://hub.localhost:3000",
    "http://devbox:3000",
    "http://[::1]:3000",
    "http://dandi.gne.go.kr",
    "https://10.1.2.3",
    "https://203.0.113.7",
    "https://[2001:db8::1]",
    "https://hub.school.lan",
    "https://dandi.local",
    "https://hub.corp.internal",
  ]) {
    assert.equal(isLocalHub(hub), true, hub);
    assert.equal(isPublicHttpsHub(hub), false, hub);
  }
  assert.equal(isLocalHub(PUBLIC), false);
  assert.equal(isLocalHub(LONG), false);
  assert.equal(isPublicHttpsHub(PUBLIC), true);
  assert.equal(isPublicHttpsHub("https://localhost:3000"), false);
  assert.equal(isPublicHttpsHub("https://192.168.0.10"), false);
  // 이 컴퓨터 안에서만 열리는 주소
  assert.equal(isLoopbackHub(LOCAL), true);
  assert.equal(isLoopbackHub("http://[::1]:3000"), true);
  assert.equal(isLoopbackHub("http://127.0.0.1:3100"), true);
  assert.equal(isLoopbackHub(LAN), false);
  assert.equal(isLoopbackHub(PUBLIC), false);
});

test("연결 문장: 공개 허브는 /llms.txt 링크, 로컬·내부망은 npx guide 명령과 PowerShell 괄호 안내(R2)", () => {
  const pub = connectPrompt(PUBLIC, TAG);
  assert.ok(pub.startsWith(`${PUBLIC}/llms.txt `));
  const local = connectPrompt(LOCAL, TAG);
  assert.equal(
    local,
    `터미널에서 npx -y ${LOCAL}/dandi-${TAG}.tgz guide 를 실행하고(Windows PowerShell이면 npx.cmd), 출력된 안내를 그대로 따라 해서 이 폴더의 사이트를 Dandi에 올려 주십시오.`,
  );
  assert.ok(!local.includes("/llms.txt"));
  // Windows의 Claude Code는 Git Bash를 쓰므로 복사 문장을 npx.cmd로 바꾸지 않는다.
  assert.ok(!local.includes("npx.cmd -y"));
  const lan = connectPrompt(LAN, TAG);
  assert.ok(lan.includes(`npx -y ${LAN}/dandi-${TAG}.tgz guide 를 실행하고(Windows PowerShell이면 npx.cmd)`));
  assert.ok(!lan.includes("/llms.txt"));
  const connect = readFileSync(new URL("../src/app/connect/page.tsx", import.meta.url), "utf8");
  assert.ok(!/user-agent/i.test(connect), "/connect가 User-Agent로 npx.cmd를 고르지 않는다");
  for (const s of [pub, local, lan]) {
    assert.ok(s.endsWith("올려 주십시오."));
    assert.ok(!s.includes("!"));
  }
  assert.equal(windowsCli(`npx -y ${LOCAL}/dandi-${TAG}.tgz`), `npx.cmd -y ${LOCAL}/dandi-${TAG}.tgz`);
});

test("MCP 연결 명령·딥링크 (계약서 8장)", () => {
  const m = mcpInstall(PUBLIC, TAG);
  assert.equal(m.mcpUrl, `${PUBLIC}/mcp`);
  assert.equal(m.claudeCode, `claude mcp add --transport http dandi ${PUBLIC}/mcp`);
  assert.equal(m.codex, `codex mcp add dandi --url ${PUBLIC}/mcp`);
  assert.equal(m.claudeCodeStdio, `claude mcp add dandi -- npx -y ${PUBLIC}/dandi-${TAG}.tgz mcp`);

  const cursor = new URL(m.cursorDeeplink);
  assert.equal(cursor.protocol, "cursor:");
  assert.ok(m.cursorDeeplink.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=dandi&config="));
  const config = cursor.searchParams.get("config") ?? "";
  assert.deepEqual(JSON.parse(Buffer.from(config, "base64").toString("utf8")), { url: `${PUBLIC}/mcp` });

  assert.ok(m.vscodeDeeplink.startsWith("vscode:mcp/install?"));
  const vs = JSON.parse(decodeURIComponent(m.vscodeDeeplink.slice("vscode:mcp/install?".length)));
  assert.deepEqual(vs, { name: "dandi", type: "http", url: `${PUBLIC}/mcp` });

  const desktop = JSON.parse(m.claudeDesktopConfig);
  assert.deepEqual(desktop.mcpServers.dandi, { command: "npx", args: ["-y", `${PUBLIC}/dandi-${TAG}.tgz`, "mcp"] });

  assert.equal(
    m.claudeAiConnector,
    `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Dandi&connectorUrl=${encodeURIComponent(`${PUBLIC}/mcp`)}`,
  );
  // 공개 HTTPS가 아니면 claude.ai 커넥터 딥링크를 만들지 않는다.
  assert.equal(mcpInstall(LOCAL, TAG).claudeAiConnector, null);
  assert.equal(mcpInstall(LAN, TAG).claudeAiConnector, null);
  // 레퍼런스에도 같은 명령이 들어간다.
  const full = buildFullReference(PUBLIC, TAG);
  for (const line of [m.claudeCode, m.codex, m.claudeCodeStdio, m.codexStdio, m.cursorDeeplink, m.vscodeDeeplink, m.claudeAiConnector ?? ""]) {
    assert.ok(full.includes(line), line);
  }
  // Codex는 첫 명령이 바로 브라우저 승인을 연다(F7). login은 이전 버전용.
  assert.ok(full.includes("opens the browser approval right away"));
  assert.ok(full.includes(`Older Codex versions that open no browser: run \`${m.codexLogin}\``));
  const connect = readFileSync(new URL("../src/app/connect/page.tsx", import.meta.url), "utf8");
  assert.ok(!connect.includes("두 번째 명령이 브라우저 승인 화면을 엽니다"));
});

test("레퍼런스: 계약서의 명령·종료 코드·MCP 도구를 모두 담는다", () => {
  const full = buildFullReference(PUBLIC, TAG);
  for (const cmd of ["login", "logout", "whoami", "init", "deploy", "publish", "guide", "mcp", "skill add", "skill publish", "skill list"]) {
    assert.ok(full.includes(`| \`${cmd}`), cmd);
  }
  for (const code of [0, 1, 2, 4, 5, 6, 7, 20, 21]) assert.match(full, new RegExp(`\\n\\| ${code} \\|`));
  for (const tool of [
    "dandi_whoami",
    "dandi_privacy_questions",
    "dandi_deploy_files",
    "dandi_deploy_folder",
    "dandi_publish_site",
    "dandi_list_my_sites",
    "dandi_search_skills",
    "dandi_get_skill",
  ]) {
    assert.ok(full.includes(`| ${tool}`), tool);
  }
  assert.ok(
    full.includes(
      `npx -y skills@latest add ${PUBLIC}/.well-known/agent-skills/<name> --skill <name> -a claude-code -a cursor -a codex -a antigravity-cli -a grok --copy`,
    ),
  );
  assert.ok(full.includes("| `setup [--agent <list>] [-g]` |"));
  assert.ok(full.includes(`${PUBLIC}/studio/cli`));
  assert.ok(full.includes(`${PUBLIC}/oauth/connections`));
  assert.ok(!full.includes("!"));
});

test("레퍼런스: Windows·미리보기 확인·거부·내부망 허브 안내(UX-01·04·11·13·14·19)", () => {
  const pub = buildFullReference(PUBLIC, TAG);
  const local = buildFullReference(LOCAL, TAG);
  const lan = buildFullReference(LAN, TAG);
  for (const full of [pub, local, lan]) {
    assert.ok(full.includes("npx.cmd -y "));
    assert.ok(full.includes("execution policy"));
    assert.ok(full.includes("curl.exe or node"));
    assert.ok(full.includes("HUB_ORIGIN") && full.includes("SITES_DOMAIN"));
    assert.ok(full.includes("ASK the teacher whether to log in again"));
    assert.ok(full.includes('"done":false'));
    assert.ok(full.includes("--new-site"));
    assert.match(full, /never obfuscate, split or encode a key/i);
    assert.ok(full.includes("skipped"));
  }
  // 휴대전화 승인은 공개 허브에서만(UX-11)
  assert.ok(pub.includes("on a phone and approve there"));
  assert.ok(!local.includes("on a phone and approve there"));
  assert.ok(!lan.includes("on a phone and approve there"));
  assert.ok(local.includes("a browser on this computer"));
  // 공개 HTTPS가 아니면 셸 없는 도구는 바로 웹 업로드로
  assert.ok(!local.includes('| no shell | "'));
  assert.ok(pub.includes(`| no shell | "${PUBLIC}/connect`));
});

test("셸·인코딩(B1·B2·B5·R2·R4): npx.cmd는 PowerShell·cmd에서만, PowerShell은 UTF-8 콘솔과 ConvertFrom-Json", () => {
  for (const hub of [PUBLIC, LOCAL, LAN]) {
    const full = buildFullReference(hub, TAG);
    assert.ok(full.includes(`- Shell: ${SHELL_NPX_RULE}`), hub);
    assert.ok(full.includes("Never use npx.cmd in Git Bash"), hub);
    assert.ok(!/npx\.cmd[^\n]*works[^\n]*Git Bash/.test(full), hub);
    assert.ok(full.includes(`\`${windowsCli(cliPrefix(hub, TAG))} <command>\``), hub);
    assert.ok(full.includes(POWERSHELL_UTF8) && full.includes("ConvertFrom-Json"), hub);
    // --json은 기본 UTF-8, PowerShell·cmd(MSYSTEM 없음)나 DANDI_JSON_ASCII=1이면 \uXXXX
    assert.ok(full.includes("--json output is raw UTF-8"), hub);
    assert.ok(full.includes("win32 without MSYSTEM") && full.includes("DANDI_JSON_ASCII=1"), hub);
    // dandi.json을 UTF-8로(B2), 지우지 않는다
    assert.ok(full.includes("Set-Content -Encoding UTF8") && full.includes("[IO.File]::WriteAllText"), hub);
    assert.ok(full.includes("manifest_encoding"), hub);
    assert.ok(full.includes("Never delete dandi.json"), hub);
  }
  const connect = readFileSync(new URL("../src/app/connect/page.tsx", import.meta.url), "utf8");
  const guide = docsSource();
  for (const page of [connect, guide]) {
    assert.ok(page.includes("POWERSHELL_UTF8"));
    assert.ok(page.includes("Git Bash"));
    assert.ok(!page.includes("Git Bash에서도"));
  }
});

test("publish 결과(B4·R7): approvalStatus approved|not_required|pending, liveVersion, message 그대로", () => {
  const full = buildFullReference(PUBLIC, TAG);
  assert.ok(full.includes('approvalStatus: "approved"'));
  assert.ok(full.includes('"not_required" (⑤ 아니요) or "pending"'));
  assert.ok(full.includes('liveVersion: "updated"'));
  assert.ok(full.includes('"kept_until_approval" (this version goes public only when approval is marked; until then liveUrl keeps the previous public version'));
  assert.ok(full.includes("message: Korean text the hub writes for the teacher. Say it as written"));
  assert.ok(full.includes('approvalStatus:"approved"|"not_required"|"pending", liveVersion:"updated"|"kept_until_approval", message}'));
  assert.ok(!full.includes('approvalStatus ("not_required" or "pending")'));
  // 교사에게 하는 말: 허브가 쓴 message를 그대로
  assert.ok(full.includes("| published | the publish result's `message`, unchanged"));
});

test("프로젝트·사이트 변경(R6·B7·R9·R10)과 source_folder·notes(B3·R5)", () => {
  for (const hub of [PUBLIC, LOCAL]) {
    const full = buildFullReference(hub, TAG);
    const cli = cliPrefix(hub, TAG);
    // projectId는 새 사이트를 만들 때만, 옮기기는 --project(서버는 moveToProject)
    assert.ok(full.includes("[--project <id>]"), hub);
    assert.ok(full.includes("projectId only chooses the project when deploy creates a new site"), hub);
    assert.ok(full.includes("moveToProject: true"), hub);
    // site_not_found: 계정 확인 먼저, --new-site는 확인 뒤, previousSiteId
    assert.ok(full.includes("The CLI does not clear dandi.json. ASK the teacher first"), hub);
    assert.ok(full.includes(`\`${cli} login --force --json\``), hub);
    assert.ok(full.includes(`run next_step_template \`${cli} deploy <folder> --new-site --json\``), hub);
    assert.ok(full.includes("previousSiteId"), hub);
    assert.ok(!full.includes("| siteId in dandi.json is not this teacher's | `deploy <folder> --new-site --json` |"), hub);
    assert.ok(full.includes("manifest_in_parent"), hub);
    // source_folder와 --allow-source, warnings와 notes
    assert.ok(full.includes("[--allow-source]") && full.includes("allowSource: true"), hub);
    assert.ok(full.includes("`notes` [{path, kind, message}] are information, not personal data"), hub);
  }
});

test("비밀 키 안내(R8): 모든 문서가 같은 한 문장, 서버 환경변수 안내 없음", () => {
  const expected =
    "Dandi 사이트 호스팅은 정적 파일만 제공하므로 키를 보관할 수 없습니다. AI 기능은 서버 프록시(https://dandi.gne.go.kr/downloads/ai-proxy-example.md)를 따로 배포해 publish --url로 등록하거나, AI 호출을 빼십시오. 키를 숨기거나 나눠서 검사를 피하지 마십시오.";
  assert.equal(secretGuidance(PUBLIC), expected);
  assert.equal(secretGuidance(`${PUBLIC}/some/path`), expected);
  for (const hub of [PUBLIC, LOCAL, LAN]) {
    const full = buildFullReference(hub, TAG);
    assert.ok(full.includes(secretGuidance(hub)), hub);
    assert.ok(full.includes("sk-proj-") && full.includes("sk-ant-"), hub);
    assert.ok(!full.includes("환경변수"), hub);
  }
  const skill = readFileSync(new URL("../public/downloads/SKILL.md", import.meta.url), "utf8");
  assert.ok(skill.includes(secretGuidance(LOCAL).replace(LOCAL, "HUB")));
  const connect = readFileSync(new URL("../src/app/connect/page.tsx", import.meta.url), "utf8");
  const guide = docsSource();
  for (const page of [connect, guide]) {
    assert.ok(page.includes("secretGuidance("));
    assert.ok(!page.includes("키를 쪼개거나"));
  }
});

test("허브 업데이트 뒤 MCP 설정 다시 복사(R3·R11)", () => {
  for (const hub of [PUBLIC, LOCAL]) {
    const full = buildFullReference(hub, TAG);
    assert.ok(full.includes(`recopy the line from ${hub}/connect`), hub);
    assert.ok(full.includes("The hub keeps earlier dandi-<version>-<hash>.tgz files"), hub);
    // 태그 없는 별칭은 문서에 쓰지 않는다.
    assert.ok(!full.includes("dandi-0.2.0.tgz"), hub);
  }
  const connect = readFileSync(new URL("../src/app/connect/page.tsx", import.meta.url), "utf8");
  assert.ok(connect.includes("<RecopyNote />"));
  const skill = readFileSync(new URL("../public/downloads/SKILL.md", import.meta.url), "utf8");
  assert.ok(skill.includes("HUB/connect 에서 MCP 설정 줄을 다시 복사"));
});

test("배포 스킬 파일: 셸·인코딩, 계정 확인, --allow-source, publish 결과 필드", () => {
  const skill = readFileSync(new URL("../public/downloads/SKILL.md", import.meta.url), "utf8");
  assert.ok(skill.includes(POWERSHELL_UTF8));
  assert.ok(skill.includes("ConvertFrom-Json"));
  assert.ok(skill.includes("Git Bash·macOS·Linux: npx / Windows PowerShell·cmd: npx.cmd"));
  assert.ok(skill.includes("Set-Content -Encoding UTF8"));
  assert.ok(skill.includes("CLI login --force --json"));
  assert.ok(skill.includes("previousSiteId"));
  assert.ok(skill.includes("--allow-source"));
  assert.ok(skill.includes("`notes`"));
  assert.ok(skill.includes("kept_until_approval") && skill.includes("approved(승인 유지)"));
  assert.ok(skill.includes("--project"));
  // 계정을 묻지 않고 바로 --new-site로 가는 예전 안내가 없다.
  assert.ok(!skill.includes("이 교사의 것이 아님)이면 `CLI deploy <폴더> --new-site --json`을 실행합니다"));
});

test("CLI 태그: public/dandi-latest.json → cli/build-info.json → cli/package.json → 0.2.0", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dandi-runbook-"));
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  };
  try {
    assert.equal(readCliVersion(dir), CLI_VERSION_FALLBACK);

    write("cli/package.json", JSON.stringify({ name: "dandi", version: "1.4.2" }));
    assert.equal(readCliVersion(dir), "1.4.2");

    // build-info.json의 태그는 해당 tgz가 public/에 있을 때만 쓴다.
    write("cli/build-info.json", JSON.stringify({ version: "1.4.2", tag: "1.4.2-aaaa1111", tarball: "dandi-1.4.2-aaaa1111.tgz" }));
    assert.equal(readCliVersion(dir), "1.4.2");
    write("public/dandi-1.4.2-aaaa1111.tgz", "x");
    assert.equal(readCliVersion(dir), "1.4.2-aaaa1111");

    // public/dandi-latest.json이 우선한다.
    write("public/dandi-latest.json", JSON.stringify({ version: "1.4.2", tag: "1.4.2-bbbb2222", tarball: "dandi-1.4.2-bbbb2222.tgz" }));
    assert.equal(readCliVersion(dir), "1.4.2-aaaa1111");
    write("public/dandi-1.4.2-bbbb2222.tgz", "x");
    assert.equal(readCliVersion(dir), "1.4.2-bbbb2222");
    assert.equal(cliPrefix(PUBLIC, readCliVersion(dir)), `npx -y ${PUBLIC}/dandi-1.4.2-bbbb2222.tgz`);

    // tag가 없으면 tarball 이름에서 읽는다.
    write("public/dandi-latest.json", JSON.stringify({ version: "1.4.2", tarball: "dandi-1.4.2-bbbb2222.tgz" }));
    assert.equal(readCliVersion(dir), "1.4.2-bbbb2222");

    // 이상한 값은 명령에 넣지 않는다.
    write("public/dandi-latest.json", JSON.stringify({ tag: "../../evil", tarball: "dandi-$(rm).tgz" }));
    rmSync(path.join(dir, "cli", "build-info.json"));
    assert.equal(readCliVersion(dir), "1.4.2");
    write("public/dandi-latest.json", "{ broken");
    assert.equal(readCliVersion(dir), "1.4.2");
    write("cli/package.json", JSON.stringify({ version: "../../evil" }));
    assert.equal(readCliVersion(dir), CLI_VERSION_FALLBACK);
    write("cli/package.json", "{ broken");
    assert.equal(readCliVersion(dir), CLI_VERSION_FALLBACK);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("응답: 200 text/markdown, 짧은 private 캐시, 리다이렉트 없음", async () => {
  const body = buildRunbook(LOCAL, TAG);
  const res = markdownResponse(body);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.match(res.headers.get("cache-control") ?? "", /max-age=\d{1,3}\b/);
  // 허브 주소가 요청 헤더에서 올 수 있으므로 공유 캐시에 두지 않는다.
  assert.match(res.headers.get("cache-control") ?? "", /\bprivate\b/);
  assert.equal(res.headers.get("location"), null);
  assert.equal(await res.text(), body);
});

/* ---------- 주소 하나로 바로 올리기(로그인 확인 → 바로 배포 → 요청에 적은 답으로 등록) ---------- */

test("바로 올리기: 로그인 확인 → 필요하면 승인 → 묻지 않고 배포 → 요청에 적은 답이면 다시 묻지 않음", () => {
  for (const hub of HUBS) {
    const md = buildRunbook(hub, TAG);
    const cli = cliPrefix(hub, TAG);
    const at = (s: string) => {
      const i = md.indexOf(s);
      assert.ok(i >= 0, `${hub}: ${s}`);
      return i;
    };
    // 순서: whoami → login → deploy → 답 → publish
    const order = [
      `\`${cli} whoami --json\``,
      `\`${cli} login --hub ${hub} --json\``,
      `3. Deploy now (build first if package.json has a build script): \`${cli} deploy --json\``,
      "5. If the request already has 제목·설명·학교급·분류·①~⑤, use those; don't ask again.",
      "Then run deploy's next_step (publish).",
    ].map(at);
    assert.deepEqual([...order].sort((a, b) => a - b), order, hub);
    // 폴더는 교사가 말한 것만 적고, 정말 모를 때만 묻는다.
    assert.ok(md.includes("Name a folder only if the teacher did; ASK only if unclear."), hub);
    // 답은 교사에게서만(요청에 적었거나 물어서 받은 답). 결과 보고에 쓴 답을 보여 준다.
    assert.ok(
      md.includes("Never answer the privacy questions yourself or publish without the teacher's answer to each (in the request or to your ASK)."),
      hub,
    );
    assert.ok(md.includes("list the answers used"), hub);
    assert.ok(!md.includes("!"), hub);
  }
  const full = buildFullReference(PUBLIC, TAG);
  assert.ok(full.includes("If the teacher's request already gives title, description, school levels, category and all five answers, use them as given"));
  assert.ok(full.includes(`- Other docs: ${PUBLIC}/docs (for people) and ${PUBLIC}/docs/index.md`));
});

test("답을 함께 적는 연결 문장: 괄호 틀(①~⑤ 포함), CLI의 틀과 같은 문장", () => {
  assert.equal(ANSWERS_TEMPLATE, CLI_ANSWERS_TEMPLATE);
  for (const part of ["제목:", "설명:", "학교급:", "분류:", "①", "②", "③", "④", "⑤"]) assert.ok(ANSWERS_TEMPLATE.includes(part), part);
  for (const hub of [PUBLIC, LOCAL]) {
    const s = connectPromptWithAnswers(hub, TAG);
    assert.equal(s, `${connectPrompt(hub, TAG)} ${ANSWERS_TEMPLATE}`);
    assert.ok(!s.includes("!"));
  }
  assert.ok(connectPromptWithAnswers(PUBLIC, TAG).startsWith(`${PUBLIC}/llms.txt `));
});

test("스킬 설치 명령: skills@latest, 다섯 도구(-a grok 포함), --copy, CLI의 skill add와 같은 인자", () => {
  assert.equal(SKILLS_CLI, "skills@latest");
  assert.deepEqual([...SKILL_AGENTS], ["claude-code", "cursor", "codex", "antigravity-cli", "grok"]);
  assert.deepEqual([...SKILL_AGENTS], DEFAULT_SKILL_AGENTS);
  assert.equal(DEPLOY_SKILL, CLI_DEPLOY_SKILL);
  assert.equal(
    skillsAddCommand(PUBLIC, "dandi-deploy"),
    `npx -y skills@latest add ${PUBLIC}/.well-known/agent-skills/dandi-deploy --skill dandi-deploy -a claude-code -a cursor -a codex -a antigravity-cli -a grok --copy`,
  );
  assert.ok(skillsAddCommand(PUBLIC, "x", ["grok"], { global: true, yes: true }).endsWith("-a grok --copy -g -y"));
  // CLI의 skill add·setup이 실행하는 인자와 문서의 명령이 같다.
  for (const opts of [{}, { global: true }, { yes: true }]) {
    assert.equal(`npx ${skillAddArgs(PUBLIC, "dandi-deploy", DEFAULT_SKILL_AGENTS, opts).join(" ")}`, skillsAddCommand(PUBLIC, "dandi-deploy", SKILL_AGENTS, opts));
  }
});

test("Antigravity·Grok 연결: agy·grok mcp add 명령, 레퍼런스 17장(headless), /connect 탭", () => {
  const m = mcpInstall(PUBLIC, TAG);
  const cli = cliPrefix(PUBLIC, TAG);
  // agy 1.2.12 / grok 1.0.30의 mcp add --help 형식
  assert.equal(m.antigravity, `agy mcp add dandi ${PUBLIC}/mcp`);
  assert.equal(m.antigravityStdio, `agy mcp add dandi -- ${cli} mcp`);
  assert.equal(m.grok, `grok mcp add --transport http dandi ${PUBLIC}/mcp`);
  assert.equal(m.grokStdio, `grok mcp add dandi -- ${cli} mcp`);
  for (const hub of [PUBLIC, LOCAL]) {
    const full = buildFullReference(hub, TAG);
    const mi = mcpInstall(hub, TAG);
    for (const line of [mi.antigravity, mi.antigravityStdio, mi.grok, mi.grokStdio]) assert.ok(full.includes(line), `${hub} ${line}`);
    const sec = full.slice(full.indexOf("## 17. Codex, Antigravity, Grok"));
    assert.ok(sec.length > 100, hub);
    for (const s of ["`codex exec`", "`agy -p`", "`grok -p`", ".agents/skills", ".grok/skills", "/mcps", "never fill it in yourself"]) {
      assert.ok(sec.includes(s), `${hub} ${s}`);
    }
    assert.ok(full.includes("17. Codex, Antigravity, Grok\n"), hub);
    assert.ok(full.includes("ANTIGRAVITY_AGENT, GROK_SESSION_ID"), hub);
  }
  const connect = readFileSync(new URL("../src/app/connect/page.tsx", import.meta.url), "utf8");
  for (const s of ['id: "antigravity"', 'id: "grok"', "m.antigravity", "m.antigravityStdio", "m.grok", "m.grokStdio", "AI에게 이 주소를 주십시오", "connectPromptWithAnswers", "setup"]) {
    assert.ok(connect.includes(s), s);
  }
  assert.ok(!connect.includes("!</"));
});

test("배포 스킬 시드 dandi-deploy 1.3.1: 바로 올리기 흐름, 한국어·영어 트리거, 허브별 렌더링", () => {
  const skill = SEED_SKILLS.find((s) => s.name === "dandi-deploy");
  assert.ok(skill);
  assert.equal(skill.latestVersion, "1.3.1");
  assert.deepEqual(
    [...(SEED_RETIRED_VERSIONS.get("dandi-deploy") ?? [])].map((v) => v.split("@")[0]),
    ["1.0.0", "1.1.0", "1.2.0", "1.3.0"],
  );
  const v = skill.versions.find((x) => x.version === "1.3.1");
  assert.ok(v);
  assert.ok(v.createdAt > "2026-09-29T00:00:00.000Z");
  const file = v.files.find((f) => f.path === "SKILL.md");
  assert.ok(file);
  assert.ok(SKILL_TEMPLATE_BLOBS.has(file.sha256));
  const template = new TextDecoder().decode(SEED_SKILL_BLOBS.get(file.sha256));

  // 앞부분(YAML): skills CLI가 yaml로 읽으므로 값에 ": "·" #"이 없어야 한다.
  const front = template.slice(4, template.indexOf("\n---\n"));
  const description = /^description: (.+)$/m.exec(front)?.[1] ?? "";
  assert.ok(description.length > 0 && description.length <= 1024, `${description.length}`);
  assert.ok(!description.includes(": ") && !description.includes(" #"));
  for (const t of ["Dandi에 올려줘", "내 사이트 올려줘", "publish to Dandi", "deploy my site to the hub"]) assert.ok(description.includes(t), t);
  assert.match(front, /^compatibility: .*Antigravity.*Grok/m);
  assert.match(front, /version: "1\.3\.1"/);
  assert.ok(skill.description === description);

  // 허브 주소·CLI 접두어로 렌더링한 결과
  const cli = cliPrefix(PUBLIC, TAG);
  const md = renderSkillTemplate(template, { hub: PUBLIC, cli });
  assert.ok(!md.includes("{{"));
  for (const cmd of ["whoami --json", `login --hub ${PUBLIC} --json`, "deploy --json", "login --force --json", "guide"]) {
    assert.ok(md.includes(`\`${cli} ${cmd}\``), cmd);
  }
  assert.ok(md.includes("1~4단계는 확인 질문 없이 바로 진행합니다."));
  // 1.3.1: 승인 링크를 보여 준 뒤 차례를 끝내지 않고 login --wait를 이어 간다(Grok headless 시험에서 끊긴 곳).
  assert.ok(md.includes("차례를 끝내지 말고 같은 차례에서 곧바로 next_step(login --wait --json)을 실행합니다."));
  assert.ok(md.includes("①~⑤ 답이 이미 모두 있으면 그대로 쓰고 다시 묻지 않습니다."));
  for (const q of PRIVACY_QUESTIONS) assert.ok(md.includes(`${q.mark} ${q.question} (${q.answer})`), q.key);
  assert.ok(md.includes(APPROVAL_RULE));
  assert.ok(md.includes(secretGuidance(PUBLIC)));
  assert.ok(md.includes("Git Bash·macOS·Linux: npx / Windows PowerShell·cmd: npx.cmd"));
  assert.ok(md.includes(POWERSHELL_UTF8));
  for (const s of ["codex exec", "agy -p", "grok -p"]) assert.ok(md.includes(s), s);
  assert.ok(!md.includes("!"));
  assert.doesNotMatch(md, /dd_(cli|sk|mat|mrt|dev)_[A-Za-z0-9_-]{8,}/);
});
