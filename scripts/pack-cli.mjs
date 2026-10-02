#!/usr/bin/env node
// cli/ 폴더를 npm pack 해서 허브가 제공할 CLI tarball을 만든다(F-54).
// npm에 공개하기 전까지 허브가 이 파일을 제공하고, 교사·AI 에이전트는 설치 없이
// `npx -y <허브>/dandi-<tag>.tgz <명령>`으로 실행한다. package.json의 predev·prebuild에서 부른다.
//
// npx는 같은 tarball 주소로 한 번 설치한 CLI를 계속 실행한다(내용이 바뀌어도 새로 설치하지 않는다).
// 그래서 CLI 소스가 바뀌면 주소도 바뀌도록 소스 해시를 이름에 넣는다.
//   sha8     = cli/ 아래 소스 파일(build-info.json·tgz 제외)의 sha256 앞 8자
//   tag      = <version>-<sha8>                  예: 0.2.0-1a2b3c4d
//   만드는 것 = cli/build-info.json {"version","tag","tarball"}  (tarball 안에도 들어가 CLI가 자기 태그를 안다)
//              public/dandi-<tag>.tgz          (에이전트가 쓰는 주소)
//              public/dandi-latest.json        {"version","tag","tarball"} (허브 문서·CLI 새 버전 확인용)
//
// 예전에 만든 public/dandi-<version>-<sha8>.tgz는 지우지 않는다(QA R3). MCP 설정(claude mcp add … mcp,
// Claude 데스크톱 JSON)·에이전트 메모가 그 주소를 계속 쓰므로, 지우면 MCP 서버가 아예 시작하지 못하고
// 새 CLI 안내(cli_update)도 보여 줄 수 없다. 파일은 60KB 안팎이라 남겨 둔다.
// 태그 없는 별칭 public/dandi-<version>.tgz는 더 만들지 않고, 있으면 지운다(QA R11: npx가 첫 설치를 계속 써서
// 새 CLI가 전달되지 않는다). 허브가 바뀐 뒤 MCP가 시작하지 않으면 /connect에서 MCP 줄을 다시 복사하게 안내한다.
//
// 사용법: node scripts/pack-cli.mjs [--force]
//   결과가 이미 최신이면 다시 만들지 않는다(--force면 항상 만든다).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_DIR = path.join(ROOT, "cli");
const PUBLIC_DIR = path.join(ROOT, "public");
const BUILD_INFO = path.join(CLI_DIR, "build-info.json");
const LATEST = path.join(PUBLIC_DIR, "dandi-latest.json");
const force = process.argv.includes("--force");

/** @param {string} p */
async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} p */
async function readOrNull(p) {
  try {
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

/** 파일 내용이 다를 때만 쓴다(mtime을 쓸데없이 바꾸지 않게). @param {string} p @param {string} text */
async function writeIfChanged(p, text) {
  const current = await readOrNull(p);
  if (current && current.toString("utf8") === text) return false;
  await fs.writeFile(p, text, "utf8");
  return true;
}

/**
 * 해시에 넣을 CLI 소스 파일(슬래시 구분 상대 경로, 정렬). build-info.json, tgz, node_modules, 점 파일은 뺀다.
 * @param {string} dir
 * @param {string} [rel]
 * @returns {Promise<string[]>}
 */
async function listSources(dir, rel = "") {
  /** @type {string[]} */
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (entry.isDirectory()) out.push(...(await listSources(path.join(dir, entry.name), relPath)));
    else if (entry.isFile() && relPath !== "build-info.json" && !entry.name.endsWith(".tgz")) out.push(relPath);
  }
  return out.sort();
}

/** 태그 없는 별칭(dandi-<version>.tgz)인가. 소스 해시를 붙인 이름(dandi-<version>-<sha8>.tgz)은 해당하지 않는다. */
const LEGACY_ALIAS_RE = /^dandi-\d+\.\d+\.\d+\.tgz$/;

/** 태그 없는 별칭을 지운다. 해시를 붙인 예전 tarball은 남겨 둔다(저장된 MCP 설정이 계속 시작되게). */
async function removeLegacyAliases() {
  const removed = [];
  for (const name of await fs.readdir(PUBLIC_DIR)) {
    if (LEGACY_ALIAS_RE.test(name)) {
      await fs.rm(path.join(PUBLIC_DIR, name), { force: true });
      removed.push(name);
    }
  }
  if (removed.length) console.log(`태그 없는 예전 별칭을 지웠습니다: ${removed.join(", ")} (해시를 붙인 tarball은 남겨 둡니다)`);
}

const pkg = JSON.parse(await fs.readFile(path.join(CLI_DIR, "package.json"), "utf8"));
// npm 레지스트리의 "dandi"는 다른 사람의 패키지라 CLI 패키지 이름은 dandi-cli, 명령 이름(bin)은 dandi다.
if (pkg.name !== "dandi-cli" || !pkg.bin || !pkg.bin.dandi || typeof pkg.version !== "string" || !Array.isArray(pkg.files)) {
  console.error("cli/package.json의 name·version·files를 확인하십시오.");
  process.exit(1);
}
if (!pkg.files.includes("build-info.json")) {
  console.error('cli/package.json의 files에 "build-info.json"이 있어야 합니다(CLI가 자기 빌드 태그를 읽습니다).');
  process.exit(1);
}
const lib = await fs.readFile(path.join(CLI_DIR, "lib.mjs"), "utf8");
const libVersion = /export const CLI_VERSION = "([^"]+)"/.exec(lib)?.[1];
if (libVersion !== pkg.version) {
  console.error(`버전이 다릅니다: cli/package.json ${pkg.version}, cli/lib.mjs CLI_VERSION ${libVersion ?? "(없음)"}`);
  process.exit(1);
}
for (const f of pkg.files) {
  if (f !== "build-info.json" && !(await exists(path.join(CLI_DIR, f)))) {
    console.error(`cli/package.json의 files에 적힌 파일이 없습니다: cli/${f}`);
    process.exit(1);
  }
}

