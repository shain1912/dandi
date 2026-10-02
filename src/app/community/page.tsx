import Link from "next/link";
import { LevelFilter } from "@/components/level-filter";
import { listPosts } from "@/lib/community";
import {
  isPostCategory,
  isSchoolLevel,
  levelLabel,
  POST_CATEGORIES,
  postCategoryLabel,
} from "@/lib/constants";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { firstParam, formatDate } from "./format";

// 커뮤니티 자유 게시판 목록(F-07). 글 읽기와 좋아요는 로그인 없이, 글쓰기는 교사만 한다.

export default async function CommunityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const levelParam = firstParam(sp.level);
  const categoryParam = firstParam(sp.category);
  const level = isSchoolLevel(levelParam) ? levelParam : undefined;
  const category = isPostCategory(categoryParam) ? categoryParam : undefined;

  const user = await getCurrentUser();
  const posts = await listPosts({ level, category });

  const categoryHref = (c?: string) => {
    const q = new URLSearchParams();
    if (c) q.set("category", c);
    if (level) q.set("level", level);
    const s = q.toString();
    return s ? `/community?${s}` : "/community";
  };

  return (
    <>
      <h1>커뮤니티</h1>
      <p className="muted">
        강의 자료, 질문, 정보를 나누는 게시판입니다. 글 읽기와 좋아요는 로그인 없이 사용할 수 있습니다.
      </p>
      {isTeacher(user) ? (
        <p>
          <Link className="button primary" href="/community/new">
            글쓰기
          </Link>
        </p>
      ) : (
        <p className="muted">
          글쓰기와 댓글은 교사 로그인 후 사용할 수 있습니다. <Link href="/login">교사 로그인</Link>
        </p>
      )}

      <LevelFilter basePath="/community" current={level} extraQuery={{ category }} />
      <nav className="filter" aria-label="분류 필터">
        <Link href={categoryHref()} aria-current={!category ? "page" : undefined}>
          전체 분류
        </Link>
        {POST_CATEGORIES.map((c) => (
          <Link
            key={c.id}
            href={categoryHref(c.id)}
            aria-current={category === c.id ? "page" : undefined}
          >
            {c.label}
          </Link>
        ))}
      </nav>

      {posts.length === 0 ? (
        <p className="muted">조건에 맞는 글이 없습니다.</p>
      ) : (
        <ul className="list">
          {posts.map((p) => (
            <li key={p.id}>
              <div>
                <Link href={`/community/${p.id}`}>{p.title}</Link>
              </div>
              <div className="muted">
                <span className="badge">{postCategoryLabel(p.category)}</span>
                <span className="badge">학교급 {levelLabel(p.schoolLevel)}</span>
                {p.maskedCount > 0 && (
                  <span className="badge warn">개인정보 {p.maskedCount}건 가림</span>
                )}
                {p.authorName} · {formatDate(p.createdAt)} · 댓글 {p.commentCount} · 좋아요{" "}
                {p.likeCount}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
