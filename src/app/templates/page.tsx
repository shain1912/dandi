import type { Metadata } from "next";
import Link from "next/link";
import { LevelFilter } from "@/components/level-filter";
import { APP_CATEGORIES, appCategoryLabel, isAppCategory, isSchoolLevel, levelLabel } from "@/lib/constants";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { listTemplates } from "@/lib/templates";

export const metadata: Metadata = { title: "템플릿 갤러리 · Dandi" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// F-09 템플릿 갤러리: "작업 지시서 + 예시 사이트" 묶음. 학교급·분류 필터, 예시 바로 실행.
export default async function TemplatesPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const levelParam = one(sp.level);
  const categoryParam = one(sp.category);
  const level = isSchoolLevel(levelParam) ? levelParam : undefined;
  const category = isAppCategory(categoryParam) ? categoryParam : undefined;

  const [templates, user] = await Promise.all([listTemplates({ level, category }), getCurrentUser()]);

  const categoryHref = (c?: string) => {
    const q = new URLSearchParams();
    if (level) q.set("level", level);
    if (c) q.set("category", c);
    const s = q.toString();
    return s ? `/templates?${s}` : "/templates";
  };

  return (
    <>
      <h1>템플릿 갤러리</h1>
      <p className="muted">
        예시 사이트를 먼저 실행해 보고, 작업 지시서를 복사해 AI 코딩 도구(Claude Code, Cursor 등)에 붙여 넣으면 내
        버전을 만들 수 있습니다. 처음이라면 <Link href="/docs/start">시작하기 문서</Link>부터 보십시오.
      </p>
      <p>
        {isTeacher(user) ? (
          <Link href="/templates/new" className="button">
            새 템플릿 등록
          </Link>
        ) : (
          <span className="muted">
            템플릿 등록은 <Link href="/login">교사 로그인</Link> 후 사용할 수 있습니다. 보기와 복사는 로그인 없이
            사용할 수 있습니다.
          </span>
        )}
      </p>

      <LevelFilter basePath="/templates" current={level} extraQuery={{ category }} />
      <nav className="filter" aria-label="분류 필터">
        <Link href={categoryHref()} aria-current={!category ? "page" : undefined}>
          모든 분류
        </Link>
        {APP_CATEGORIES.map((c) => (
          <Link key={c.id} href={categoryHref(c.id)} aria-current={category === c.id ? "page" : undefined}>
            {c.label}
          </Link>
        ))}
      </nav>

      {templates.length === 0 ? (
        <p className="muted">조건에 맞는 템플릿이 없습니다. 필터를 바꾸어 보십시오.</p>
      ) : (
        <ul className="list">
          {templates.map((t) => (
            <li key={t.id}>
              <strong>
                <Link href={`/templates/${t.id}`}>{t.title}</Link>
              </strong>
              <div>{t.summary}</div>
              <div className="muted">
                <span className="badge">{appCategoryLabel(t.category)}</span>
                {t.schoolLevels.map((l) => (
                  <span key={l} className="badge">
                    {levelLabel(l)}
                  </span>
                ))}
                복사 {t.copies.toLocaleString("ko-KR")}회 · {t.authorName}
              </div>
              <div>
                <a href={t.exampleUrl} target="_blank" rel="noopener noreferrer">
                  예시 실행(새 창)
                </a>
                {" · "}
                <Link href={`/templates/${t.id}`}>작업 지시서 보기</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
