import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { UPLOAD_ALLOWED_EXT, UPLOAD_MAX_BYTES, isLevelOrAll, isSchoolLevel } from "./constants";
import { mutate, newId, nowIso, readDb, UPLOAD_DIR } from "./db";
import { maskFields } from "./pii";
import { normalizeNewlines } from "./text";
import { displayName, ensureUser, isTeacher, writeAudit } from "./session";
import type { FileItem, LevelOrAll, User, DB } from "./types";

// 자료실 도메인 로직(F-08). 파일 본문은 로컬 디렉터리(data/uploads)에 둔다.
// v1.0에서 Supabase Storage로 옮길 때 writeStored/removeStored/storedFilePath만 바꾸면 된다.

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 1000;
const ORIGINAL_NAME_MAX = 150;

/** 확장자별 Content-Type. 브라우저가 보낸 MIME 값은 믿지 않고 확장자로 정한다. */
const MIME_BY_EXT: Record<string, string> = {
  exe: "application/vnd.microsoft.portable-executable",
  apk: "application/vnd.android.package-archive",
  zip: "application/zip",
  pdf: "application/pdf",
  hwp: "application/x-hwp",
  hwpx: "application/hwp+zip",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
};

// newId("file") + "." + 확장자 형태만 허용한다. db.json이 오염되어도 업로드 폴더 밖을 가리키지 못하게 한다.
const STORED_NAME_RE = /^file_[0-9a-f]+\.[a-z0-9]+$/;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 원래 파일 이름을 이름 부분과 확장자(소문자)로 나눈다. 경로 구분자 앞부분은 버린다. */
function splitName(rawName: string): { stem: string; ext: string } {
  const base = rawName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return { stem: base, ext: "" };
  return { stem: base.slice(0, dot), ext: base.slice(dot + 1).toLowerCase() };
}

/** 다운로드 이름으로 쓸 수 있게 제어 문자와 파일 시스템 예약 문자를 바꾼다. */
function sanitizeStem(stem: string, max = ORIGINAL_NAME_MAX): string {
  const cleaned = stem
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, max);
  return cleaned || "file";
}

/** 업로드 가능한 파일인지 검사한다. 통과하면 null. */
export function validateFileMeta(name: string, size: number): string | null {
  const { ext } = splitName(name);
  if (!name || size <= 0) return "업로드할 파일을 선택하십시오. 빈 파일은 올릴 수 없습니다.";
  if (!ext || !UPLOAD_ALLOWED_EXT.includes(ext)) {
    return `허용되지 않는 형식입니다. 허용 확장자: ${UPLOAD_ALLOWED_EXT.join(", ")}`;
  }
  if (size > UPLOAD_MAX_BYTES) {
    return `파일이 너무 큽니다. 최대 ${formatBytes(UPLOAD_MAX_BYTES)}까지 올릴 수 있습니다.`;
  }
  return null;
}

/**
 * 자료 목록. level을 주면 그 학교급 자료와 "전체" 대상 자료를 함께 돌려준다.
 * level이 없거나 "all"이거나 알 수 없는 값이면 전부 돌려준다.
 */
/** 교사 전용 책(F-45 저작권 게이트)이 쓰는 PDF인가. books.ts와 같은 규칙이며, 순환 import를 피하려고 여기에 둔다. */
export function isTeachersOnlyBookFile(db: DB, fileId: string): boolean {
  return db.books.some(
    (b) => b.kind === "pdf" && b.fileId === fileId && (b.visibility === "teachers" || b.containsThirdPartyWorks),
  );
}

export async function listFiles(
  filter: { level?: string | null; sort?: "recent" | "downloads"; limit?: number; viewerIsTeacher?: boolean } = {},
): Promise<FileItem[]> {
  const db = await readDb();
  const level = isSchoolLevel(filter.level) ? filter.level : null;
  const items = db.files
    .filter((f) => filter.viewerIsTeacher || !isTeachersOnlyBookFile(db, f.id))
    .filter((f) => !level || f.schoolLevel === level || f.schoolLevel === "all")
    .sort((a, b) =>
      filter.sort === "downloads"
        ? b.downloads - a.downloads || b.createdAt.localeCompare(a.createdAt)
        : b.createdAt.localeCompare(a.createdAt),
    );
  return filter.limit && filter.limit > 0 ? items.slice(0, filter.limit) : items;
}

export async function getFile(id: string): Promise<FileItem | null> {
  const db = await readDb();
  return db.files.find((f) => f.id === id) ?? null;
}

/** 저장된 파일의 절대 경로. storedName이 규칙에 맞지 않으면 null. */
export function storedFilePath(item: Pick<FileItem, "storedName">): string | null {
  if (!STORED_NAME_RE.test(item.storedName)) return null;
  const full = path.resolve(UPLOAD_DIR, item.storedName);
  if (path.dirname(full) !== path.resolve(UPLOAD_DIR)) return null;
  return full;
}

