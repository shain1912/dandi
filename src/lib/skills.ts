import "server-only";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { putBlob, readBlob } from "./blobs";
import { isSchoolLevel } from "./constants";
import { mutate, nowIso, readDb } from "./db";
import { clientIp } from "./origin";
import { maskPII, scanPII } from "./pii";
import { cliPrefix, normalizeHubOrigin, readCliVersion, SKILL_AGENTS, skillsAddCommand } from "./runbook";
import {
  buildSkillArchive,
  renderSkillTemplate,
  SEED_RETIRED_VERSIONS,
  SEED_SKILL_BLOBS,
  SEED_SKILLS,
  SKILL_TEMPLATE_BLOBS,
  sha256Hex,
} from "./seed-skills";
import { displayName, ensureUser, isTeacher, writeAudit } from "./session";
import type { SchoolLevel, SiteFile, Skill, SkillReviewStatus, SkillVersion, User } from "./types";

// 스킬 레지스트리(F-37 ~ F-40, skills.sh 방식).
// - 게시: SKILL.md 앞부분 검증 → 정적 안전 검토 → 파일·압축 파일을 data/blobs/<sha256>에 저장 → 변경 불가 버전 추가
// - 설치: /.well-known/agent-skills/index.json(Agent Skills Discovery v0.2.0, archive + sha256 digest)과
//   구 경로 /.well-known/skills/index.json(v0.1.0 files 목록)을 제공해 `npx skills add <hub>/.well-known/agent-skills/<name> --skill <name>`
//   (범위 지정 소스, 고른 스킬 하나만 받음)과 `npx skills add <hub>`가 모두 동작한다.
// - 프롬프트만 있고 지적 사항이 없는 버전은 자동 공개, 스크립트·훅·광범위한 셸 권한 등이 있으면 관리자 검토 후 공개,
//   비밀값·학생 개인정보 패턴이 있으면 게시를 거부한다(저장하지 않는다).

/* ---------- 상수 ---------- */

export const SKILL_LIMITS = {
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 10 * 1024 * 1024,
  fileCount: 200,
  pathLength: 200,
  pathDepth: 8,
};

export const SKILL_TOOLS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
  { id: "grok", label: "Grok" },
] as const;
export type SkillToolId = (typeof SKILL_TOOLS)[number]["id"];

export function isSkillTool(value: unknown): value is SkillToolId {
  return SKILL_TOOLS.some((t) => t.id === value);
}

export const SKILL_STATUS_LABEL: Record<SkillReviewStatus, string> = {
  approved: "검토 완료",
  pending_review: "검토 대기",
  rejected: "반려",
  hidden: "숨김",
};

export function skillToolLabel(id: string): string {
  return SKILL_TOOLS.find((t) => t.id === id)?.label ?? id;
}

/** Agent Skills Discovery v0.2.0 스키마 주소(skills CLI가 이 값으로 형식을 구분한다). */
export const DISCOVERY_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// /skills/new 같은 고정 경로와 겹치는 이름
const RESERVED_NAMES = new Set(["new", "index", "admin", "api", "well-known"]);
const SEMVER_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 1024;
const LICENSE_MAX = 100;
const COMPATIBILITY_MAX = 500;
const SKILL_MD_LINES_RECOMMENDED = 500;

const SCRIPT_EXT = new Set(["sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd", "vbs", "py", "js", "mjs", "cjs", "ts", "rb", "pl", "php", "lua"]);
const FORBIDDEN_EXT = new Set([
  "exe", "dll", "so", "dylib", "msi", "bin", "jar", "class", "apk", "app", "dmg", "iso", "com", "scr", "sys",
  "deb", "rpm", "pkg", "zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz",
]);
const TEXT_TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  html: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
};
const BINARY_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
};

/* ---------- 결과·입력 타입 ---------- */

export type FindingSeverity = "block" | "review" | "info";

export interface SkillFinding {
  severity: FindingSeverity;
  rule: string;
  path: string;
  line?: number;
  message: string;
}

export type SkillResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string; hint?: string; findings?: SkillFinding[] };

export interface SkillInputFile {
  path: string;
  bytes: Uint8Array;
}

export interface PublishSkillMeta {
  title?: string;
  schoolLevels?: string[];
  compatibility?: string[];
  /** 올린 폴더 이름. 있으면 SKILL.md의 name과 같아야 한다 */
  folder?: string;
}

export interface PublishSkillOutput {
  name: string;
  version: string;
  status: "approved" | "pending_review";
  findings: SkillFinding[];
  hasScripts: boolean;
  /** 이미 같은 내용의 버전이 있어 새 버전을 만들지 않았다 */
  unchanged: boolean;
}

export interface SkillSummary {
  name: string;
  title: string;
  description: string;
  license: string;
  schoolLevels: SchoolLevel[];
  compatibility: string[];
  authorName: string;
  installs: number;
  latestVersion: string;
  hasScripts: boolean;
  status: "approved";
  reviewedByName: string | null;
  updatedAt: string;
  installCommand?: string;
  url?: string;
}

export interface SkillDetail extends SkillSummary {
  digest: string;
  files: { path: string; size: number }[];
  versions: { version: string; digest: string; hasScripts: boolean; createdAt: string; archivePath: string }[];
  archivePath: string;
  archiveUrl?: string;
  skillMd: string;
}

function fail<T>(status: number, code: string, message: string, hint?: string, findings?: SkillFinding[]): SkillResult<T> {
  return { ok: false, status, code, message, ...(hint ? { hint } : {}), ...(findings ? { findings } : {}) };
}

/* ---------- 설치 명령 ---------- */

/** 허브 CLI 실행 접두어(예: "npx -y <hub>/dandi-0.2.0-<sha8>.tgz"). 런북·/connect와 같은 값을 쓴다. */
export function vibeHubCliPrefix(hub: string): string {
  return cliPrefix(hub, readCliVersion());
}

/**
 * 스킬 하나만 담은 설치 소스(<hub>/.well-known/agent-skills/<name>).
 * skills CLI(vercel-labs/skills, src/providers/wellknown.ts)는 주소에 경로가 있으면 <주소>/.well-known/agent-skills/index.json
 * (범위 index)을 먼저 후보로 두고 그 index의 압축 파일만 받는다(1.5.18은 첫 후보 우선, 1.7.0은 루트 후보를 아예 뺀다).
 * 루트 주소(<hub>)를 주면 --skill로 고르기 전에 목록의 모든 압축 파일을 내려받는다.
 */
export function skillInstallSource(hub: string, name: string): string {
  return `${hub}/.well-known/agent-skills/${name}`;
}

/**
 * 계약 6장의 설치 명령(목록·상세·CLI·MCP 공통). 범위 지정 소스라 고른 스킬 하나만 내려받는다.
 * 기본 도구(SKILL_AGENTS)는 Claude Code·Cursor·Codex·Antigravity CLI·Grok이고, 명령 형식은 runbook.ts skillsAddCommand가 정한다
 * (-a grok 때문에 skills@latest를 쓴다).
 */
export function skillInstallCommand(hub: string, name: string): string {
  return skillsAddCommand(hub, name);
}

/** 상세 화면의 도구별 설치 명령. */
export function skillInstallVariants(hub: string, name: string): { id: string; label: string; command: string; note: string }[] {
  return [
    {
      id: "all",
      label: "모든 도구",
      command: skillInstallCommand(hub, name),
      note: "지금 폴더(프로젝트)의 .claude/skills, .agents/skills, .grok/skills에 Claude Code·Cursor·Codex·Antigravity·Grok용으로 한 번에 설치합니다.",
    },
    { id: "claude-code", label: "Claude Code", command: skillsAddCommand(hub, name, ["claude-code"]), note: "프로젝트의 .claude/skills 폴더에 설치합니다." },
    { id: "cursor", label: "Cursor", command: skillsAddCommand(hub, name, ["cursor"]), note: "프로젝트의 .agents/skills 폴더에 설치합니다." },
    { id: "codex", label: "Codex", command: skillsAddCommand(hub, name, ["codex"]), note: "프로젝트의 .agents/skills 폴더에 설치합니다." },
    {
      id: "antigravity",
      label: "Antigravity",
      command: skillsAddCommand(hub, name, ["antigravity-cli", "antigravity"]),
      note: "프로젝트의 .agents/skills 폴더에 설치합니다. Antigravity 편집기와 터미널용 agy가 함께 읽습니다.",
    },
    { id: "grok", label: "Grok", command: skillsAddCommand(hub, name, ["grok"]), note: "프로젝트의 .grok/skills 폴더에 설치합니다." },
    { id: "global", label: "전역 설치", command: skillsAddCommand(hub, name, SKILL_AGENTS, { global: true }), note: "모든 프로젝트에서 쓰도록 사용자 폴더에 설치합니다." },
    { id: "dandi", label: "dandi CLI", command: `${vibeHubCliPrefix(hub)} skill add ${name}`, note: "Dandi CLI가 위의 설치 명령을 대신 실행합니다." },
  ];
}

/** 버전 고정 압축 파일 경로(허브 기준). */
export function skillArchivePath(name: string, version: string): string {
  return `/.well-known/agent-skills/${name}/${version}.zip`;
}

/* ---------- blob 저장소 (blobs.ts: data/blobs/<sha256>, 사이트 호스팅과 공용) ---------- */

async function storeBlob(bytes: Uint8Array): Promise<string> {
  const r = await putBlob(bytes);
  if (!r.ok) throw new Error("blob 저장 실패");
  return r.hash;
}

/** 본문을 읽는다. 없거나 손상되었고 시드 스킬 본문이면 그때 기록한다(시드는 처음 읽을 때 blob으로 만든다). */
async function getBlob(hash: string, verify = false): Promise<Uint8Array | null> {
  const bytes = await readBlob(hash, { verify });
  if (bytes) return bytes;
  const seed = SEED_SKILL_BLOBS.get(hash);
  if (!seed) return null;
  await storeBlob(seed);
  return seed;
}

/* ---------- 허브 주소를 넣어 내보내는 스킬(시드 dandi-deploy) ---------- */

// SKILL_TEMPLATE_BLOBS에 든 파일(시드가 만든 템플릿)은 내보낼 때 {{HUB}}·{{CLI}}를 요청한 허브 주소와 현재 CLI 실행
// 접두어로 바꾼다. 저장소에는 허브와 무관한 템플릿과 그 digest를 두고, 설치 index·압축 파일·SKILL.md·API는 모두
// 같은 렌더링 결과(허브·CLI 접두어별로 만든 압축 파일과 그 sha256)를 쓰므로 skills CLI의 digest 검사가 맞는다.

interface RenderedVersion {
  files: Map<string, Uint8Array>;
  archive: Uint8Array;
  digest: string;
}

const RENDER_CACHE_MAX = 64;
const gr = globalThis as unknown as { __dandiSkillRender?: Map<string, RenderedVersion> };

