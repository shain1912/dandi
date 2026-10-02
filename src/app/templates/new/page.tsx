import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { TemplateForm } from "./template-form";

export const metadata: Metadata = { title: "새 템플릿 등록 · Dandi" };

// F-10 교사가 새 템플릿(작업 지시서 + 예시 사이트)을 등록한다.
export default async function NewTemplatePage() {
  const user = await getCurrentUser();
  if (!isTeacher(user)) {
    return (
      <>
        <h1>새 템플릿 등록</h1>
        <p className="notice">
          템플릿 등록은 교사만 사용할 수 있습니다. <Link href="/login">교사 로그인</Link> 후 다시 시도하십시오.
        </p>
        <p>
          <Link href="/templates">템플릿 갤러리로 돌아가기</Link>
        </p>
      </>
    );
  }
  return (
    <>
      <p className="muted">
        <Link href="/templates">템플릿 갤러리</Link> / 새 템플릿
      </p>
      <h1>새 템플릿 등록</h1>
      <p className="muted">
        내가 만든 앱의 작업 지시서와 예시 사이트를 동료 교사와 나눕니다. 작업 지시서에는 학생 이름, 연락처 같은
        개인정보를 넣지 마십시오. 입력 중에는 경고가 표시되고, 저장할 때 서버에서 한 번 더 가립니다.
      </p>
      <TemplateForm defaultLevel={user.schoolLevel} />
    </>
  );
}