// 1) 소스 해시 → 태그
const hash = createHash("sha256");
for (const rel of await listSources(CLI_DIR)) {
  const bytes = await fs.readFile(path.join(CLI_DIR, ...rel.split("/")));
  hash.update(`${rel}\0${bytes.length}\0`);
  hash.update(bytes);
}
const sha8 = hash.digest("hex").slice(0, 8);
const version = pkg.version;
const tag = `${version}-${sha8}`;
const tarball = `dandi-${tag}.tgz`;
const info = { version, tag, tarball };
const infoText = `${JSON.stringify(info, null, 2)}\n`;

await fs.mkdir(PUBLIC_DIR, { recursive: true });
await writeIfChanged(BUILD_INFO, infoText);

const targetPath = path.join(PUBLIC_DIR, tarball);

// 2) 이미 최신이면(같은 태그의 tgz, latest.json) 그대로 둔다.
if (!force && (await exists(targetPath))) {
  const latestChanged = await writeIfChanged(LATEST, infoText);
  await removeLegacyAliases();
  console.log(`최신 상태입니다: public/${tarball}${latestChanged ? " (dandi-latest.json 갱신)" : ""}`);
  process.exit(0);
}

// 3) npm pack(임시 폴더) → public/dandi-<tag>.tgz
// public/에 바로 만들면 잠깐이라도 태그 없는 이름(dandi-<version>.tgz)이 서빙되므로 임시 폴더에 만든다.
const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "dandi-pack-"));
if (/["%^&|<>]/.test(packDir)) {
  console.error(`임시 폴더 경로에 셸 특수 문자가 있습니다: ${packDir}`);
  process.exit(1);
}
// Windows의 npm은 .cmd라 셸이 필요하다. 명령 문자열은 고정값과 위에서 확인한 임시 폴더 경로뿐이다.
/** npm pack 결과를 public/<tarball>로 옮긴다. 실패하면 이유를 출력하고 false. */
async function packToPublic() {
  const result =
    process.platform === "win32"
      ? spawnSync(`npm pack ./cli --pack-destination "${packDir}" --json`, { cwd: ROOT, shell: true, encoding: "utf8" })
      : spawnSync("npm", ["pack", "./cli", "--pack-destination", packDir, "--json"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    console.error("npm pack이 실패했습니다.");
    console.error(result.error?.message ?? result.stderr);
    return false;
  }
  /** @type {{ filename?: string, files?: { path: string }[], size?: number }[]} */
  let packInfo = [];
  try {
    packInfo = JSON.parse(result.stdout.slice(result.stdout.indexOf("[")));
  } catch {
    packInfo = [];
  }
  const produced = path.join(packDir, path.basename(packInfo[0]?.filename ?? `dandi-cli-${version}.tgz`));
  if (!(await exists(produced))) {
    console.error(`npm pack 결과 파일을 찾지 못했습니다: ${produced}`);
    return false;
  }
  const files = packInfo[0]?.files?.map((f) => f.path).sort() ?? [];
  if (files.length && !files.includes("build-info.json")) {
    console.error("tarball에 build-info.json이 들어가지 않았습니다. cli/package.json의 files를 확인하십시오.");
    return false;
  }
  // 같은 폴더 안에서 이름만 바꿔 넣어, 허브가 반쯤 쓴 파일을 내보내지 않게 한다.
  const staging = `${targetPath}.${process.pid}.tmp`;
  await fs.copyFile(produced, staging);
  await fs.rename(staging, targetPath);
  await writeIfChanged(LATEST, infoText);
  await removeLegacyAliases();

  const size = (await fs.stat(targetPath)).size;
  const kept = (await fs.readdir(PUBLIC_DIR)).filter((n) => /^dandi-\d+\.\d+\.\d+-[0-9A-Za-z.-]+\.tgz$/.test(n) && n !== tarball);
  console.log(`만들었습니다: public/${tarball} (${(size / 1024).toFixed(1)}KB${files.length ? `, ${files.join(", ")}` : ""})`);
  console.log(`최신 정보: public/dandi-latest.json${kept.length ? ` · 남겨 둔 예전 CLI ${kept.length}개(저장된 MCP 설정용)` : ""}`);
  console.log(`실행 예: npx -y http://localhost:3000/${tarball} --version`);
  return true;
}

let packed = false;
try {
  packed = await packToPublic();
} finally {
  await fs.rm(packDir, { recursive: true, force: true }).catch(() => {});
}
if (!packed) process.exit(1);