function isTemplatedVersion(v: SkillVersion): boolean {
  return v.files.some((f) => SKILL_TEMPLATE_BLOBS.has(f.sha256));
}

function renderContext(hub: string): { hub: string; cli: string } {
  const origin = normalizeHubOrigin(hub);
  return { hub: origin, cli: vibeHubCliPrefix(origin) };
}

/** 템플릿 버전이면 허브별로 렌더링한 파일·압축 파일·digest. 템플릿이 아니거나 hub가 없으면 null(저장된 값을 그대로 쓴다). */
async function renderedVersion(v: SkillVersion, hub: string | undefined): Promise<RenderedVersion | null> {
  if (!hub || !isTemplatedVersion(v)) return null;
  const ctx = renderContext(hub);
  const key = `${v.digest}\n${ctx.hub}\n${ctx.cli}`;
  const cache = (gr.__dandiSkillRender ??= new Map());
  const hit = cache.get(key);
  if (hit) return hit;
  const files = new Map<string, Uint8Array>();
  for (const f of v.files) {
    const bytes = await getBlob(f.sha256);
    if (!bytes) return null;
    files.set(
      f.path,
      SKILL_TEMPLATE_BLOBS.has(f.sha256) ? new TextEncoder().encode(renderSkillTemplate(new TextDecoder().decode(bytes), ctx)) : bytes,
    );
  }
  const archive = buildSkillArchive([...files].map(([path, bytes]) => ({ path, bytes })));
  const out: RenderedVersion = { files, archive, digest: `sha256:${sha256Hex(archive)}` };
  if (cache.size >= RENDER_CACHE_MAX) cache.clear();
  cache.set(key, out);
  return out;
}

/** 설치 index·상세 화면에 보일 버전 digest와 파일 크기(템플릿이면 이 허브용으로 렌더링한 값). */
export async function describeSkillVersion(
  v: SkillVersion,
  hub?: string,
): Promise<{ digest: string; files: { path: string; size: number }[] }> {
  const r = await renderedVersion(v, hub);
  if (!r) return { digest: v.digest, files: v.files.map((f) => ({ path: f.path, size: f.size })) };
  return { digest: r.digest, files: v.files.map((f) => ({ path: f.path, size: r.files.get(f.path)?.byteLength ?? f.size })) };
}

/* ---------- 시드 반영 ---------- */

const g = globalThis as unknown as { __dandiSkillSeeds?: Promise<void> };

/**
 * 시드 스킬이 저장소에 없으면 넣는다(이미 만들어진 db.json에도 시드가 보이게 한다).
 * 같은 이름의 스킬이 이미 있으면 그대로 두되, 시드가 게시한 스킬(authorId 같음)에 시드의 새 버전이 없으면
 * 새 버전만 덧붙이고(게시한 버전은 바꾸지 않는다) 고친 이전 시드 버전은 숨긴다. 프로세스마다 한 번만 실행한다.
 */
function ensureSeedSkills(): Promise<void> {
  if (!g.__dandiSkillSeeds) {
    g.__dandiSkillSeeds = mutate((db) => {
      for (const seed of SEED_SKILLS) {
        const existing = db.skills.find((s) => s.name === seed.name);
        if (!existing) {
          db.skills.push(structuredClone(seed));
          continue;
        }
        if (existing.authorId !== seed.authorId) continue;
        const top = maxVersion(existing.versions);
        for (const v of seed.versions) {
          if (existing.versions.some((x) => x.version === v.version)) continue;
          if (top && compareSemver(v.version, top) <= 0) continue; // 관리자가 더 높은 버전을 올렸으면 그대로 둔다
          existing.versions.push(structuredClone(v));
          existing.latestVersion = maxVersion(existing.versions) ?? v.version;
          if (v.createdAt > existing.updatedAt) existing.updatedAt = v.createdAt;
          for (const old of existing.versions) {
            const retired = SEED_RETIRED_VERSIONS.get(seed.name);
            if (old.status === "approved" && retired?.has(`${old.version}@${old.createdAt}`)) old.status = "hidden";
          }
        }
      }
    }).catch((err) => {
      g.__dandiSkillSeeds = undefined;
      throw err;
    });
  }
  return g.__dandiSkillSeeds;
}

async function loadSkills(): Promise<Skill[]> {
  await ensureSeedSkills();
  return (await readDb()).skills;
}

/* ---------- 버전 ---------- */

