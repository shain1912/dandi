import type { Metadata } from "next";
import Link from "next/link";
import { BOOK_LICENSES, COPYRIGHT_WARNING, listPdfFilesFor } from "@/lib/books";
import { formatBytes } from "@/lib/files";
import { displayName, getCurrentUser, isTeacher } from "@/lib/session";
import { PdfBookForm } from "./pdf-book-form";
import { WebbookForm } from "./webbook-form";

// 책 등록(F-43 웹북 주소, F-44 PDF). 교사만 등록한다.

export const metadata: Metadata = { title: "책 등록 · Dandi" };

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function NewBookPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const user = await getCurrentUser();

  if (!isTeacher(user)) {
    return (
      <>
        <h1>책 등록</h1>
        <p className="notice">
          책 등록은 교사 로그인이 필요합니다. <Link href="/login?next=/books/new">교사 로그인</Link> 후 다시
          시도하십시오.
        </p>
        <p>
          <Link href="/books">서가로 돌아가기</Link>
        </p>
      </>
    );
  }

  const kind = first(sp.kind) === "pdf" ? "pdf" : "webbook";
  const files = kind === "pdf" ? await listPdfFilesFor(user) : [];
  const requested = first(sp.fileId);
  const preselect = files.some((f) => f.id === requested) ? (requested as string) : null;
  const common = {
    licenses: BOOK_LICENSES,
    copyrightWarning: COPYRIGHT_WARNING,
    defaultAuthor: displayName(user),
    defaultLevel: user.schoolLevel ?? "all",
  };

  return (
    <>
      <p className="muted">
        <Link href="/books">← 서가</Link>
      </p>
      <h1>책 등록</h1>
      <nav className="filter" aria-label="책 형식">
        <Link href="/books/new" aria-current={kind === "webbook" ? "page" : undefined}>
          웹북 주소로 등록
        </Link>
        <Link href="/books/new?kind=pdf" aria-current={kind === "pdf" ? "page" : undefined}>
          PDF로 등록
        </Link>
      </nav>
      <ul className="muted">
        <li>제목·소개·저자에 학생 이름과 연락처 같은 개인정보를 넣지 마십시오. 서버에서 개인정보 패턴을 찾으면 ***로 가린 뒤 저장합니다.</li>
        <li>다른 사람의 저작물이 들어 있는 책은 공개 서가에 올릴 수 없고 교사 전용으로만 등록됩니다(저작권법 제25조).</li>
      </ul>

      {kind === "webbook" ? (
        <WebbookForm {...common} />
      ) : (
        <PdfBookForm
          {...common}
          files={files.map((f) => ({ id: f.id, label: `${f.title} · ${f.originalName} · ${formatBytes(f.size)}` }))}
          preselectFileId={preselect}
        />
      )}
    </>
  );
}
