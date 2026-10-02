import "server-only";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildSeed } from "./seed";
import type { DB } from "./types";

// 프로토타입용 로컬 JSON 저장소. v1.0에서 Supabase(PostgreSQL)로 교체한다.
// 교체 시에는 readDb/mutate를 사용하는 lib/*.ts 도메인 함수만 바꾸면 된다.

export const DATA_DIR = process.env.DANDI_DATA_DIR
  ? path.resolve(process.env.DANDI_DATA_DIR)
  : path.join(process.cwd(), "data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
/** 사이트·스킬 파일 본문(내용 주소 저장: data/blobs/<sha256>) */
export const BLOB_DIR = path.join(DATA_DIR, "blobs");
const DB_FILE = path.join(DATA_DIR, "db.json");

const EMPTY: DB = {
  users: [],
  apps: [],
  posts: [],
  comments: [],
  likes: [],
  files: [],
  templates: [],
  models: [],
  projects: [],
  projectKeys: [],
  usage: [],
  cliTokens: [],
  sessions: [],
  sites: [],
  siteDeploys: [],
  deviceAuths: [],
  oauthClients: [],
  oauthCodes: [],
  oauthTokens: [],
  skills: [],
  books: [],
  audit: [],
};

// dev 서버의 HMR로 모듈이 다시 로드되어도 쓰기 순서가 유지되도록 전역에 둔다.
const g = globalThis as unknown as { __dandiLock?: Promise<unknown> };

function serialize(db: DB): string {
  return JSON.stringify(db, null, 2);
}

/**
 * 저장소를 읽는다. raw는 읽은 내용을 다시 직렬화한 것으로, mutate가 바뀐 것이 없으면 쓰기를 건너뛰는 데 쓴다.
 * 읽기 전용(readDb)은 raw가 필요 없으므로 직렬화 비용을 들이지 않는다.
 */
async function load(withRaw = false): Promise<{ db: DB; raw: string }> {
  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<DB>;
    const db = { ...EMPTY, ...parsed };
    // v0.1 때 만든 저장소에는 서가가 없다. 처음 한 번만 시드 책을 넣는다(이후 관리자가 지운 책은 되살리지 않는다).
    if (!("books" in parsed)) db.books = structuredClone(buildSeed().books);
    return { db, raw: withRaw ? serialize(db) : "" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const seeded = buildSeed();
    await save(seeded);
    return { db: seeded, raw: serialize(seeded) };
  }
}

// Windows에서는 다른 프로그램(편집기, 백신, PowerShell 등)이 db.json을 열고 있으면 rename이 잠시 실패한다.
const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || attempt >= 8) throw err;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}

async function save(db: DB): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, serialize(db), "utf8");
  try {
    await renameWithRetry(tmp, DB_FILE);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = g.__dandiLock ?? Promise.resolve();
  const next = prev.then(fn, fn);
  g.__dandiLock = next.catch(() => undefined);
  return next;
}

/** 읽기 전용 스냅샷. 반환값을 수정해도 저장되지 않는다. */
export function readDb(): Promise<DB> {
  return withLock(async () => (await load()).db);
}

/**
 * 직렬화된 읽기-수정-쓰기. fn 안에서 db를 직접 수정하면 끝난 뒤 저장된다.
 * 바뀐 내용이 없으면(검증 실패, 없는 id 등) 파일을 다시 쓰지 않는다.
 */
export function mutate<T>(fn: (db: DB) => T | Promise<T>): Promise<T> {
  return withLock(async () => {
    const { db, raw } = await load(true);
    const result = await fn(db);
    if (serialize(db) !== raw) await save(db);
    return result;
  });
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
