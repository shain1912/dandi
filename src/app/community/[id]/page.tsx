import Link from "next/link";
import { notFound } from "next/navigation";
import { canManage, COMMENT_BODY_MAX, getPost } from "@/lib/community";
import { levelLabel, postCategoryLabel } from "@/lib/constants";
import { getCurrentUser, isTeacher } from "@/lib/session";
import {
  addCommentAction,
  deleteCommentAction,
  deletePostAction,
  toggleLikeAction,
} from "../actions";
import { firstParam, formatDateTime } from "../format";
import { CommentForm } from "./comment-form";
import { DeleteButton } from "./delete-button";

// 글 보기(F-07). 본문은 평문으로만 출력한다(HTML 해석 없음). 줄바꿈은 CSS로 유지한다.
const PLAIN_TEXT = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } as const;

export default async function PostPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await getCurrentUser();
  const post = await getPost(id, user.id);
  if (!post) notFound();

  // ?masked=N 은 글쓰기 직후 작성자에게 알리는 용도. 개수는 저장된 값을 쓴다.
  const justMasked = firstParam(sp.masked) !== undefined && post.maskedCount > 0;

  return (
    <>
      <p>
        <Link href="/community">목록으로</Link>
      </p>
      <h1>{post.title}</h1>
      <p className="muted">
        <span className="badge">{postCategoryLabel(post.category)}</span>
        <span className="badge">학교급 {levelLabel(post.schoolLevel)}</span>
        {post.maskedCount > 0 && (
          <span className="badge warn">개인정보 {post.maskedCount}건 가림</span>
        )}
        {post.authorName} · {formatDateTime(post.createdAt)}
      </p>

      {justMasked && (
        <p className="notice" role="status">
          개인정보로 보이는 내용 {post.maskedCount}건을 ***로 가린 뒤 저장했습니다. 가려진 부분을 확인하십시오.
        </p>
      )}

      <div style={PLAIN_TEXT}>{post.body}</div>

      <form action={toggleLikeAction.bind(null, post.id)} style={{ marginTop: 16 }}>
        <button type="submit" aria-pressed={post.likedByViewer}>
          {post.likedByViewer ? "좋아요 취소" : "좋아요"}
        </button>{" "}
        <span className="muted">좋아요 {post.likeCount}</span>
      </form>

      {canManage(user, post.authorId) && (
        <div style={{ marginTop: 8 }}>
          <DeleteButton
            action={deletePostAction.bind(null, post.id)}
            label="글 삭제"
            confirmMessage="이 글과 댓글, 좋아요를 모두 삭제합니다. 계속하시겠습니까?"
          />
        </div>
      )}

      <h2>댓글 {post.comments.length}</h2>
      {post.comments.length === 0 ? (
        <p className="muted">아직 댓글이 없습니다.</p>
      ) : (
        <ul className="list">
          {post.comments.map((c) => (
            <li key={c.id}>
              <div className="muted">
                {c.authorName} · {formatDateTime(c.createdAt)}
              </div>
              <div style={PLAIN_TEXT}>{c.body}</div>
              {canManage(user, c.authorId) && (
                <DeleteButton
                  action={deleteCommentAction.bind(null, c.id)}
                  label="댓글 삭제"
                  confirmMessage="이 댓글을 삭제하시겠습니까?"
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {isTeacher(user) ? (
        <CommentForm action={addCommentAction.bind(null, post.id)} maxLength={COMMENT_BODY_MAX} />
      ) : (
        <p className="muted">
          댓글 작성은 교사 로그인이 필요합니다. <Link href="/login">교사 로그인</Link>
        </p>
      )}
    </>
  );
}
