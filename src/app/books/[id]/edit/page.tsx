import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BOOK_LICENSES, canManageBook, canViewBook, COPYRIGHT_WARNING, getBook } from "@/lib/books";
import { getCurrentUser } from "@/lib/session";
import { DeleteBookButton } from "../delete-book-button";
import { EditBookForm, RefreshTocButton } from "./edit-book-form";

// 책 정보 수정(F-43 ~ F-45). 등록한 교사 본인 또는 관리자만. 저장할 때 저작권 게이트를 다시 적용한다.

export const metadata: Metadata = { title: "책 정보 수정 · Dandi" };

export default async function EditBookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [book, user] = await Promise.all([getBook(id), getCurrentUser()]);
  if (!book || !canViewBook(book, user)) notFound();

  if (!canManageBook(book, user)) {
    return (
      <>
        <h1>책 정보 수정</h1>
        <p className="notice">책을 등록한 교사나 관리자만 수정할 수 있습니다.</p>
        <p>
          <Link href={`/books/${book.id}`}>책으로 돌아가기</Link>
        </p>
      </>
    );
  }

  const license = (BOOK_LICENSES as readonly string[]).includes(book.license) ? book.license : "";

  return (
    <>
      <p className="muted">
        <Link href="/books">← 서가</Link> · <Link href={`/books/${book.id}`}>{book.title}</Link>
      </p>
      <h1>책 정보 수정</h1>
      <EditBookForm
        id={book.id}
        licenses={BOOK_LICENSES}
        copyrightWarning={COPYRIGHT_WARNING}
        defaults={{
          title: book.title,
          summary: book.summary,
          authorName: book.authorName,
          schoolLevel: book.schoolLevel,
          license,
          visibility: book.visibility,
          thirdParty: book.containsThirdPartyWorks,
          coverUrl: book.coverUrl ?? "",
        }}
      />

      {book.kind === "webbook" && (
        <>
          <h2>목차</h2>
          <p className="muted">
            {book.baseUrl} · 지금 목차 {book.toc.length}항목. 사이트를 고친 뒤 목차를 다시 가져오면 허브 목차가 최신으로
            바뀝니다.
          </p>
          <RefreshTocButton id={book.id} />
        </>
      )}

      <h2>삭제</h2>
      <DeleteBookButton id={book.id} title={book.title} kind={book.kind} />
    </>
  );
}
