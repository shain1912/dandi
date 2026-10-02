import Link from "next/link";
import { UPLOAD_ALLOWED_EXT, UPLOAD_MAX_BYTES } from "@/lib/constants";
import { DESCRIPTION_MAX, formatBytes, TITLE_MAX } from "@/lib/files";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { UploadForm } from "./upload-form";

export default async function FileUploadPage() {
  const user = await getCurrentUser();

  if (!isTeacher(user)) {
    return (
      <>
        <h1>자료 업로드</h1>
        <p className="notice">
          자료 업로드는 교사 로그인이 필요합니다. <Link href="/login">교사 로그인</Link> 후 다시 시도하십시오.
        </p>
        <p>
          <Link href="/files">자료실로 돌아가기</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>자료 업로드</h1>
      <ul className="muted">
        <li>허용 확장자: {UPLOAD_ALLOWED_EXT.map((e) => `.${e}`).join(", ")}</li>
        <li>파일당 최대 {formatBytes(UPLOAD_MAX_BYTES)}</li>
        <li>
          제목·설명·파일 이름에 학생 이름과 연락처 같은 개인정보를 넣지 마십시오. 서버에서 개인정보 패턴을
          찾으면 ***로 가린 뒤 저장합니다.
        </li>
        <li>올린 자료는 로그인하지 않은 방문자도 내려받을 수 있습니다.</li>
      </ul>
      <UploadForm
        defaultLevel={user.schoolLevel ?? "all"}
        titleMax={TITLE_MAX}
        descriptionMax={DESCRIPTION_MAX}
      />
      <p>
        <Link href="/files">자료실로 돌아가기</Link>
      </p>
    </>
  );
}