function parseSemver(v: string): [number, number, number] | null {
  const m = SEMVER_RE.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a) ?? [0, 0, 0];
  const pb = parseSemver(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function maxVersion(versions: SkillVersion[]): string | null {
  let best: string | null = null;
  for (const v of versions) if (!best || compareSemver(v.version, best) > 0) best = v.version;
  return best;
}

function bumpPatch(v: string): string {
  const p = parseSemver(v) ?? [1, 0, 0];
  return `${p[0]}.${p[1]}.${p[2] + 1}`;
}

/** 공개(설치) 대상 버전: 승인된 버전 중 가장 높은 것. */
export function currentVersion(skill: Skill): SkillVersion | null {
  let best: SkillVersion | null = null;
  for (const v of skill.versions) {
    if (v.status !== "approved") continue;
    if (!best || compareSemver(v.version, best.version) > 0) best = v;
  }
  return best;
}

export function isPublicSkill(skill: Skill): boolean {
  return currentVersion(skill) !== null;
}

/** 공개 전 버전까지 볼 수 있는 사람: 게시한 교사와 관리자. */
export function canManageSkill(skill: Skill, viewer: User | null): boolean {
  if (!viewer) return false;
  return viewer.role === "admin" || (isTeacher(viewer) && viewer.id === skill.authorId);
}

/* ---------- SKILL.md 앞부분(YAML 일부) ---------- */

export interface SkillFrontmatter {
  name: string;
  description: string;
  license: string;
  compatibility: string | null;
  allowedTools: string[];
  metadata: Record<string, string>;
  hooks: boolean;
  keys: string[];
}

type Scalar = { value: string; quoted: boolean };
type YamlNode =
  | { kind: "scalar"; scalar: Scalar }
  | { kind: "list"; items: Scalar[] }
  | { kind: "map"; entries: Map<string, Scalar> }
  | { kind: "complex" }
  | { kind: "null" };

class YamlError extends Error {
  line: number;
  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

// YAML 1.2 core schema에서 문자열이 아닌 값으로 읽히는 평문(따옴표 없는 값)
const YAML_NON_STRING =
  /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+|[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

function parseDoubleQuoted(text: string, line: number): { value: string; rest: string } {
  let out = "";
  let i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return { value: out, rest: text.slice(i + 1) };
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = text[++i];
    const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", n: "\n", t: "\t", r: "\r", "0": "\0", " ": " " };
    if (n in simple) out += simple[n];
    else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
      i += 4;
    } else throw new YamlError(line, "큰따옴표 안에서 쓸 수 없는 역슬래시 문자가 있습니다.");
  }
  throw new YamlError(line, "큰따옴표 값은 같은 줄에서 닫아야 합니다.");
}

function parseSingleQuoted(text: string, line: number): { value: string; rest: string } {
  let out = "";
  for (let i = 1; i < text.length; i++) {
    if (text[i] !== "'") {
      out += text[i];
      continue;
    }
    if (text[i + 1] === "'") {
      out += "'";
      i++;
      continue;
    }
    return { value: out, rest: text.slice(i + 1) };
  }
  throw new YamlError(line, "작은따옴표 값은 같은 줄에서 닫아야 합니다.");
}

/** 한 줄 값(따옴표·평문). 블록 값(|, >)과 목록은 호출하는 쪽이 처리한다. */
function parseInlineScalar(text: string, line: number): Scalar {
  const t = text.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const r = t.startsWith('"') ? parseDoubleQuoted(t, line) : parseSingleQuoted(t, line);
    if (!/^\s*(?:#.*)?$/.test(r.rest)) throw new YamlError(line, "따옴표를 닫은 뒤에 다른 글자가 있습니다.");
    return { value: r.value, quoted: true };
  }
  if (/^[&*!%@`{]/.test(t) || /^[-?:](?:\s|$)/.test(t)) {
    throw new YamlError(line, "특수 문자로 시작하는 값은 큰따옴표로 감싸십시오.");
  }
  // 평문 값: " #" 뒤는 주석이다.
  const hash = t.search(/\s#/);
  const plain = (hash >= 0 ? t.slice(0, hash) : t).trim();
  if (/:\s/.test(plain) || plain.endsWith(":")) {
    throw new YamlError(line, "값에 ': '(콜론과 공백)이 있으면 값 전체를 큰따옴표로 감싸십시오.");
  }
  return { value: plain, quoted: false };
}

function parseFlowList(text: string, line: number): Scalar[] {
  const t = text.trim();
  if (!t.endsWith("]")) throw new YamlError(line, "[ ] 목록은 같은 줄에서 닫아야 합니다.");
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  if (/[[\]{}]/.test(inner)) throw new YamlError(line, "목록 안에 다른 목록을 넣을 수 없습니다.");
  return inner.split(",").map((part) => parseInlineScalar(part, line));
}

/** 블록 값(| 또는 >). lines[start]부터 들여쓴 줄을 모은다. */
function parseBlockScalar(header: string, lines: string[], start: number, parentIndent: number, line: number): { scalar: Scalar; next: number } {
  const m = /^([|>])([+-]?)\s*(?:#.*)?$/.exec(header.trim());
  if (!m) throw new YamlError(line, "블록 값 표시(| 또는 >) 뒤에는 다른 글자를 쓰지 마십시오.");
  const body: string[] = [];
  let i = start;
  let indent = -1;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") {
      body.push("");
      continue;
    }
    const lead = /^ */.exec(l)![0].length;
    if (lead <= parentIndent) break;
    if (indent < 0) indent = lead;
    if (lead < indent) throw new YamlError(i + 1, "블록 값의 들여쓰기가 맞지 않습니다.");
    body.push(l.slice(indent));
  }
  // 뒤쪽 빈 줄은 블록 값에 속하지 않는다(다음 키 앞 공백).
  let end = body.length;
  while (end > 0 && body[end - 1] === "") end--;
  const kept = body.slice(0, end);
  let value: string;
  if (m[1] === "|") value = kept.join("\n");
  else {
    value = "";
    for (let k = 0; k < kept.length; k++) {
      const cur = kept[k];
      if (k === 0) value = cur;
      else if (cur === "") value += "\n";
      else if (kept[k - 1] === "" || /^\s/.test(cur) || /^\s/.test(kept[k - 1])) value += (kept[k - 1] === "" ? "" : "\n") + cur;
      else value += ` ${cur}`;
    }
  }
  if (m[2] !== "-" && value) value += "\n";
  return { scalar: { value, quoted: true }, next: i - (body.length - end) };
}

function parseYamlSubset(src: string): Map<string, YamlNode> {
  const lines = src.split("\n");
  const data = new Map<string, YamlNode>();
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const lineNo = i + 1;
    if (raw.includes("\t")) throw new YamlError(lineNo, "탭 문자 대신 공백으로 들여쓰십시오.");
    if (/^\s*(?:#.*)?$/.test(raw)) {
      i++;
      continue;
    }
    if (/^\s/.test(raw)) throw new YamlError(lineNo, "들여쓰기가 맞지 않습니다. 최상위 키는 줄 맨 앞에서 시작하십시오.");
    const m = /^([A-Za-z0-9_-]{1,64}):(?:\s+(.*))?$/.exec(raw);
    if (!m) throw new YamlError(lineNo, "\"키: 값\" 형식이 아닙니다.");
    const key = m[1];
    if (data.has(key)) throw new YamlError(lineNo, `같은 키(${key})가 두 번 있습니다.`);
    const rest = (m[2] ?? "").trim();
    i++;

    if (rest && !rest.startsWith("#")) {
      if (rest.startsWith("|") || rest.startsWith(">")) {
        const r = parseBlockScalar(rest, lines, i, 0, lineNo);
        data.set(key, { kind: "scalar", scalar: r.scalar });
        i = r.next;
      } else if (rest.startsWith("[")) {
        data.set(key, { kind: "list", items: parseFlowList(rest, lineNo) });
      } else {
        data.set(key, { kind: "scalar", scalar: parseInlineScalar(rest, lineNo) });
      }
      continue;
    }

    // 값이 비어 있으면 다음 줄부터 들여쓴 목록·맵(또는 맨 앞의 "- " 목록)이 온다.
    const block: { text: string; line: number }[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.includes("\t")) throw new YamlError(i + 1, "탭 문자 대신 공백으로 들여쓰십시오.");
      if (l.trim() === "" || /^\s*#/.test(l) || /^ +\S/.test(l) || /^- /.test(l) || l === "-") {
        if (l.trim() !== "" && !/^\s*#/.test(l)) block.push({ text: l, line: i + 1 });
        i++;
        continue;
      }
      break;
    }
    if (block.length === 0) {
      data.set(key, { kind: "null" });
      continue;
    }
    const indent = /^ */.exec(block[0].text)![0].length;
    const first = block[0].text.slice(indent);
    if (first.startsWith("- ") || first === "-") {
      const items: Scalar[] = [];
      let complex = false;
      for (const b of block) {
        const lead = /^ */.exec(b.text)![0].length;
        const body = b.text.slice(lead);
        if (lead === indent && (body.startsWith("- ") || body === "-")) {
          const item = body.slice(1).trim();
          if (!item || /^[A-Za-z0-9_-]+:(?:\s|$)/.test(item) || item.startsWith("[") || item.startsWith("|") || item.startsWith(">")) complex = true;
          else items.push(parseInlineScalar(item, b.line));
        } else if (lead > indent) complex = true;
        else throw new YamlError(b.line, "목록의 들여쓰기가 맞지 않습니다.");
      }
      data.set(key, complex ? { kind: "complex" } : { kind: "list", items });
      continue;
    }
    if (indent === 0) throw new YamlError(block[0].line, "하위 항목은 공백으로 들여쓰십시오.");
    const entries = new Map<string, Scalar>();
    let complex = false;
    for (let k = 0; k < block.length; k++) {
      const b = block[k];
      const lead = /^ */.exec(b.text)![0].length;
      if (lead > indent) {
        complex = true;
        continue;
      }
      if (lead < indent) throw new YamlError(b.line, "하위 항목의 들여쓰기가 맞지 않습니다.");
      const em = /^([A-Za-z0-9_.-]{1,64}):(?:\s+(.*))?$/.exec(b.text.slice(lead));
      if (!em) throw new YamlError(b.line, "\"키: 값\" 형식이 아닙니다.");
      if (entries.has(em[1])) throw new YamlError(b.line, `같은 키(${em[1]})가 두 번 있습니다.`);
      const v = (em[2] ?? "").trim();
      if (!v || v.startsWith("#") || v.startsWith("|") || v.startsWith(">") || v.startsWith("[")) {
        complex = true;
        continue;
      }
      entries.set(em[1], parseInlineScalar(v, b.line));
    }
    data.set(key, complex ? { kind: "complex" } : { kind: "map", entries });
  }
  return data;
}

function scalarString(node: YamlNode | undefined, key: string, line: number): string | null {
  if (!node || node.kind === "null") return null;
  if (node.kind !== "scalar") throw new YamlError(line, `${key}는 한 줄 문자열로 쓰십시오.`);
  if (!node.scalar.quoted && YAML_NON_STRING.test(node.scalar.value)) {
    throw new YamlError(line, `${key} 값이 숫자·참거짓으로 읽힙니다. 큰따옴표로 감싸십시오.`);
  }
  return node.scalar.value;
}

/** SKILL.md를 읽는다. BOM은 떼고 줄바꿈은 LF로 본다. 실패하면 message에 이유를 담는다. */
export function parseSkillMd(
  text: string,
): { ok: true; frontmatter: SkillFrontmatter; body: string } | { ok: false; message: string; hint?: string } {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!src.startsWith("---\n")) {
    return { ok: false, message: "SKILL.md는 첫 줄이 ---로 시작하는 앞부분(frontmatter)이 있어야 합니다.", hint: "---, name, description, license, --- 순서로 적으십시오." };
  }
  const end = src.indexOf("\n---", 3);
  const close = end >= 0 ? src.indexOf("\n", end + 1) : -1;
  const closeLine = end >= 0 ? src.slice(end + 1, close < 0 ? undefined : close) : "";
  if (end < 0 || closeLine !== "---") {
    return { ok: false, message: "SKILL.md 앞부분을 닫는 --- 줄이 없습니다." };
  }
  const yaml = src.slice(4, end);
  const body = close < 0 ? "" : src.slice(close + 1);
  let data: Map<string, YamlNode>;
  try {
    data = parseYamlSubset(yaml);
  } catch (err) {
    if (err instanceof YamlError) return { ok: false, message: `SKILL.md 앞부분 ${err.line + 1}번째 줄: ${err.message}` };
    throw err;
  }
  const lineOf = (key: string) => yaml.split("\n").findIndex((l) => l.startsWith(`${key}:`)) + 2;
  try {
    const name = scalarString(data.get("name"), "name", lineOf("name"));
    const description = scalarString(data.get("description"), "description", lineOf("description"));
    const license = scalarString(data.get("license"), "license", lineOf("license"));
    const compNode = data.get("compatibility");
    const compatibility =
      compNode?.kind === "list" ? compNode.items.map((s) => s.value).join(", ") : scalarString(compNode, "compatibility", lineOf("compatibility"));
    const toolsNode = data.get("allowed-tools");
    let allowedTools: string[] = [];
    if (toolsNode?.kind === "list") allowedTools = toolsNode.items.map((s) => s.value.trim()).filter(Boolean);
    else if (toolsNode?.kind === "scalar") allowedTools = toolsNode.scalar.value.match(/[A-Za-z_][\w.-]*(?:\([^)]*\))?/g) ?? [];
    else if (toolsNode?.kind === "complex") {
      return { ok: false, message: "allowed-tools는 공백으로 구분한 한 줄 문자열이나 단순 목록으로 쓰십시오." };
    }
    const metaNode = data.get("metadata");
    const metadata: Record<string, string> = {};
    if (metaNode?.kind === "map") for (const [k, v] of metaNode.entries) metadata[k] = v.value;
    else if (metaNode && metaNode.kind !== "null") {
      return { ok: false, message: "metadata는 \"키: 값\" 한 줄짜리 항목만 들여써서 적으십시오." };
    }
    if (!name) return { ok: false, message: "SKILL.md 앞부분에 name이 없습니다." };
    if (description === null || !description.trim()) return { ok: false, message: "SKILL.md 앞부분에 description이 없습니다." };
    if (!license || !license.trim()) {
      return { ok: false, message: "SKILL.md 앞부분에 license가 없습니다. 허브에 게시하려면 라이선스를 적어야 합니다.", hint: "예: license: CC-BY-4.0" };
    }
    return {
      ok: true,
      frontmatter: {
        name,
        description: description.trim(),
        license: license.trim(),
        compatibility: compatibility?.trim() || null,
        allowedTools,
        metadata,
        hooks: data.has("hooks"),
        keys: [...data.keys()],
      },
      body,
    };
  } catch (err) {
    if (err instanceof YamlError) return { ok: false, message: `SKILL.md 앞부분 ${err.line}번째 줄: ${err.message}` };
    throw err;
  }
}

/* ---------- 파일 준비·검증 ---------- */

interface PreparedFile {
  path: string;
  bytes: Uint8Array;
  text: string | null; // UTF-8로 읽을 수 없거나 NUL이 있으면 null(바이너리)
}

function ext(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 경로 규칙(사이트 업로드와 같은 기준 + 설치 대상 OS에서 문제가 되는 문자 거부). 문제가 없으면 null. */
export function checkSkillPath(p: string): string | null {
  if (!p) return "빈 경로가 있습니다.";
  if (p.length > SKILL_LIMITS.pathLength) return `경로가 ${SKILL_LIMITS.pathLength}자를 넘습니다.`;
  if (/[\u0000-\u001f\u007f]/.test(p)) return "경로에 제어 문자가 있습니다.";
  if (p.includes("\\")) return "경로 구분자는 /만 쓸 수 있습니다.";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "절대 경로는 쓸 수 없습니다.";
  if (/[?#%:*"<>|]/.test(p)) return "경로에 쓸 수 없는 문자(? # % : * \" < > |)가 있습니다.";
  const segs = p.split("/");
  if (segs.length > SKILL_LIMITS.pathDepth) return `폴더 깊이는 ${SKILL_LIMITS.pathDepth}단계까지입니다.`;
  // skills CLI의 구 형식 설치는 ".."이 들어간 경로가 하나라도 있으면 목록 전체를 버린다.
  if (p.includes("..")) return "경로에 ..을 쓸 수 없습니다.";
  for (const s of segs) {
    if (!s) return "경로에 빈 폴더 이름(//)이 있습니다.";
    if (s === ".") return "경로에 .을 쓸 수 없습니다.";
    if (s.startsWith(".")) return "점(.)으로 시작하는 파일·폴더(.env, .git 등)는 올릴 수 없습니다.";
    if (s.endsWith(" ") || s.endsWith(".")) return "파일·폴더 이름이 공백이나 점으로 끝나면 안 됩니다.";
  }
  return null;
}

function prepareFiles(
  input: SkillInputFile[],
  folder: string | undefined,
): { ok: true; files: PreparedFile[]; folder: string | null } | { ok: false; message: string; hint?: string } {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, message: "올린 파일이 없습니다.", hint: "SKILL.md가 든 스킬 폴더를 올리십시오." };
  if (input.length > SKILL_LIMITS.fileCount) {
    return { ok: false, message: `파일은 ${SKILL_LIMITS.fileCount}개까지 올릴 수 있습니다(현재 ${input.length}개).` };
  }
  let paths = input.map((f) => (typeof f.path === "string" ? f.path.normalize("NFC") : ""));
  let folderName: string | null = folder?.trim() ? folder.trim().normalize("NFC") : null;
  // 폴더째 올린 경우(모든 파일이 "<폴더>/..."이고 루트 SKILL.md가 없음): 폴더 이름을 떼어 낸다.
  if (!paths.includes("SKILL.md")) {
    const tops = new Set(paths.map((p) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : "")));
    const [top] = [...tops];
    if (tops.size === 1 && top && paths.includes(`${top}/SKILL.md`)) {
      paths = paths.map((p) => p.slice(top.length + 1));
      folderName = folderName ?? top;
    }
  }
  const seen = new Set<string>();
  const files: PreparedFile[] = [];
  let total = 0;
  for (let i = 0; i < input.length; i++) {
    const p = paths[i];
    const bad = checkSkillPath(p);
    if (bad) return { ok: false, message: `${bad}`, hint: `파일: ${p.slice(0, 120)}` };
    if (seen.has(p)) return { ok: false, message: "같은 경로의 파일이 두 번 있습니다.", hint: `파일: ${p}` };
    seen.add(p);
    const bytes = input[i].bytes;
    if (!(bytes instanceof Uint8Array)) return { ok: false, message: "파일 내용을 읽을 수 없습니다.", hint: `파일: ${p}` };
    if (bytes.byteLength > SKILL_LIMITS.fileBytes) {
      return { ok: false, message: "파일 하나는 2MB까지 올릴 수 있습니다.", hint: `파일: ${p}` };
    }
    total += bytes.byteLength;
    if (total > SKILL_LIMITS.totalBytes) return { ok: false, message: "스킬 전체 크기는 10MB까지입니다." };
    const e = ext(p);
    if (FORBIDDEN_EXT.has(e)) {
      return { ok: false, message: "실행 파일이나 압축 파일은 스킬에 넣을 수 없습니다.", hint: `파일: ${p}` };
    }
    const text = decodeText(bytes);
    if (text === null && !p.startsWith("assets/")) {
      return { ok: false, message: "바이너리 파일(이미지 등)은 assets/ 폴더 안에만 둘 수 있습니다.", hint: `파일: ${p}` };
    }
    files.push({ path: p, bytes, text });
  }
  if (!seen.has("SKILL.md")) {
    const lower = [...seen].find((p) => p.toLowerCase() === "skill.md");
    return {
      ok: false,
      message: lower ? "파일 이름은 대문자 SKILL.md여야 합니다." : "스킬 폴더 맨 위에 SKILL.md가 없습니다.",
      hint: lower ? `파일: ${lower}` : undefined,
    };
  }
  const skillMd = files.find((f) => f.path === "SKILL.md")!;
  if (skillMd.text === null) return { ok: false, message: "SKILL.md는 UTF-8 텍스트 파일이어야 합니다." };
  // BOM이 있으면 skills CLI가 앞부분을 읽지 못한다. 떼어 내고 저장한다.
  if (skillMd.bytes[0] === 0xef && skillMd.bytes[1] === 0xbb && skillMd.bytes[2] === 0xbf) {
    skillMd.bytes = skillMd.bytes.slice(3);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, files, folder: folderName };
}

/* ---------- 정적 안전 검토 (F-40) ---------- */

interface LineRule {
  rule: string;
  severity: "review" | "block";
  re: RegExp;
  message: string;
  mdOnly?: boolean;
  script?: boolean; // 해당하면 스크립트 포함으로 본다
  /** 줄 전체가 "읽거나 출력하지 말라"는 부정 문장이면 이 참고(info) 문구로 낮춘다. 언급만 잡는 규칙에만 둔다. */
  negatedMessage?: string;
}

const LINE_RULES: LineRule[] = [
  {
    rule: "pipe-to-shell",
    severity: "review",
    re: /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]{0,400}?\|\s*(?:sudo\s+)?(?:(?:ba|z|da|k|fi)?sh|python3?|node|perl|ruby|iex|Invoke-Expression|pwsh|powershell)\b|\b(?:ba|z)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)|\bsource\s+<\(\s*(?:curl|wget)|\beval\s+["']?\$\(\s*(?:curl|wget)/i,
    message: "내려받은 내용을 바로 셸로 실행합니다(curl | sh 형태).",
    script: true,
  },
  {
    rule: "obfuscation",
    severity: "review",
    re: /\bbase64\s+(?:-d|--decode|-D)\b|\bFromBase64String\b|\batob\s*\(|Buffer\.from\([^)\n]{0,200},\s*["']base64["']\)|\bb64decode\b|\bbytes\.fromhex\b|\\x[0-9a-fA-F]{2}(?:\\x[0-9a-fA-F]{2}){15,}/i,
    message: "base64·16진수로 숨긴 내용을 풀어 씁니다.",
  },
  {
    rule: "dynamic-exec",
    severity: "review",
    re: /\beval\s*\(|new\s+Function\s*\(|\bexec\s*\(\s*(?:compile|base64|atob|bytes|__import__)|\bInvoke-Expression\b|\biex\s*\(/,
    message: "문자열을 코드로 바꿔 실행합니다(eval 등).",
  },
  {
    // 뒷부분은 Dandi CLI 로그인 정보(~/.dandi/config.json, %USERPROFILE%\.dandi, DANDI_TOKEN)와 Dandi 토큰·키 이름이다.
    // 값이 없는 언급(dd_cli_ 등)도 토큰을 찾아 보여 달라는 지시일 수 있으므로 관리자가 확인한다(값이 있으면 secret 규칙이 막는다).
    rule: "credential-read",
    severity: "review",
    re: /~\/\.(?:ssh|aws|gnupg|kube|docker|netrc|npmrc|pypirc|git-credentials|config\/gh)\b|\.ssh\/(?:id_|authorized_keys)|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\.aws\/credentials|\$HOME\/\.(?:ssh|aws|netrc)|USERPROFILE%?[\\/]\.(?:ssh|aws)|\/etc\/(?:passwd|shadow)\b|Login Data|cookies\.sqlite|\bsecurity\s+find-(?:generic|internet)-password\b|\bkeychain\b|(?<![\w.-])\.dandi(?![\w.-])|\bDANDI_(?:TOKEN|CONFIG_DIR)\b|\bdd_(?:cli|sk|mat|mrt|dev)_/i,
    message:
      "Dandi 인증 정보(~/.dandi, DANDI_TOKEN, dd_ 토큰)나 SSH·클라우드 로그인 정보를 언급합니다. 읽거나 출력하라는 지시인지 확인하십시오.",
    negatedMessage:
      "Dandi 인증 정보나 SSH·클라우드 로그인 정보를 언급하지만, 읽거나 출력하지 말라는 안내로 보입니다(참고).",
  },
  {
    rule: "env-read",
    severity: "review",
    re: /\b(?:cat|type|less|more|head|tail|source|grep|Get-Content|gc)\b[^\n|;&]{0,80}?[\s/"']\.env(?:\.[\w-]+)?\b|(?:readFile(?:Sync)?|open)\s*\(\s*["'`][^"'`\n]{0,80}\.env(?:\.[\w-]+)?["'`]|\bprintenv\b|\b(?:env|set)\s*\|\s*(?:curl|nc|ncat)\b/i,
    message: ".env 파일이나 환경변수 전체를 읽습니다.",
  },
  {
    // 명령 형태가 아닌 평범한 문장("Read the .env file and print ...", ".env 파일을 열어 키를 보여 줘")도 잡는다.
    // .env·.env.local 같은 파일 이름이나 "env file"·"환경변수 파일"을 언급하면 읽기·출력 지시인지 관리자가 확인한다.
    // process.env·import.meta.env처럼 앞에 글자가 붙은 코드는 제외한다.
    rule: "env-file",
    severity: "review",
    re: /(?<![\w.$-])\.env(?:\.[\w-]+)?(?![\w-])|\b(?:dot)?env\s+files?\b|환경\s?변수\s?파일/i,
    message: ".env 파일(비밀값을 두는 환경변수 파일)을 언급합니다. 읽거나 출력하라는 지시인지 확인하십시오.",
    negatedMessage: ".env 파일을 언급하지만, 읽거나 출력·커밋하지 말라는 안내로 보입니다(참고).",
  },
  {
    rule: "exfiltration",
    severity: "review",
    re: /\bcurl\b[^\n]{0,300}?\s(?:-d|--data(?:-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file)(?:\s|=)|\bwget\b[^\n]{0,300}?--post-(?:data|file)\b|\b(?:nc|ncat|netcat)\s+(?:-[a-z]+\s+)*[\w.-]+\s+\d{2,5}\b|\/dev\/tcp\/|Invoke-(?:WebRequest|RestMethod)\b[^\n]{0,300}?-Method\s+Post|discord(?:app)?\.com\/api\/webhooks|hooks\.slack\.com|webhook\.site|requestbin|pipedream\.net|ngrok(?:-free)?\.(?:io|app)|pastebin\.com|transfer\.sh|interact\.sh|burpcollaborator|\boast\.(?:fun|me|site|live|pro)\b/i,
    message: "외부 서버로 데이터를 보낼 수 있는 명령이나 주소가 있습니다.",
  },
  {
    rule: "destructive",
    severity: "review",
    re: /\brm\s+-[a-zA-Z]*(?:rf|fr)[a-zA-Z]*\s+(?:\/|~|\$HOME|\*)(?:\s|$|\/)|\bsudo\s|\bchmod\s+(?:-R\s+)?777\b|\bmkfs\b|\bdd\s+if=|Remove-Item\b[^\n]{0,120}-Recurse[^\n]{0,60}-Force|\bformat\s+[a-zA-Z]:|\breg\s+(?:add|delete)\b|\bcrontab\s|\bschtasks\b/i,
    message: "시스템 설정을 바꾸거나 파일을 지우는 명령이 있습니다.",
  },
  {
    rule: "prompt-injection",
    severity: "review",
    re: /ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions|prompts|rules)|disregard (?:the |all |any )?(?:previous|prior|system) (?:instructions|prompt|rules)|이전 지시(?:사항)?(?:을|를)?\s?(?:모두\s)?무시|시스템 프롬프트(?:를|을)?\s?(?:무시|출력|공개)|(?:do not|don't) (?:tell|inform|show) the user|사용자(?:에게|가)?\s?(?:모르게|알리지)/i,
    message: "AI에게 기존 지시를 무시하거나 사용자 모르게 행동하라는 문장이 있습니다.",
  },
  {
    rule: "bang-command",
    severity: "review",
    re: /!`[^`\n]{1,300}`/,
    message: "SKILL.md를 불러올 때 셸 명령을 실행하는 !`명령` 문법이 있습니다.",
    mdOnly: true,
    script: true,
  },
  {
    rule: "hidden-unicode",
    severity: "review",
    re: /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|\uDB40[\uDC00-\uDC7F]/,
    message: "눈에 보이지 않는 유니코드 문자(방향 바꿈·폭 없는 문자 등)가 있습니다.",
  },
  {
    rule: "long-base64",
    severity: "review",
    re: /[A-Za-z0-9+/]{400,}={0,2}/,
    message: "읽을 수 없는 긴 base64 덩어리가 있습니다.",
  },
];

/* ---------- 부정 문장 판정(언급형 규칙용) ----------
   "~/.dandi/ 폴더나 .env 파일을 출력·커밋하지 마십시오", "Never print, commit or upload ~/.dandi/"처럼
   읽지·출력하지 말라는 안전 안내는 참고(info)로만 적는다. 다음을 모두 만족할 때만 부정 문장으로 본다.
   애매하면 부정으로 보지 않는다(관리자 검토로 남는다).
   1) 줄 안의 읽기·출력·전송 동사가 하나도 빠짐없이 부정되어 있다
      (영어: never·don't·do not 등이 동사 나열 바로 앞, 한국어: 동사 나열 바로 뒤에 "~지 마·않·말 것·금지·면 안 됨").
   2) 부정된 동사가 하나 이상 있다.
   3) 줄에 반대·순서 접속어(but, instead, then, 대신, 하지만, 말고, 않고 등)가 없다.
   4) 다음 줄이 반대 접속어로 시작하거나, "그 파일·it"을 부정 없이 보여 달라고 이어 가지 않는다. */

const V_SUFFIX_EN = "(?:s|es|e?d|ing|[tpg](?:ing|ed))?";
/** 읽기·출력·전송 동사(영어). 줄에 이 동사가 부정되지 않은 채 있으면 부정 문장이 아니다. */
const EN_DISCLOSE =
  "read|open|print(?:\\s+out)?|show|shown|display|output|echo|cat|log|commit|push|upload|share|include|expose|send|sent|post|e-?mail|copy|paste|reveal|leak|disclose|transmit|access|dump|tell|told|give|gave|given|forward|attach|publish|view|inspect|extract|exfiltrate|transfer|submit|check\\s+in|look\\s+(?:at|inside|in)|type\\s+out|write\\s+out";
/** 저장·편집 동사(영어). 부정되지 않아도 되며, "print or store"처럼 동사 나열을 잇는 데 쓴다. */
const EN_NEUTRAL = "use|store|save|keep|kept|put|place|add|write|wrote|written|hard-?code|embed|edit|modify|touch|change|rename|move|delete|remove|create|leave|left";
/** 읽기·출력·전송 동사(한국어). 한자어·외래어("공개 저장소"의 공개)는 뒤에 하다·되다·나열·금지가 올 때만 동사로 본다. */
const KO_DISCLOSE =
  "(?:출력|표시|커밋|푸시|업로드|공유|포함|노출|공개|전송|복사|전달|첨부|게시|유출|캡처|조회|기록|열람)" +
  "(?=\\s?(?:하|해|한|할|함|했|되|돼|된|될|됨|시키|[·,/]|이나|나\\s|또는|및|혹은|(?:을|를)?\\s?금지))" +
  "|읽|열(?=[지거어고면기])|보여\\s?(?:주|드리)|보이|올리|올려|보내|붙여\\s?넣|말해\\s?(?:주|드리)|알려\\s?(?:주|드리)|알리|내보내|꺼내|넘겨|가져(?:오|가)|적어\\s?주";
/** 저장·편집 동사(한국어 어간). */
const KO_NEUTRAL = "넣|저장|보관|입력|수정|편집|건드리|건드려|만지|사용|삭제|옮기|옮겨|하드코딩|남기|두|적|쓰";
const ANY_VERB = `${KO_DISCLOSE}|${KO_NEUTRAL}|\\b(?:${EN_DISCLOSE}|${EN_NEUTRAL})${V_SUFFIX_EN}\\b`;
/** 동사 찾기. 1번 묶음은 영어 읽기·출력 동사, 2번 묶음은 한국어 읽기·출력 동사다. */
const VERB_RE = new RegExp(`\\b(?:(${EN_DISCLOSE})|(?:${EN_NEUTRAL}))${V_SUFFIX_EN}\\b|(${KO_DISCLOSE})|(?:${KO_NEUTRAL})`, "gi");
/** 영어 부정어. 이 뒤에 동사 나열만 오면 그 동사들은 부정된 것이다. */
const EN_NEG_RE =
  /\b(?:never|don['’]?t|do\s+not|does\s+not|doesn['’]?t|must\s+not|mustn['’]?t|should\s+not|shouldn['’]?t|cannot|can['’]?t|can\s+not|may\s+not|will\s+not|won['’]?t|avoid|not\s+to|nor)\b/gi;
/** 부정어와 동사 사이에 올 수 있는 것: 공백·쉼표·접속사·부사·다른 동사(나열). 목적어나 다른 말이 끼면 부정으로 보지 않는다. */
const EN_BETWEEN_RE = new RegExp(
  `^(?:[\\s,/]|\\b(?:or|and|nor|ever|even|accidentally|directly|yourself|in\\s+any\\s+way)\\b|\\b(?:${EN_DISCLOSE}|${EN_NEUTRAL})${V_SUFFIX_EN}\\b)*$`,
  "i",
);
/** 한국어: 동사 뒤에 (다른 동사 나열) + "~지 마·말 것·않·못", "~면·서는 안 됨", "금지"가 바로 온다. "말고·않고"는 부정이 아니다. */
// 반복 묶음 안에서 공백·"하"를 먹는 자리가 겹치지 않게 써서(한 글자를 두 방법으로 읽지 않게) 역추적이 폭발하지 않게 한다.
const KO_NEG_AFTER_RE = new RegExp(
  `^(?:하|해)?(?:\\s*(?:[·,/]|거나|이나|또는|및|혹은|나)\\s*(?:${ANY_VERB})(?:\\s*(?:하|해))?)*\\s*` +
    `(?:(?:하|해|시키|되)?\\s?(?:지는|지|진)\\s?(?:마|말(?!고)|않(?!고|으면)|못(?!하고))|(?:하|해|되)?(?:어|아|여)?(?:서는|선|면)\\s?안\\s?(?:됩|돼|되|된|됨)|(?:을|를|은|는)?\\s?금지)`,
  "i",
);
const CONTRAST_RE =
  /\b(?:but|instead|however|unless|except|rather|otherwise|though|although|then|yet|just)\b|대신|하지만|그러나|그런데|그렇지만|다만|말고|않고|지만|그\s?다음|그\s?후|나서|뒤에|후에|단,/i;
const LEADING_CONTRAST_RE =
  /^\s*(?:[-*+>]\s*|\d+[.)]\s*)?(?:but|instead|however|then|otherwise|rather|and|대신|하지만|그러나|그런데|그렇지만|다만|그리고|그\s?다음|그\s?후)/i;
/** 앞줄의 파일·토큰을 가리키는 말. 다음 줄이 이것을 부정 없이 보여 달라고 하면 앞줄의 부정을 믿지 않는다. */
const ANAPHORA_RE =
  /\b(?:it|its|them|those|the\s+(?:file|token|contents?|key|value|secret|config|folder)s?)\b|그\s?(?:파일|것|걸|내용|값|토큰|키|폴더)|그것|그대로|해당|위\s?(?:파일|내용|값|토큰)|이\s?(?:파일|값|토큰|키)/i;
const NEGATION_LINE_MAX = 400;

interface VerbUse {
  disclose: boolean;
  negated: boolean;
}

function verbUses(line: string): VerbUse[] {
  const out: VerbUse[] = [];
  const negEnds: number[] = [];
  for (const m of line.matchAll(EN_NEG_RE)) negEnds.push(m.index + m[0].length);
  for (const m of line.matchAll(VERB_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[0].length === 0) continue;
    const enNeg = negEnds.some((e) => e <= start && start - e <= 80 && EN_BETWEEN_RE.test(line.slice(e, start)));
    const koNeg = KO_NEG_AFTER_RE.test(line.slice(end, end + 120));
    out.push({ disclose: Boolean(m[1] || m[2]), negated: enNeg || koNeg });
  }
  return out;
}

/**
 * 줄 전체가 "읽거나 출력하지 말라"는 부정 문장인지 본다(credential-read·env-file 규칙을 참고로 낮출 때만 쓴다).
 * next는 그 뒤의 빈 줄이 아닌 첫 줄이다.
 */
export function isNegatedSafetyLine(line: string, next = ""): boolean {
  if (!line || line.length > NEGATION_LINE_MAX) return false;
  if (CONTRAST_RE.test(line)) return false;
  const uses = verbUses(line);
  if (!uses.some((u) => u.negated)) return false;
  if (uses.some((u) => u.disclose && !u.negated)) return false;
  if (next) {
    if (LEADING_CONTRAST_RE.test(next)) return false;
    if (next.length > NEGATION_LINE_MAX) return false;
    if (ANAPHORA_RE.test(next) && verbUses(next).some((u) => u.disclose && !u.negated)) return false;
  }
  return true;
}

// 비밀값: 발견하면 게시를 거부한다. 메시지에 값 자체는 넣지 않는다.
const SECRET_RULES: { re: RegExp; label: string }[] = [
  { re: /\bdd_(?:cli|sk|mat|mrt|dev|pk)_[A-Za-z0-9_-]{16,}/, label: "Dandi 토큰·키" },
  { re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, label: "AI API 키" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS 접근 키" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{22,}/, label: "GitHub 토큰" },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, label: "Slack 토큰" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, label: "Google API 키" },
  { re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, label: "개인 키" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, label: "JWT(서비스 키 등)" },
  { re: /\b(?:hf_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{10,}|npm_[A-Za-z0-9]{36})\b/, label: "서비스 토큰" },
];

// 문서 예시용 도메인의 이메일은 개인정보로 보지 않는다.
const EXAMPLE_EMAIL = /@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|[\w-]+\.(?:example|test|invalid|localhost))$/i;

const BROAD_SHELL_TOOL =
  /^(?:Bash|Shell|PowerShell|Terminal|Bash\(\s*\*?\s*(?::\s*\*\s*)?\)|Bash\(\s*(?:sh|bash|zsh|pwsh|powershell|cmd|sudo|curl|wget|rm|python3?|node|npx|npm|pip3?|eval|exec|env)(?:\s*:\s*\*|\s+\*|\s*\*)\s*\))$/i;

export interface SkillAnalysis {
  frontmatter: SkillFrontmatter;
  findings: SkillFinding[];
  hasScripts: boolean;
}

/** 정적 안전 검토. 파일 준비(prepareFiles)를 통과한 목록을 받는다. */
function analyzeSkill(files: PreparedFile[], frontmatter: SkillFrontmatter, skillMdBody: string): SkillAnalysis {
  const findings: SkillFinding[] = [];
  let hasScripts = false;
  const add = (f: SkillFinding) => {
    if (findings.length < 200) findings.push(f);
  };

  // 앞부분: 훅, allowed-tools
  if (frontmatter.hooks) {
    hasScripts = true;
    add({ severity: "review", rule: "hooks", path: "SKILL.md", message: "hooks 설정이 있습니다. 도구 사용 전후에 명령을 자동 실행할 수 있습니다." });
  }
  for (const tool of frontmatter.allowedTools) {
    if (BROAD_SHELL_TOOL.test(tool.replace(/\s+/g, " ").trim())) {
      add({ severity: "review", rule: "broad-shell", path: "SKILL.md", message: `allowed-tools가 셸 명령을 넓게 허용합니다(${tool.slice(0, 60)}).` });
    } else if (/^(?:Bash|PowerShell)\(/i.test(tool)) {
      add({ severity: "info", rule: "shell-tool", path: "SKILL.md", message: `allowed-tools가 일부 셸 명령을 미리 허용합니다(${tool.slice(0, 60)}).` });
    }
  }
  const skillMdLines = skillMdBody.split("\n").length;
  if (skillMdLines > SKILL_MD_LINES_RECOMMENDED) {
    add({ severity: "info", rule: "long-skill-md", path: "SKILL.md", message: `SKILL.md 본문이 ${SKILL_MD_LINES_RECOMMENDED}줄을 넘습니다. 긴 내용은 references/ 파일로 나누기를 권장합니다.` });
  }

  for (const f of files) {
    const e = ext(f.path);
    const segs = f.path.split("/");
    // 경로 자체의 개인정보(예: 연락처로 된 파일 이름)
    for (const m of scanPII(f.path)) {
      if (m.type === "email" && EXAMPLE_EMAIL.test(m.value)) continue;
      add({ severity: "block", rule: "pii", path: f.path, message: `파일 경로에 개인정보(${m.label})로 보이는 값이 있습니다.` });
    }
    if (segs[0] === "scripts") hasScripts = true;
    if (segs.includes("hooks") || segs[segs.length - 1] === "hooks.json") {
      hasScripts = true;
      add({ severity: "review", rule: "hooks", path: f.path, message: "훅(hooks) 파일이 있습니다." });
    }
    if (SCRIPT_EXT.has(e)) hasScripts = true;
    if (f.text === null) {
      add({ severity: "review", rule: "binary", path: f.path, message: "바이너리 파일은 자동 검사를 할 수 없어 관리자가 확인합니다." });
      continue;
    }
    if (f.text.startsWith("#!")) hasScripts = true;
    const isMd = e === "md" || e === "markdown" || e === "";
    const lines = f.text.split("\n");
    const hitRules = new Set<string>();
    // 부정 문장이라 참고로만 적은 규칙. 같은 파일의 다른 줄이 부정 없이 걸리면 그때 검토 항목을 따로 적는다.
    const infoRules = new Set<string>();
    const nextLine = (li: number): string => {
      for (let j = li + 1; j < lines.length && j <= li + 3; j++) if (lines[j].trim()) return lines[j];
      return "";
    };
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (!line) continue;
      const lineNo = li + 1;
      for (const s of SECRET_RULES) {
        if (s.re.test(line)) add({ severity: "block", rule: "secret", path: f.path, line: lineNo, message: `비밀값(${s.label})으로 보이는 값이 있습니다.` });
      }
      let negated: boolean | null = null;
      for (const r of LINE_RULES) {
        if (r.mdOnly && !isMd) continue;
        if (hitRules.has(r.rule)) continue; // 같은 파일에서 같은 규칙은 한 번만 적는다
        if (r.rule === "hidden-unicode" && li === 0 && line.charCodeAt(0) === 0xfeff && !r.re.test(line.slice(1))) continue;
        if (r.re.test(line)) {
          if (r.negatedMessage && (negated ??= isNegatedSafetyLine(line, nextLine(li)))) {
            // "읽거나 출력하지 마십시오" 같은 안전 안내: 참고로만 적고 검토를 요구하지 않는다.
            if (!infoRules.has(r.rule)) {
              infoRules.add(r.rule);
              add({ severity: "info", rule: r.rule, path: f.path, line: lineNo, message: r.negatedMessage });
            }
            continue;
          }
          hitRules.add(r.rule);
          if (r.script) hasScripts = true;
          add({ severity: r.severity, rule: r.rule, path: f.path, line: lineNo, message: r.message });
        }
      }
    }
    // 학생 개인정보(F-13 규칙). 값은 적지 않고 종류와 위치만 남긴다.
    for (const m of scanPII(f.text)) {
      if (m.type === "email" && EXAMPLE_EMAIL.test(m.value)) continue;
      const lineNo = f.text.slice(0, m.index).split("\n").length;
      add({ severity: "block", rule: "pii", path: f.path, line: lineNo, message: `개인정보(${m.label})로 보이는 값이 있습니다.` });
    }
  }
  if (hasScripts) {
    add({ severity: "review", rule: "has-scripts", path: "", message: "스크립트·훅·셸 실행이 포함되어 있어 관리자 검토 후 공개됩니다." });
  }
  return { frontmatter, findings, hasScripts };
}

export function formatFinding(f: SkillFinding): string {
  const tag = f.severity === "block" ? "차단" : f.severity === "review" ? "검토" : "참고";
  const where = f.path ? `${f.path}${f.line ? `:${f.line}` : ""} ` : "";
  return `[${tag}] ${where}${f.message}`;
}

/* ---------- 메타데이터 ---------- */

function parseLevels(values: string[] | undefined, fallback: string | undefined): SchoolLevel[] {
  const list = values && values.length > 0 ? values : (fallback ?? "").split(/[\s,]+/);
  return [...new Set(list.map((v) => v.trim()).filter(isSchoolLevel))];
}

function parseCompatibility(values: string[] | undefined, text: string | null): string[] {
  if (values && values.length > 0) {
    const ids = [...new Set(values.filter(isSkillTool))];
    if (ids.length > 0) return ids;
  }
  if (text) {
    const lower = text.toLowerCase();
    const ids: string[] = [];
    if (/claude[\s-]?code/.test(lower)) ids.push("claude-code");
    if (/\bcursor\b/.test(lower)) ids.push("cursor");
    if (/\bcodex\b/.test(lower)) ids.push("codex");
    if (ids.length > 0) return ids;
  }
  // Agent Skills 표준 형식이므로 기본은 세 도구 모두
  return SKILL_TOOLS.map((t) => t.id);
}

/* ---------- 게시 (F-38) ---------- */

/**
 * 스킬 게시. files는 스킬 폴더 기준 상대 경로(또는 "<폴더>/..." 형태)와 원본 바이트다.
 * 비밀값·개인정보가 있으면 422로 거부하고 아무것도 저장하지 않는다.
 */
export async function publishSkill(
  user: User,
  files: SkillInputFile[],
  meta: PublishSkillMeta = {},
): Promise<SkillResult<PublishSkillOutput>> {
  if (!isTeacher(user)) return fail(403, "forbidden", "교사·관리자 계정만 스킬을 게시할 수 있습니다.");
  const prepared = prepareFiles(files, meta.folder);
  if (!prepared.ok) return fail(422, "invalid_skill", prepared.message, prepared.hint);

  const skillMdFile = prepared.files.find((f) => f.path === "SKILL.md")!;
  const parsed = parseSkillMd(skillMdFile.text!);
  if (!parsed.ok) return fail(422, "invalid_skill", parsed.message, parsed.hint);
  const fm = parsed.frontmatter;

  if (fm.name.length > 64 || !NAME_RE.test(fm.name)) {
    return fail(422, "invalid_skill", "name은 영어 소문자·숫자·하이픈(-)만 64자 이내로 쓰고, 하이픈으로 시작·끝나거나 두 번 이어 쓸 수 없습니다.", "한국어 제목은 metadata의 title에 적으십시오.");
  }
  if (RESERVED_NAMES.has(fm.name)) return fail(422, "invalid_skill", `${fm.name}은(는) 허브에서 쓰는 이름이라 스킬 이름으로 쓸 수 없습니다.`);
  if (prepared.folder !== null && prepared.folder !== fm.name) {
    return fail(422, "invalid_skill", "SKILL.md의 name과 폴더 이름이 같아야 합니다.", `폴더 이름: ${prepared.folder.slice(0, 80)}, name: ${fm.name}`);
  }
  if (fm.description.length > DESCRIPTION_MAX) return fail(422, "invalid_skill", `description은 ${DESCRIPTION_MAX}자 이하로 쓰십시오(현재 ${fm.description.length}자).`);
  if (fm.license.length > LICENSE_MAX) return fail(422, "invalid_skill", `license는 ${LICENSE_MAX}자 이하로 쓰십시오.`);
  if (fm.compatibility && fm.compatibility.length > COMPATIBILITY_MAX) return fail(422, "invalid_skill", `compatibility는 ${COMPATIBILITY_MAX}자 이하로 쓰십시오.`);
  const requested = fm.metadata.version?.trim();
  if (requested && !parseSemver(requested)) {
    return fail(422, "invalid_skill", "metadata.version은 1.2.3 형식(semver)으로 쓰십시오.", "비워 두면 허브가 버전을 자동으로 올립니다.");
  }

  // 제목(자유 입력): 길이 확인 → 개인정보 마스킹
  const rawTitle = (meta.title?.trim() || fm.metadata.title?.trim() || fm.name).replace(/\s+/g, " ");
  if (rawTitle.length > TITLE_MAX) return fail(422, "invalid_skill", `제목은 ${TITLE_MAX}자 이하로 쓰십시오.`);
  const title = maskPII(rawTitle).text;
  const schoolLevels = parseLevels(meta.schoolLevels, fm.metadata["school-levels"] ?? fm.metadata.schoolLevels);
  const compatibility = parseCompatibility(meta.compatibility, fm.compatibility);

  const analysis = analyzeSkill(prepared.files, fm, parsed.body);
  const blocked = analysis.findings.filter((f) => f.severity === "block");
  if (blocked.length > 0) {
    const where = [...new Set(blocked.map((f) => `${f.path}${f.line ? `:${f.line}` : ""}`))].slice(0, 10).join(", ");
    return fail(
      422,
      "invalid_skill",
      "비밀값이나 학생 개인정보로 보이는 내용이 있어 게시할 수 없습니다. 해당 내용을 지운 뒤 다시 올리십시오.",
      `위치: ${where}`,
      blocked,
    );
  }
  const status: PublishSkillOutput["status"] =
    analysis.hasScripts || analysis.findings.some((f) => f.severity === "review") ? "pending_review" : "approved";

  // 본문 저장(내용 주소). 같은 내용은 한 번만 저장된다.
  const siteFiles: SiteFile[] = [];
  for (const f of prepared.files) {
    const sha256 = await storeBlob(f.bytes);
    siteFiles.push({ path: f.path, size: f.bytes.byteLength, sha256, contentType: contentTypeFor(f.path, f.text !== null) });
  }
  const archive = buildSkillArchive(prepared.files.map((f) => ({ path: f.path, bytes: f.bytes })));
  const digest = `sha256:${await storeBlob(archive)}`;

  await ensureSeedSkills();
  const now = nowIso();
  return mutate((db): SkillResult<PublishSkillOutput> => {
    ensureUser(db, user);
    const existing = db.skills.find((s) => s.name === fm.name);
    if (existing && existing.authorId !== user.id && user.role !== "admin") {
      return fail(409, "name_taken", "다른 교사가 이미 게시한 스킬 이름입니다.", "SKILL.md의 name과 폴더 이름을 바꾸십시오.");
    }
    const same = existing?.versions.find((v) => v.digest === digest);
    if (same?.status === "rejected") {
      return fail(
        422,
        "invalid_skill",
        `같은 내용의 ${same.version} 버전이 관리자 검토에서 반려되었습니다. 반려 사유를 확인하고 고친 뒤 다시 올리십시오.`,
        `반려 사유는 /skills/${fm.name} 화면에서 볼 수 있습니다.`,
      );
    }
    if (same) {
      return {
        ok: true,
        value: {
          name: fm.name,
          version: same.version,
          status: same.status === "approved" ? "approved" : "pending_review",
          findings: analysis.findings,
          hasScripts: same.hasScripts,
          unchanged: true,
        },
      };
    }
    const top = existing ? maxVersion(existing.versions) : null;
    if (requested && top && compareSemver(requested, top) <= 0) {
      return fail(422, "invalid_skill", `이미 ${top} 버전이 있습니다. 게시한 버전은 바꿀 수 없으므로 더 높은 버전을 쓰십시오.`, `metadata.version을 ${bumpPatch(top)} 이상으로 올리거나 지우십시오(지우면 자동으로 올립니다).`);
    }
    const version = requested || (top ? bumpPatch(top) : "1.0.0");
    const entry: SkillVersion = {
      version,
      files: siteFiles,
      digest,
      hasScripts: analysis.hasScripts,
      findings: analysis.findings.map(formatFinding),
      status,
      reviewedByName: status === "approved" ? "자동 검토" : null,
      createdAt: now,
    };
    if (!existing) {
      db.skills.push({
        name: fm.name,
        title,
        description: maskPII(fm.description).text,
        license: fm.license,
        schoolLevels,
        compatibility,
        authorId: user.id,
        authorName: displayName(user),
        installs: 0,
        latestVersion: version,
        versions: [entry],
        createdAt: now,
        updatedAt: now,
      });
    } else {
      existing.versions.push(entry);
      existing.latestVersion = maxVersion(existing.versions) ?? version;
      existing.updatedAt = now;
      // 공개 정보는 승인된 버전 기준으로만 바꾼다(검토 대기 버전의 설명이 먼저 보이지 않게).
      const noPublic = !existing.versions.some((v) => v !== entry && v.status === "approved");
      if (status === "approved" || noPublic) {
        existing.title = title;
        existing.description = maskPII(fm.description).text;
        existing.license = fm.license;
        existing.schoolLevels = schoolLevels;
        existing.compatibility = compatibility;
      }
    }
    writeAudit(db, user, "skill.publish", `${fm.name}@${version}`, status === "approved" ? "자동 공개" : "검토 대기");
    return {
      ok: true,
      value: { name: fm.name, version, status, findings: analysis.findings, hasScripts: analysis.hasScripts, unchanged: false },
    };
  });
}

function contentTypeFor(p: string, isText: boolean): string {
  const e = ext(p);
  if (isText) return TEXT_TYPES[e] ?? "text/plain; charset=utf-8";
  return BINARY_TYPES[e] ?? "application/octet-stream";
}

/* ---------- 웹 업로드 보조: zip 풀기 ---------- */

/** 암호가 걸린 항목이 있는지 zip 중앙 디렉터리의 플래그로 확인한다. 구조를 읽을 수 없으면 true(거부). */
function zipHasEncryptedEntry(bytes: Uint8Array): boolean {
  if (bytes.length < 22) return true;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return true;
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return true;
    if (view.getUint16(offset + 8, true) & 0x1) return true;
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return false;
}

/**
 * 웹에서 올린 zip을 파일 목록으로 푼다(F-38 웹 zip 업로드).
 * 폴더 메타데이터(__MACOSX)와 점으로 시작하는 파일은 조용히 뺀다. 크기·개수 한도를 넘으면 오류.
 */
export function unzipSkillArchive(bytes: Uint8Array): { ok: true; files: SkillInputFile[]; skipped: number } | { ok: false; message: string } {
  if (bytes.byteLength > SKILL_LIMITS.totalBytes * 2) return { ok: false, message: "zip 파일이 너무 큽니다." };
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { ok: false, message: "zip 파일이 아닙니다." };
  if (zipHasEncryptedEntry(bytes)) return { ok: false, message: "암호가 걸린 zip은 올릴 수 없습니다." };
  let skipped = 0;
  let declared = 0;
  let count = 0;
  let tooBig = false;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        const name = file.name.replace(/\\/g, "/");
        if (name.endsWith("/")) return false;
        if (name.split("/").some((s) => s.startsWith(".") || s === "__MACOSX" || s === "node_modules")) {
          skipped++;
          return false;
        }
        count++;
        declared += file.originalSize;
        if (count > SKILL_LIMITS.fileCount || file.originalSize > SKILL_LIMITS.fileBytes || declared > SKILL_LIMITS.totalBytes) {
          tooBig = true;
          return false;
        }
        return true;
      },
    });
  } catch {
    return { ok: false, message: "zip 파일을 풀 수 없습니다. 다시 압축해 올리십시오." };
  }
  if (tooBig) return { ok: false, message: "zip 안의 파일이 너무 많거나 큽니다(파일당 2MB, 전체 10MB, 200개까지)." };
  const files = Object.entries(entries).map(([p, b]) => ({ path: p.replace(/\\/g, "/"), bytes: b }));
  return { ok: true, files, skipped };
}

/* ---------- 조회 (F-37) ---------- */

function summarize(skill: Skill, v: SkillVersion, hub?: string): SkillSummary {
  return {
    name: skill.name,
    title: skill.title,
    description: skill.description,
    license: skill.license,
    schoolLevels: skill.schoolLevels,
    compatibility: skill.compatibility,
    authorName: skill.authorName,
    installs: skill.installs,
    latestVersion: v.version,
    hasScripts: v.hasScripts,
    status: "approved",
    reviewedByName: v.reviewedByName,
    updatedAt: skill.updatedAt,
    ...(hub ? { installCommand: skillInstallCommand(hub, skill.name), url: `${hub}/skills/${skill.name}` } : {}),
  };
}

export type SkillSort = "installs" | "recent" | "name";

/** 공개(승인된 버전이 있는) 스킬 목록. q는 이름·제목·설명 검색. */
export async function listPublicSkills(
  q?: string,
  opts: { level?: SchoolLevel; tool?: string; sort?: SkillSort; hub?: string } = {},
): Promise<SkillSummary[]> {
  const query = (q ?? "").trim().toLowerCase().slice(0, 100);
  const skills = await loadSkills();
  const out: SkillSummary[] = [];
  for (const s of skills) {
    const v = currentVersion(s);
    if (!v) continue;
    if (query && ![s.name, s.title, s.description].some((t) => t.toLowerCase().includes(query))) continue;
    if (opts.level && s.schoolLevels.length > 0 && !s.schoolLevels.includes(opts.level)) continue;
    if (opts.tool && !s.compatibility.includes(opts.tool)) continue;
    out.push(summarize(s, v, opts.hub));
  }
  const sort = opts.sort ?? "installs";
  out.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "recent") return b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name);
    return b.installs - a.installs || b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name);
  });
  return out;
}

/** 저장소의 스킬 레코드(공개 여부와 무관). 화면에서 게시자·관리자 권한을 따질 때 쓴다. */
export async function getSkillRecord(name: string): Promise<Skill | null> {
  if (typeof name !== "string" || !NAME_RE.test(name)) return null;
  return (await loadSkills()).find((s) => s.name === name) ?? null;
}

/** 버전의 SKILL.md 본문. hub를 주면 설치할 때와 같은 내용(허브 주소를 넣은 템플릿)을 돌려준다. */
export async function readSkillMd(version: SkillVersion, hub?: string): Promise<string> {
  const rendered = await renderedVersion(version, hub);
  const renderedMd = rendered?.files.get("SKILL.md");
  if (renderedMd) return new TextDecoder().decode(renderedMd);
  const f = version.files.find((x) => x.path === "SKILL.md");
  const bytes = f ? await getBlob(f.sha256) : null;
  return bytes ? new TextDecoder().decode(bytes) : "";
}

/** 공개 스킬 상세(승인된 버전만). MCP·API가 쓴다. hub를 주면 설치 명령과 절대 주소를 넣는다. */
export async function getSkill(name: string, opts: { hub?: string } = {}): Promise<SkillDetail | null> {
  const skill = await getSkillRecord(name);
  const v = skill && currentVersion(skill);
  if (!skill || !v) return null;
  const archivePath = skillArchivePath(skill.name, v.version);
  const shown = await describeSkillVersion(v, opts.hub);
  const approved = skill.versions.filter((x) => x.status === "approved").sort((a, b) => compareSemver(b.version, a.version));
  const versions: SkillDetail["versions"] = [];
  for (const x of approved) {
    versions.push({
      version: x.version,
      digest: (await describeSkillVersion(x, opts.hub)).digest,
      hasScripts: x.hasScripts,
      createdAt: x.createdAt,
      archivePath: skillArchivePath(skill.name, x.version),
    });
  }
  return {
    ...summarize(skill, v, opts.hub),
    digest: shown.digest,
    files: shown.files,
    versions,
    archivePath,
    ...(opts.hub ? { archiveUrl: `${opts.hub}${archivePath}` } : {}),
    skillMd: await readSkillMd(v, opts.hub),
  };
}

/** 게시자·관리자 검토용: 버전의 파일 본문(텍스트만, 파일당 maxBytes까지). */
export async function readSkillVersionFiles(
  version: SkillVersion,
  maxBytes = 64 * 1024,
): Promise<{ path: string; size: number; text: string | null; truncated: boolean }[]> {
  const out: { path: string; size: number; text: string | null; truncated: boolean }[] = [];
  for (const f of version.files) {
    const bytes = await getBlob(f.sha256);
    const text = bytes ? decodeText(bytes.subarray(0, Math.min(bytes.byteLength, maxBytes))) : null;
    out.push({ path: f.path, size: f.size, text, truncated: !!bytes && bytes.byteLength > maxBytes });
  }
  return out;
}

/** 내가 게시한 스킬(모든 상태). */
export async function listMySkills(user: User): Promise<Skill[]> {
  const skills = await loadSkills();
  return skills.filter((s) => s.authorId === user.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/* ---------- 관리자 검토 (F-40) ---------- */

export interface PendingSkillVersion {
  skill: Skill;
  version: SkillVersion;
}

export async function listPendingSkillVersions(): Promise<PendingSkillVersion[]> {
  const skills = await loadSkills();
  const out: PendingSkillVersion[] = [];
  for (const skill of skills) for (const version of skill.versions) if (version.status === "pending_review") out.push({ skill, version });
  return out.sort((a, b) => a.version.createdAt.localeCompare(b.version.createdAt));
}

export async function listReviewedSkillVersions(limit = 20): Promise<PendingSkillVersion[]> {
  const skills = await loadSkills();
  const out: PendingSkillVersion[] = [];
  for (const skill of skills) {
    for (const version of skill.versions) {
      if ((version.status === "approved" || version.status === "rejected") && version.reviewedByName && version.reviewedByName !== "자동 검토") {
        out.push({ skill, version });
      }
    }
  }
  return out.sort((a, b) => b.version.createdAt.localeCompare(a.version.createdAt)).slice(0, limit);
}

/** 검토 대기 버전을 승인하거나 반려한다. 관리자만 쓸 수 있다. */
export async function reviewSkillVersion(
  actor: User,
  name: string,
  version: string,
  decision: "approve" | "reject",
  reason = "",
): Promise<SkillResult<SkillVersion>> {
  if (actor.role !== "admin") return fail(403, "forbidden", "교육청 관리자만 스킬을 검토할 수 있습니다.");
  const note = reason.replace(/\s+/g, " ").trim();
  if (note.length > 300) return fail(422, "invalid_review", "검토 의견은 300자 이하로 쓰십시오.");
  const maskedNote = maskPII(note).text;

  // 승인하면 공개 정보(설명 등)를 이 버전의 SKILL.md로 바꾼다. 파일 읽기는 잠금 밖에서 한다.
  const record = await getSkillRecord(name);
  const target = record?.versions.find((v) => v.version === version);
  if (!record || !target) return fail(404, "not_found", "스킬 버전을 찾을 수 없습니다.");
  const parsed = decision === "approve" ? parseSkillMd(await readSkillMd(target)) : null;

  return mutate((db): SkillResult<SkillVersion> => {
    const skill = db.skills.find((s) => s.name === name);
    const v = skill?.versions.find((x) => x.version === version);
    if (!skill || !v) return fail(404, "not_found", "스킬 버전을 찾을 수 없습니다.");
    if (v.status !== "pending_review") return fail(409, "not_pending", "검토 대기 상태인 버전이 아닙니다.");
    v.status = decision === "approve" ? "approved" : "rejected";
    v.reviewedByName = displayName(actor);
    if (maskedNote) v.findings.push(`[${decision === "approve" ? "승인 의견" : "반려 사유"}] ${maskedNote}`);
    if (decision === "approve") {
      const cur = currentVersion(skill);
      if (cur === v && parsed?.ok) {
        const fm = parsed.frontmatter;
        skill.description = maskPII(fm.description).text;
        skill.license = fm.license;
        if (fm.metadata.title?.trim() && fm.metadata.title.trim().length <= TITLE_MAX) skill.title = maskPII(fm.metadata.title.trim()).text;
        const levels = parseLevels(undefined, fm.metadata["school-levels"] ?? fm.metadata.schoolLevels);
        if (levels.length > 0) skill.schoolLevels = levels;
        if (fm.compatibility) skill.compatibility = parseCompatibility(undefined, fm.compatibility);
      }
      skill.updatedAt = nowIso();
    }
    writeAudit(db, actor, decision === "approve" ? "skill.approve" : "skill.reject", `${name}@${version}`, maskedNote);
    return { ok: true, value: v };
  });
}

/* ---------- 설치 엔드포인트 (F-39) ---------- */

export interface DiscoveryIndexV2 {
  $schema: string;
  skills: { name: string; type: "archive"; description: string; url: string; digest: string }[];
}

/**
 * Agent Skills Discovery v0.2.0 index. url은 index.json 기준 상대 주소다.
 * scope를 주면 그 스킬 하나만 담는다(<hub>/.well-known/agent-skills/<name> 범위 지정 설치용).
 * hub를 주면 템플릿 스킬의 digest를 그 허브용 압축 파일(readSkillArchive에 같은 hub)의 값으로 준다.
 */
export async function discoveryIndex(scope?: string, hub?: string): Promise<DiscoveryIndexV2 | null> {
  const skills = await loadSkills();
  const entries: DiscoveryIndexV2["skills"] = [];
  for (const s of skills) {
    if (scope && s.name !== scope) continue;
    const v = currentVersion(s);
    if (!v) continue;
    entries.push({
      name: s.name,
      type: "archive",
      description: s.description.slice(0, DESCRIPTION_MAX),
      // 루트 index: /.well-known/agent-skills/index.json 기준, 범위 index: .../<name>/.well-known/agent-skills/index.json 기준
      url: scope ? `../../${v.version}.zip` : `${s.name}/${v.version}.zip`,
      digest: (await describeSkillVersion(v, hub)).digest,
    });
  }
  if (scope && entries.length === 0) return null;
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { $schema: DISCOVERY_SCHEMA, skills: entries };
}

/**
 * 구 형식(v0.1.0) index: 파일 목록을 주고 CLI가 파일을 하나씩 받는다.
 * scope를 주면 그 스킬 하나만 담는다(범위 지정 주소의 .../<name>/.well-known/skills/index.json). 없으면 null.
 */
export async function legacyDiscoveryIndex(scope?: string): Promise<{ skills: { name: string; description: string; files: string[] }[] } | null> {
  const skills = await loadSkills();
  const out: { name: string; description: string; files: string[] }[] = [];
  for (const s of skills) {
    if (scope && s.name !== scope) continue;
    const v = currentVersion(s);
    if (!v) continue;
    out.push({ name: s.name, description: s.description.slice(0, DESCRIPTION_MAX), files: v.files.map((f) => f.path) });
  }
  if (scope && out.length === 0) return null;
  return { skills: out.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** 승인된 버전의 설치용 압축 파일. digest와 바이트가 같아야 CLI가 받아들인다(index와 같은 hub를 준다). */
export async function readSkillArchive(name: string, version: string, hub?: string): Promise<{ bytes: Uint8Array; digest: string } | null> {
  const skill = await getSkillRecord(name);
  const v = skill?.versions.find((x) => x.version === version && x.status === "approved");
  if (!v) return null;
  const rendered = await renderedVersion(v, hub);
  if (rendered) return { bytes: rendered.archive, digest: rendered.digest };
  // 손상된 파일을 내보내면 CLI가 digest 검사에서 거부하므로 읽을 때 해시를 다시 확인한다.
  const bytes = await getBlob(v.digest.replace(/^sha256:/, ""), true);
  return bytes ? { bytes, digest: v.digest } : null;
}

/** 현재 공개 버전의 파일 하나(구 형식 설치와 SKILL.md 직접 보기용). hub를 주면 템플릿에 허브 주소를 넣는다. */
export async function readPublicSkillFile(
  name: string,
  filePath: string,
  hub?: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const skill = await getSkillRecord(name);
  const v = skill && currentVersion(skill);
  const f = v?.files.find((x) => x.path === filePath);
  if (!v || !f) return null;
  const rendered = (await renderedVersion(v, hub))?.files.get(f.path);
  if (rendered) return { bytes: rendered, contentType: f.contentType };
  const bytes = await getBlob(f.sha256);
  return bytes ? { bytes, contentType: f.contentType } : null;
}

/*
 * 설치 수 집계(F-39). skills CLI는 --skill로 고르기 전에 index의 모든 압축 파일을 내려받으므로, 루트 주소(<hub>)로
 * 설치하면 목록의 모든 스킬이 한 번씩 받아져 어느 스킬을 설치했는지 알 수 없다. 그래서 설치 명령은 범위 지정 주소
 * (<hub>/.well-known/agent-skills/<name>)를 쓰고, 같은 클라이언트가 그 스킬의 범위 index를 방금(5분 안) 읽은 뒤
 * 받은 압축 파일(구 형식은 SKILL.md)만 설치 1회로 센다. 루트 index로 한꺼번에 받은 것은 세지 않는다.
 * 같은 클라이언트(IP·User-Agent 해시)가 같은 스킬을 10분 안에 다시 받아도 세지 않는다.
 * IP는 origin.ts clientIp(TRUST_PROXY일 때만 X-Forwarded-For의 맨 오른쪽 값)를 쓴다. 맨 앞 값은 누구나 바꿀 수 있다.
 */
const INSTALL_DEDUPE_MS = 10 * 60 * 1000;
const INSTALL_INTENT_MS = 5 * 60 * 1000;
const INSTALL_MAP_MAX = 5000;
const gi = globalThis as unknown as {
  __dandiSkillInstallSeen?: Map<string, number>;
  __dandiSkillInstallIntent?: Map<string, number>;
};

export function installClientKey(req: Request): string {
  const ip = clientIp(req.headers);
  const ua = req.headers.get("user-agent") ?? "";
  return createHash("sha256").update(`${ip}\n${ua}`).digest("hex").slice(0, 32);
}

function trimMap(map: Map<string, number>, now: number, ttl: number): void {
  if (map.size <= INSTALL_MAP_MAX) return;
  for (const [k, t] of map) if (now - t > ttl) map.delete(k);
  if (map.size > INSTALL_MAP_MAX) map.clear();
}

/**
 * 범위 지정 index(<hub>/.well-known/agent-skills/<name>/.well-known/...)를 읽었다고 적는다. 이 뒤에 같은 클라이언트가
 * 받는 그 스킬의 압축 파일만 설치로 센다. skills CLI의 업데이트 확인(X-Skills-Update-Check 헤더)은 적지 않는다.
 */
export function noteScopedIndexRead(req: Request, name: string): void {
  if (req.headers.get("x-skills-update-check")) return;
  const intents = (gi.__dandiSkillInstallIntent ??= new Map());
  const now = Date.now();
  trimMap(intents, now, INSTALL_INTENT_MS);
  intents.set(`${installClientKey(req)}|${name}`, now);
}

export async function recordSkillInstall(name: string, clientKey: string): Promise<boolean> {
  const now = Date.now();
  const key = `${clientKey}|${name}`;
  const intents = (gi.__dandiSkillInstallIntent ??= new Map());
  const intent = intents.get(key);
  if (!intent || now - intent > INSTALL_INTENT_MS) return false; // 이 스킬을 골라 설치한 요청이 아니다
  intents.delete(key);
  const seen = (gi.__dandiSkillInstallSeen ??= new Map());
  trimMap(seen, now, INSTALL_DEDUPE_MS);
  const last = seen.get(key);
  if (last && now - last < INSTALL_DEDUPE_MS) return false;
  seen.set(key, now);
  return mutate((db) => {
    const skill = db.skills.find((s) => s.name === name);
    if (!skill) return false;
    skill.installs += 1;
    return true;
  });
}
