import "server-only";
import type { Result } from "./apps";
import { isLevelOrAll, isPostCategory } from "./constants";
import { mutate, newId, nowIso, readDb } from "./db";
import { maskFields, maskPII } from "./pii";
import { displayName, ensureUser, isTeacher, writeAudit } from "./session";
import type { Comment, Post, PostCategory, SchoolLevel, User } from "./types";

// 커뮤니티 자유 게시판 도메인 로직(F-07).
// - 모든 자유 입력은 저장 직전에 서버 마스킹(F-14)을 거친다.
// - 글·댓글 삭제는 작성자 본인 또는 관리자만 할 수 있다(F-15 프로토타입: 서버 코드 검사, v1.0에서 RLS로 대체).

export const POST_TITLE_MAX = 100;
export const POST_BODY_MAX = 5000;
export const COMMENT_BODY_MAX = 1000;

export interface PostSummary extends Post {
  commentCount: number;
  likeCount: number;
}

export interface PostDetail extends Post {
  comments: Comment[];
  likeCount: number;
  likedByViewer: boolean;
}

/** 폼이나 API에서 받은 값 그대로. category·schoolLevel은 createPost 안에서 검증한다. */
export interface NewPostInput {
  title: string;
  body: string;
  category: string;
  schoolLevel: string;
}

const LOGIN_REQUIRED = "교사 로그인이 필요합니다.";
const POST_NOT_FOUND = "글을 찾을 수 없습니다.";

/** textarea 제출값의 CRLF를 LF로 맞추고 앞뒤 공백을 지운다(글자 수를 브라우저 maxLength와 같게 센다). */
function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/** 작성자 본인 또는 관리자인지 확인한다. 화면의 삭제 버튼 표시와 서버 검사에 같이 쓴다. */
export function canManage(user: User, authorId: string): boolean {
  return isTeacher(user) && (user.id === authorId || user.role === "admin");
}

/**
 * 글 목록. 학교급 필터는 해당 학교급 글과 "전체" 대상 글을 함께 보여 준다.
 * limit을 주면 최신 글부터 그 개수만 돌려준다(허브 대시보드 피드용).
 */
export async function listPosts(
  filter: { level?: SchoolLevel; category?: PostCategory; limit?: number } = {},
): Promise<PostSummary[]> {
  const db = await readDb();
  const commentCounts = countBy(db.comments, (c) => c.postId);
  const likeCounts = countBy(db.likes, (l) => l.postId);
  const posts = db.posts
    .filter((p) => !filter.level || p.schoolLevel === filter.level || p.schoolLevel === "all")
    .filter((p) => !filter.category || p.category === filter.category)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((p) => ({
      ...p,
      commentCount: commentCounts.get(p.id) ?? 0,
      likeCount: likeCounts.get(p.id) ?? 0,
    }));
  return typeof filter.limit === "number" ? posts.slice(0, Math.max(0, filter.limit)) : posts;
}