async function removeStored(storedName: string): Promise<void> {
  const full = storedFilePath({ storedName });
  if (!full) return;
  try {
    await fs.unlink(full);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export interface UploadInput {
  file: File;
  title: string;
  description: string;
  schoolLevel: LevelOrAll;
}

export async function saveUpload(input: UploadInput, author: User): Promise<Result<FileItem>> {
  if (!isTeacher(author)) return { ok: false, error: "교사 로그인이 필요합니다." };

  const { file } = input;
  const metaError = validateFileMeta(file.name, file.size);
  if (metaError) return { ok: false, error: metaError };

  const title = input.title.trim();
  const description = normalizeNewlines(input.description).trim();
  if (!title) return { ok: false, error: "제목을 입력하십시오." };
  if (title.length > TITLE_MAX) return { ok: false, error: `제목은 ${TITLE_MAX}자 이하로 입력하십시오.` };
  if (description.length > DESCRIPTION_MAX) {
    return { ok: false, error: `설명은 ${DESCRIPTION_MAX}자 이하로 입력하십시오.` };
  }
  if (!isLevelOrAll(input.schoolLevel)) return { ok: false, error: "학교급을 선택하십시오." };

  // F-14 서버 마스킹: 제목·설명과 원래 파일 이름(확장자 제외)에 섞인 개인정보를 저장 전에 가린다.
  // 파일 이름은 먼저 정리(공백 합치기, 넉넉한 1,000자 상한)한 뒤 검사하고, 가린 다음에 최종 길이(150자)로 자른다.
  // 정리 과정에서 번호가 다시 이어 붙거나, 먼저 잘라 번호 일부만 남는 것을 막기 위해서다.
  // 가린 자리(***)는 파일 이름에 쓸 수 없는 문자라 두 번째 정리에서 ___로 바뀐다.
  const { stem, ext } = splitName(file.name);
  const masked = maskFields({ title, description, stem: sanitizeStem(stem, 1000) });
  const originalName = `${sanitizeStem(masked.values.stem)}.${ext}`;

  // 저장 경로에는 원래 이름을 쓰지 않는다(경로 조작 방지). 무작위 id로만 이름을 만든다.
  const id = newId("file");
  const storedName = `${id}.${ext}`;
  const target = storedFilePath({ storedName });
  if (!target) return { ok: false, error: "저장 이름을 만들지 못했습니다. 다시 시도하십시오." };

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength !== file.size || bytes.byteLength > UPLOAD_MAX_BYTES) {
    return { ok: false, error: "파일을 읽지 못했습니다. 다시 시도하십시오." };
  }
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(target, bytes, { flag: "wx" });

  const item: FileItem = {
    id,
    title: masked.values.title,
    description: masked.values.description,
    originalName,
    storedName,
    size: bytes.byteLength,
    mime: MIME_BY_EXT[ext] ?? "application/octet-stream",
    ext,
    schoolLevel: input.schoolLevel,
    downloads: 0,
    authorId: author.id,
    authorName: displayName(author),
    createdAt: nowIso(),
  };

  try {
    await mutate((db) => {
      ensureUser(db, author);
      db.files.push(item);
      const note = masked.count ? ` (개인정보 ${masked.count}건 마스킹)` : "";
      writeAudit(db, author, "file.upload", id, `${originalName}${note}`);
    });
  } catch (err) {
    await removeStored(storedName).catch(() => undefined);
    throw err;
  }
  return { ok: true, value: item };
}

export async function incrementDownloads(id: string): Promise<void> {
  await mutate((db) => {
    const item = db.files.find((f) => f.id === id);
    if (item) item.downloads += 1;
  });
}

/** 작성자 본인 또는 관리자만 삭제할 수 있다(F-15의 프로토타입 서버 검사). 저장된 파일도 지운다. */
export async function deleteFile(id: string, actor: User): Promise<Result<null>> {
  const result = await mutate((db): Result<FileItem> => {
    const idx = db.files.findIndex((f) => f.id === id);
    if (idx < 0) return { ok: false, error: "자료를 찾을 수 없습니다." };
    const item = db.files[idx];
    if (item.authorId !== actor.id && actor.role !== "admin") {
      return { ok: false, error: "본인이 올린 자료만 삭제할 수 있습니다." };
    }
    db.files.splice(idx, 1);
    writeAudit(db, actor, "file.delete", id, item.originalName);
    return { ok: true, value: item };
  });
  if (!result.ok) return result;
  await removeStored(result.value.storedName);
  return { ok: true, value: null };
}
