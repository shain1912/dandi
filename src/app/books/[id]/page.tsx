import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatKstDate } from "@/components/app-card";
import {
  BOOK_KIND_LABEL,
  canManageBook,
  canViewBook,
  COPYRIGHT_WARNING,
  getBook,
  isTeachersOnly,
  safeHttpUrl,
} from "@/lib/books";
import { levelLabel } from "@/lib/constants";
import { getFile } from "@/lib/files";
import { getCurrentUser } from "@/lib/session";
import type { Book, BookTocItem } from "@/lib/types";
import { ChapterMemory } from "./chapter-memory";
import { DeleteBookButton } from "./delete-book-button";
import { PdfReaderLoader } from "./pdf-reader-loader";
import { BookViewCounter } from "./view-counter";

// 책 리더(F-43 웹북: 허브 목차 + 본문 iframe, F-44 PDF: react-pdf). 교사 전용 책(F-45)은 교사만 연다.

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const book = await getBook(id);
  return book && canViewBook(book, await getCurrentUser()) ? { title: `${book.title} · 서가 · Dandi` } : {};
}

function chapterIndex(raw: string | string[] | undefined, length: number): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !/^\d{1,4}$/.test(v)) return null;
  const n = Number(v);
  return n < length ? n : null;
}

/** 목차 항목마다 속한 페이지(depth 0) 항목의 번호. */
function pageIndexes(toc: BookTocItem[]): number[] {
  let page = 0;
  return toc.map((t, i) => (t.depth === 0 ? (page = i) : page));
}

/** 상단 바: ← 서가 · 책 제목 · 새 창에서 열기 */
function TopBar({ title, openHref, openLabel }: { title: string; openHref: string | null; openLabel: string }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 8px", alignItems: "baseline", margin: "0.5rem 0 0.75rem" }}>
      <Link href="/books">← 서가</Link>
      <span className="muted" aria-hidden="true">
        ·
      </span>
      <h1 style={{ margin: 0, fontSize: "1.25rem" }}>{title}</h1>
      {openHref && (
        <>
          <span className="muted" aria-hidden="true">
            ·
          </span>
          <a href={openHref} target="_blank" rel="noopener noreferrer">
            {openLabel}
          </a>
        </>
      )}
    </div>
  );
}

function BookInfo({ book }: { book: Book }) {
  return (
    <>
      <p>
        <span className="badge">{BOOK_KIND_LABEL[book.kind]}</span>
        <span className="badge">{levelLabel(book.schoolLevel)}</span>
        {isTeachersOnly(book) && <span className="badge warn">교사 전용</span>}
        {book.containsThirdPartyWorks && <span className="badge warn">제3자 저작물 포함</span>}
      </p>
      {book.summary && <p style={{ whiteSpace: "pre-wrap" }}>{book.summary}</p>}
      <p className="muted">
        {book.authorName} · 이용 조건 {book.license} · 수정 {formatKstDate(book.updatedAt)} · 열람{" "}
        {book.viewCount.toLocaleString("ko-KR")}회
        {book.kind === "webbook" && book.baseUrl && <> · 주소 {book.baseUrl}</>}
      </p>
    </>
  );
}

