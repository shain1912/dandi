"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { addComment, createPost, deleteComment, deletePost, toggleLike } from "@/lib/community";
import { AuthError, getCurrentUser, requireTeacher } from "@/lib/session";
import type { User } from "@/lib/types";

// 커뮤니티 서버 액션(F-07). 화면에서 버튼을 숨겨도 여기서 권한을 다시 확인한다(F-15 프로토타입).
// 개인정보 마스킹(F-14)과 입력 검증은 lib/community.ts가 맡는다.

export type FormState = {
  error?: string;
  notice?: string;
  /** 댓글 폼을 성공할 때마다 새로 그리기 위한 번호 */
  seq?: number;
};

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

/** 교사이면 사용자, 아니면 오류 문구를 돌려준다. */
async function teacherOrError(): Promise<User | string> {
  try {
    return await requireTeacher();
  } catch (err) {
    if (err instanceof AuthError) return err.message;
    throw err;
  }
}

function revalidateLists(): void {
  revalidatePath("/community");
  revalidatePath("/"); // 허브 대시보드의 커뮤니티 피드
}

export async function createPostAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await teacherOrError();
  if (typeof user === "string") return { error: user };

  const result = await createPost(
    {
      title: field(formData, "title"),
      body: field(formData, "body"),
      category: field(formData, "category"),
      schoolLevel: field(formData, "schoolLevel"),
    },
    user,
  );
  if (!result.ok) return { error: result.error };

  revalidateLists();
  const { id, maskedCount } = result.value;
  redirect(maskedCount > 0 ? `/community/${id}?masked=${maskedCount}` : `/community/${id}`);
}

/** 댓글 등록. addCommentAction.bind(null, postId)로 useActionState에 넘긴다. */
export async function addCommentAction(
  postId: string,
  prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const seq = prev?.seq ?? 0;
  if (typeof postId !== "string") return { error: "잘못된 요청입니다.", seq };
  const user = await teacherOrError();
  if (typeof user === "string") return { error: user, seq };

  const result = await addComment(postId, field(formData, "body"), user);
  if (!result.ok) return { error: result.error, seq };

  revalidatePath(`/community/${postId}`);
  revalidatePath("/community");
  const { maskedCount } = result.value;
  return {
    seq: seq + 1,
    notice:
      maskedCount > 0
        ? `개인정보로 보이는 내용 ${maskedCount}건을 ***로 가린 뒤 댓글을 저장했습니다.`
        : undefined,
  };
}

/** 좋아요 토글. 익명 방문자도 사용할 수 있다. toggleLikeAction.bind(null, postId)로 form action에 넘긴다. */
export async function toggleLikeAction(postId: string): Promise<void> {
  if (typeof postId !== "string") return;
  const user = await getCurrentUser();
  const result = await toggleLike(postId, user);
  if (!result.ok) return;
  revalidatePath(`/community/${postId}`);
  revalidatePath("/community");
}

/** 글 삭제. deletePostAction.bind(null, postId)로 useActionState에 넘긴다. */
export async function deletePostAction(postId: string): Promise<FormState> {
  if (typeof postId !== "string") return { error: "잘못된 요청입니다." };
  const user = await getCurrentUser();
  const result = await deletePost(postId, user);
  if (!result.ok) return { error: result.error };
  revalidateLists();
  redirect("/community");
}

/** 댓글 삭제. deleteCommentAction.bind(null, commentId)로 useActionState에 넘긴다. */
export async function deleteCommentAction(commentId: string): Promise<FormState> {
  if (typeof commentId !== "string") return { error: "잘못된 요청입니다." };
  const user = await getCurrentUser();
  const result = await deleteComment(commentId, user);
  if (!result.ok) return { error: result.error };
  revalidatePath(`/community/${result.value.postId}`);
  revalidatePath("/community");
  return {};
}
