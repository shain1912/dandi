"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createPdfBookFromFile,
  createPdfBookFromUpload,
  createWebbook,
  deleteBook,
  getBook,
  importWebbook,
  incrementBookViews,
  refreshWebbookToc,
  updateBook,
  type BookMetaInput,
} from "@/lib/books";
import { hubOrigin } from "@/lib/origin";
import { AuthError, getCurrentUser, requireTeacher } from "@/lib/session";
import type { BookTocItem, User } from "@/lib/types";

// 전자책 서가 서버 액션(F-43 ~ F-45). 검증·마스킹·저작권 게이트는 lib/books.ts가 맡는다.

export type WebbookPreviewView = {
  baseUrl: string;
  title: string;
  summary: string;
  toc: BookTocItem[];
  pageCount: number;
  lastmod: string | null;
  source: "search_index" | "sitemap" | "page";
  /** 첫 페이지 og:image에서 고른 표지 후보. 등록 폼의 표지 칸 기본값으로 쓴다 */
  coverUrl: string | null;
};

export type PreviewState = { error?: string; preview?: WebbookPreviewView; warnings?: string[] };
export type BookFormState = { error?: string };
export type BookNoticeState = { error?: string; notice?: string };

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

function metaFrom(formData: FormData): BookMetaInput {
  return {
    title: str(formData, "title"),
    summary: str(formData, "summary"),
    authorName: str(formData, "authorName"),
    schoolLevel: str(formData, "schoolLevel") || "all",
    license: str(formData, "license"),
    visibility: str(formData, "visibility") || "teachers",
    containsThirdPartyWorks: str(formData, "thirdParty") === "yes",
    // 표지 칸이 있는 폼에서만 보낸다(칸을 비우면 표지 없음).
    coverUrl: formData.has("coverUrl") ? str(formData, "coverUrl") : undefined,
  };
}

async function teacherOrError(): Promise<{ user: User } | { error: string }> {
  try {
    return { user: await requireTeacher() };
  } catch (err) {
    if (err instanceof AuthError) return { error: err.message };
    throw err;
  }
}

function revalidateBooks(id?: string): void {
  revalidatePath("/books");
  if (id) revalidatePath(`/books/${id}`);
}

/** 웹북 주소에서 목차를 가져와 미리 보여 준다(저장하지 않음). */
export async function previewWebbookAction(_prev: PreviewState, formData: FormData): Promise<PreviewState> {
  const auth = await teacherOrError();
  if ("error" in auth) return { error: auth.error };
  const result = await importWebbook(str(formData, "url"), await hubOrigin());
  if (!result.ok) return { error: result.error };
  const v = result.value;
  return {
    preview: {
      baseUrl: v.baseUrl,
      title: v.title,
      summary: v.summary,
      toc: v.toc,
      pageCount: v.pageCount,
      lastmod: v.lastmod,
      source: v.source,
      coverUrl: v.coverUrl,
    },
    warnings: result.warnings,
  };
}

export async function createWebbookAction(_prev: BookFormState, formData: FormData): Promise<BookFormState> {
  const auth = await teacherOrError();
  if ("error" in auth) return { error: auth.error };
  const result = await createWebbook({ ...metaFrom(formData), url: str(formData, "url") }, auth.user, await hubOrigin());
  if (!result.ok) return { error: result.error };
  revalidateBooks();
  redirect(`/books/${result.value.id}`);
}

export async function createPdfBookAction(_prev: BookFormState, formData: FormData): Promise<BookFormState> {
  const auth = await teacherOrError();
  if ("error" in auth) return { error: auth.error };
  const meta = metaFrom(formData);
  const source = str(formData, "source");

  let result;
  if (source === "upload") {
    // 자료실 업로드와 같은 확인(F-08): 파일 내용은 자동 검사하지 않으므로 올리는 교사의 확인을 받는다.
    if (str(formData, "noStudentData") !== "yes") {
      return { error: "파일에 학생 개인정보가 없음을 확인하는 항목에 체크하십시오." };
    }
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "올릴 PDF 파일을 선택하십시오." };
    result = await createPdfBookFromUpload({ ...meta, file }, auth.user, await hubOrigin());
    if (result.ok) {
      revalidatePath("/files");
      revalidatePath("/");
    }
  } else if (source === "existing") {
    const fileId = str(formData, "fileId");
    if (!fileId) return { error: "서가에 올릴 자료실 PDF를 선택하십시오." };
    result = await createPdfBookFromFile({ ...meta, fileId }, auth.user, await hubOrigin());
  } else {
    return { error: "PDF를 가져올 곳(자료실 파일 또는 새 파일)을 선택하십시오." };
  }
  if (!result.ok) return { error: result.error };
  revalidateBooks();
  redirect(`/books/${result.value.id}`);
}

export async function updateBookAction(_prev: BookNoticeState, formData: FormData): Promise<BookNoticeState> {
  const auth = await teacherOrError();
  if ("error" in auth) return { error: auth.error };
  const id = str(formData, "id");
  const result = await updateBook(id, metaFrom(formData), auth.user, await hubOrigin());
  if (!result.ok) return { error: result.error };
  revalidateBooks(id);
  return { notice: ["저장했습니다.", ...result.warnings].join(" ") };
}

export async function refreshTocAction(_prev: BookNoticeState, formData: FormData): Promise<BookNoticeState> {
  const auth = await teacherOrError();
  if ("error" in auth) return { error: auth.error };
  const id = str(formData, "id");
  const result = await refreshWebbookToc(id, auth.user, await hubOrigin());
  if (!result.ok) return { error: result.error };
  revalidateBooks(id);
  return { notice: [`목차를 다시 가져왔습니다(${result.value.toc.length}항목).`, ...result.warnings].join(" ") };
}

export async function deleteBookAction(_prev: BookFormState, formData: FormData): Promise<BookFormState> {
  const auth = await teacherOrError();
  if ("error" in auth) return { error: auth.error };
  const id = str(formData, "id");
  const result = await deleteBook(id, auth.user);
  if (!result.ok) return { error: result.error };
  revalidateBooks(id);
  redirect("/books");
}

/** 리더 화면이 브라우저에 뜬 뒤 한 번 호출해 열람 수를 1 올린다. */
export async function recordBookView(bookId: string): Promise<void> {
  if (typeof bookId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(bookId)) return;
  const book = await getBook(bookId);
  if (!book) return;
  await incrementBookViews(bookId, await getCurrentUser());
}