function WebbookReader({ book, index, current }: { book: Book; index: number; current: number | null }) {
  const toc = book.toc;
  const item = toc[index];
  const src = safeHttpUrl(item?.href ?? book.baseUrl);
  const pageOf = pageIndexes(toc);
  const activePage = pageOf[index] ?? 0;
  // 장(depth 0)은 모두 보이고, 절은 지금 연 장의 것만 펼친다.
  const visible = toc
    .map((t, i) => ({ ...t, i }))
    .filter((t) => t.depth === 0 || pageOf[t.i] === activePage);

  return (
    <>
      <ChapterMemory
        bookId={book.id}
        current={current}
        hrefs={toc.map((t) => t.href)}
        currentTitle={item?.title ?? book.title}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
        <nav
          aria-label="목차"
          style={{
            flex: "1 1 200px",
            maxHeight: "70vh",
            overflowY: "auto",
            border: "1px solid var(--line)",
            borderRadius: 4,
            padding: "6px 8px",
          }}
        >
          <strong>목차</strong>
          {toc.length === 0 ? (
            <p className="muted">목차가 없습니다.</p>
          ) : (
            <ol style={{ listStyle: "none", margin: "4px 0 0", padding: 0 }}>
              {visible.map((t) => (
                <li key={t.i} style={{ padding: `2px 0 2px ${t.depth * 12}px`, fontSize: t.depth ? "0.9rem" : undefined }}>
                  <Link href={`/books/${book.id}?ch=${t.i}`} aria-current={t.i === index ? "page" : undefined}>
                    {t.i === index ? <strong>{t.title}</strong> : t.title}
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </nav>
        <div style={{ flex: "3 1 480px", minWidth: 0 }}>
          {src ? (
            <iframe
              key={src}
              className="app-frame"
              src={src}
              title={`${book.title} 본문`}
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"
              referrerPolicy="strict-origin-when-cross-origin"
            />
          ) : (
            <p className="error">본문 주소가 올바르지 않습니다.</p>
          )}
        </div>
      </div>
      <p className="muted">
        본문이 보이지 않으면 사이트가 다른 사이트 안에 표시하는 것을 막아 둔 경우입니다. 새 창에서 열기를
        사용하십시오. 이어 읽기는 이 브라우저에서 허브 목차로 마지막에 연 장을 기억하는 방식이라, 본문 안에서 이동한
        위치는 기억하지 못합니다.
      </p>
    </>
  );
}

export default async function BookReaderPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const [book, user] = await Promise.all([getBook(id), getCurrentUser()]);
  if (!book) notFound();

  if (!canViewBook(book, user)) {
    return (
      <>
        <p className="muted">
          <Link href="/books">← 서가</Link>
        </p>
        <h1>교사 전용 책</h1>
        <p className="notice">
          이 책은 교사만 열람할 수 있습니다.{" "}
          <Link href={`/login?next=${encodeURIComponent(`/books/${book.id}`)}`}>교사 로그인</Link> 후 다시
          여십시오.
        </p>
      </>
    );
  }

  const manage = canManageBook(book, user);
  let reader: React.ReactNode;
  let openHref: string | null;
  let openLabel = "새 창에서 열기";

  if (book.kind === "webbook") {
    const current = chapterIndex(sp.ch, book.toc.length);
    const index = current ?? 0;
    openHref = safeHttpUrl(book.toc[index]?.href ?? book.baseUrl);
    reader = <WebbookReader book={book} index={index} current={current} />;
  } else {
    const file = book.fileId ? await getFile(book.fileId) : null;
    openHref = file ? `/api/files/${file.id}/view` : null;
    openLabel = "새 창에서 원본 열기";
    reader = openHref ? (
      <>
        <PdfReaderLoader bookId={book.id} fileUrl={openHref} />
        <p className="muted">
          이어 읽기는 이 브라우저에 마지막으로 본 쪽을 기억하는 방식입니다. 글자 선택이나 화면 읽기 프로그램이
          필요하면 새 창에서 원본을 여십시오.
        </p>
      </>
    ) : (
      <p className="notice">원본 PDF가 자료실에서 삭제되어 열 수 없습니다.</p>
    );
  }

  return (
    <>
      <TopBar title={book.title} openHref={openHref} openLabel={openLabel} />
      {book.containsThirdPartyWorks && <p className="notice">{COPYRIGHT_WARNING}</p>}
      {reader}
      <h2>책 정보</h2>
      <BookInfo book={book} />
      {manage && (
        // <p> 안에는 <form>(DeleteBookButton)을 넣을 수 없다(HTML 파서가 <p>를 닫아 하이드레이션 오류 #418).
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", margin: "1em 0" }}>
          <Link href={`/books/${book.id}/edit`} className="button">
            책 정보 수정
          </Link>
          <DeleteBookButton id={book.id} title={book.title} kind={book.kind} />
        </div>
      )}
      <BookViewCounter bookId={book.id} />
    </>
  );
}
