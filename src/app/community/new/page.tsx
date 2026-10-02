import Link from "next/link";
import { POST_BODY_MAX, POST_TITLE_MAX } from "@/lib/community";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { PostForm } from "./post-form";

// 글쓰기(F-07). 교사만 사용할 수 있고, 학교급 기본값은 프로필의 학교급이다(F-03).

export default async function NewPostPage() {
  const user = await getCurrentUser();

  if (!isTeacher(user)) {
    return (
      <>
        <h1>글쓰기</h1>
        <p className="notice">
          글쓰기는 교사 로그인이 필요합니다. <Link href="/login">교사 로그인</Link> 후 다시 시도하십시오.
        </p>
        <p>
          <Link href="/community">목록으로</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>글쓰기</h1>
      <p className="muted">
        전화번호·주민등록번호·이메일 같은 개인정보를 입력하면 경고하고 등록을 막습니다. 이 확인을 거치지 않은
        개인정보도 서버에서 ***로 가린 뒤 저장합니다.
      </p>
      <PostForm
        defaultLevel={user.schoolLevel ?? "all"}
        titleMax={POST_TITLE_MAX}
        bodyMax={POST_BODY_MAX}
      />
      <p>
        <Link href="/community">목록으로</Link>
      </p>
    </>
  );
}
