import type { Metadata } from "next";
import Link from "next/link";
import { formatKstDate } from "@/components/app-card";
import { LevelFilter } from "@/components/level-filter";
import { BOOK_KIND_LABEL, isTeachersOnly, listBooks, safeHttpUrl } from "@/lib/books";
import { isSchoolLevel, levelLabel } from "@/lib/constants";
import { getCurrentUser, isTeacher } from "@/lib/session";
import type { Book } from "@/lib/types";
import { BookCover } from "./book-cover";

// 서가(F-43). 웹북과 PDF를 학교급·형식으로 걸러 보고 최신·열람 순으로 정렬한다. 교사 전용 책은 교사에게만 보인다.

export const metadata: Metadata = { title: "서가 · Dandi" };

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function href(q: { level?: string; kind?: string; sort?: string }): string {
  const s = new URLSearchParams();
  if (q.level) s.set("level", q.level);
  if (q.kind) s.set("kind", q.kind);
  if (q.sort && q.sort !== "recent") s.set("sort", q.sort);
  const qs = s.toString();
  return qs ? `/books?${qs}` : "/books";
}

function excerpt(text: string, max = 180): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function BookCard({ book }: { book: Book }) {
  const pages = book.kind === "webbook" ? book.toc.filter((i) => i.depth === 0).length : 0;
  return (
    <li style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <BookCover src={safeHttpUrl(book.coverUrl)} title={book.title} label={BOOK_KIND_LABEL[book.kind]} />
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        <div>
          <strong>
            <Link href={`/books/${book.id}`}>{book.title}</Link>
          </strong>{" "}
          <span className="badge">{BOOK_KIND_LABEL[book.kind]}</span>
          <span className="badge">{levelLabel(book.schoolLevel)}</span>
          {isTeachersOnly(book) && <span className="badge warn">교사 전용</span>}
          {book.containsThirdPartyWorks && <span className="badge warn">제3자 저작물 포함</span>}
        </div>
        {book.summary && <p style={{ margin: "4px 0" }}>{excerpt(book.summary)}</p>}
        <div className="muted">
          {book.authorName} · {book.license} · 수정 {formatKstDate(book.updatedAt)} · 열람{" "}
          {book.viewCount.toLocaleString("ko-KR")}회{pages > 0 && ` · ${pages}개 장`}
        </div>
        <p style={{ margin: "6px 0 0" }}>
          <Link href={`/books/${book.id}`} className="button primary">
            읽기
          </Link>
        </p>
      </div>
    </li>
  );
}

export default async function BooksPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const rawLevel = first(sp.level);
  const rawKind = first(sp.kind);
  const level = isSchoolLevel(rawLevel) ? rawLevel : undefined;
  const kind = rawKind === "webbook" || rawKind === "pdf" ? rawKind : undefined;
  const sort = first(sp.sort) === "views" ? "views" : "recent";

  const user = await getCurrentUser();
  const teacher = isTeacher(user);
  const books = await listBooks({ level, kind, sort }, user);

  return (
    <>
      <h1>서가</h1>
      <p className="muted">
        교사들이 등록한 웹북과 PDF를 브라우저에서 바로 읽습니다. 공개된 책은 로그인 없이 읽을 수 있고, 제3자
        저작물이 포함된 책은 교사에게만 보입니다.
      </p>

      {teacher ? (
        <p>
          <Link href="/books/new" className="button primary">
            책 등록
          </Link>
        </p>
      ) : (
        <p className="notice">
          책 등록과 교사 전용 책 열람은 교사 로그인이 필요합니다. <Link href="/login?next=/books">교사 로그인</Link>
        </p>
      )}

      <LevelFilter basePath="/books" current={level} extraQuery={{ kind, sort: sort === "views" ? sort : undefined }} />
      <nav className="filter" aria-label="형식 필터">
        <Link href={href({ level, sort })} aria-current={!kind ? "page" : undefined}>
          모든 형식
        </Link>
        <Link href={href({ level, kind: "webbook", sort })} aria-current={kind === "webbook" ? "page" : undefined}>
          웹북
        </Link>
        <Link href={href({ level, kind: "pdf", sort })} aria-current={kind === "pdf" ? "page" : undefined}>
          PDF
        </Link>
      </nav>
      <nav className="filter" aria-label="정렬">
        <Link href={href({ level, kind })} aria-current={sort === "recent" ? "page" : undefined}>
          최신순
        </Link>
        <Link href={href({ level, kind, sort: "views" })} aria-current={sort === "views" ? "page" : undefined}>
          열람순
        </Link>
      </nav>
      {level && <p className="muted">{levelLabel(level)} 책과 학교급 전체 대상 책을 함께 보여 줍니다.</p>}

      {books.length === 0 ? (
        <p className="muted">조건에 맞는 책이 없습니다.</p>
      ) : (
        <ul className="list">
          {books.map((b) => (
            <BookCard key={b.id} book={b} />
          ))}
        </ul>
      )}
    </>
  );
}