/** 글 하나와 댓글(오래된 순), 좋아요 수. viewerId를 주면 그 사용자가 좋아요를 눌렀는지도 알려 준다. */
export async function getPost(id: string, viewerId?: string): Promise<PostDetail | null> {
  const db = await readDb();
  const post = db.posts.find((p) => p.id === id);
  if (!post) return null;
  const likes = db.likes.filter((l) => l.postId === id);
  return {
    ...post,
    comments: db.comments
      .filter((c) => c.postId === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    likeCount: likes.length,
    likedByViewer: !!viewerId && likes.some((l) => l.userId === viewerId),
  };
}

export async function createPost(input: NewPostInput, author: User): Promise<Result<Post>> {
  if (!isTeacher(author)) return { ok: false, error: LOGIN_REQUIRED };

  const title = input.title.trim();
  const body = normalizeText(input.body);
  const { category, schoolLevel } = input;
  if (!title) return { ok: false, error: "제목을 입력하십시오." };
  if (title.length > POST_TITLE_MAX) {
    return { ok: false, error: `제목은 ${POST_TITLE_MAX}자 이하로 입력하십시오.` };
  }
  if (!body) return { ok: false, error: "내용을 입력하십시오." };
  if (body.length > POST_BODY_MAX) {
    return { ok: false, error: `내용은 ${POST_BODY_MAX.toLocaleString("ko-KR")}자 이하로 입력하십시오.` };
  }
  if (!isPostCategory(category)) return { ok: false, error: "분류를 선택하십시오." };
  if (!isLevelOrAll(schoolLevel)) return { ok: false, error: "학교급을 선택하십시오." };

  // F-14 서버 마스킹: 클라이언트 필터(F-13)를 우회한 개인정보도 저장 전에 가린다.
  const masked = maskFields({ title, body });

  const post: Post = {
    id: newId("post"),
    title: masked.values.title,
    body: masked.values.body,
    category,
    schoolLevel,
    authorId: author.id,
    authorName: displayName(author),
    maskedCount: masked.count,
    createdAt: nowIso(),
  };

  await mutate((db) => {
    ensureUser(db, author);
    db.posts.push(post);
    writeAudit(
      db,
      author,
      "post.create",
      post.id,
      masked.count ? `개인정보 ${masked.count}건 마스킹(${masked.labels.join(", ")})` : "",
    );
  });
  return { ok: true, value: post };
}

export async function addComment(
  postId: string,
  body: string,
  author: User,
): Promise<Result<{ comment: Comment; maskedCount: number }>> {
  if (!isTeacher(author)) return { ok: false, error: LOGIN_REQUIRED };

  const text = normalizeText(body);
  if (!text) return { ok: false, error: "댓글 내용을 입력하십시오." };
  if (text.length > COMMENT_BODY_MAX) {
    return {
      ok: false,
      error: `댓글은 ${COMMENT_BODY_MAX.toLocaleString("ko-KR")}자 이하로 입력하십시오.`,
    };
  }

  const masked = maskPII(text); // F-14
  const comment: Comment = {
    id: newId("cmt"),
    postId,
    body: masked.text,
    authorId: author.id,
    authorName: displayName(author),
    createdAt: nowIso(),
  };

  return mutate((db): Result<{ comment: Comment; maskedCount: number }> => {
    if (!db.posts.some((p) => p.id === postId)) return { ok: false, error: POST_NOT_FOUND };
    ensureUser(db, author);
    db.comments.push(comment);
    return { ok: true, value: { comment, maskedCount: masked.count } };
  });
}

/** 좋아요 토글. 익명 방문자도 누를 수 있으며, 이때 익명 사용자 레코드를 만든다(F-01). */
export async function toggleLike(
  postId: string,
  user: User,
): Promise<Result<{ liked: boolean; likeCount: number }>> {
  // session.ts는 쿠키가 없으면 "anon_unknown"을 돌려준다. 모든 방문자가 한 id를 공유하지 않도록 막는다.
  if (!user.id || user.id === "anon_unknown") {
    return { ok: false, error: "세션이 없습니다. 페이지를 새로고침하십시오." };
  }
  return mutate((db): Result<{ liked: boolean; likeCount: number }> => {
    if (!db.posts.some((p) => p.id === postId)) return { ok: false, error: POST_NOT_FOUND };
    ensureUser(db, user);
    const idx = db.likes.findIndex((l) => l.postId === postId && l.userId === user.id);
    if (idx >= 0) db.likes.splice(idx, 1);
    else db.likes.push({ postId, userId: user.id });
    const likeCount = db.likes.filter((l) => l.postId === postId).length;
    return { ok: true, value: { liked: idx < 0, likeCount } };
  });
}

/** 글 삭제(F-15 프로토타입). 딸린 댓글과 좋아요도 함께 지운다. */
export async function deletePost(id: string, actor: User): Promise<Result<null>> {
  return mutate((db): Result<null> => {
    const post = db.posts.find((p) => p.id === id);
    if (!post) return { ok: false, error: POST_NOT_FOUND };
    if (!isTeacher(actor)) return { ok: false, error: LOGIN_REQUIRED };
    if (!canManage(actor, post.authorId)) {
      return { ok: false, error: "본인이 쓴 글만 삭제할 수 있습니다." };
    }
    db.posts = db.posts.filter((p) => p.id !== id);
    db.comments = db.comments.filter((c) => c.postId !== id);
    db.likes = db.likes.filter((l) => l.postId !== id);
    writeAudit(db, actor, "post.delete", id, actor.id === post.authorId ? "" : "관리자 삭제");
    return { ok: true, value: null };
  });
}

/** 댓글 삭제(F-15 프로토타입). 성공하면 댓글이 달려 있던 글 id를 돌려준다. */
export async function deleteComment(
  commentId: string,
  actor: User,
): Promise<Result<{ postId: string }>> {
  return mutate((db): Result<{ postId: string }> => {
    const comment = db.comments.find((c) => c.id === commentId);
    if (!comment) return { ok: false, error: "댓글을 찾을 수 없습니다." };
    if (!isTeacher(actor)) return { ok: false, error: LOGIN_REQUIRED };
    if (!canManage(actor, comment.authorId)) {
      return { ok: false, error: "본인이 쓴 댓글만 삭제할 수 있습니다." };
    }
    db.comments = db.comments.filter((c) => c.id !== commentId);
    writeAudit(
      db,
      actor,
      "comment.delete",
      commentId,
      actor.id === comment.authorId ? "" : "관리자 삭제",
    );
    return { ok: true, value: { postId: comment.postId } };
  });
}
