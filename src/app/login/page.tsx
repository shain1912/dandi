import { levelLabel } from "@/lib/constants";
import { getCurrentUser } from "@/lib/session";
import { logout } from "./actions";
import { safeNextPath } from "@/lib/origin";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const next = safeNextPath(typeof sp.next === "string" ? sp.next : null) ?? undefined;
  const user = await getCurrentUser();
  if (user.role !== "anon") {
    return (
      <>
        <h1>계정</h1>
        <p>
          {user.name} · {user.role === "admin" ? "교육청 관리자" : "교사"}
          {user.schoolLevel ? ` · ${levelLabel(user.schoolLevel)}` : ""}
        </p>
        {next && (
          <p>
            <a href={next} className="button primary">
              이 계정으로 계속하기
            </a>
          </p>
        )}
        <form action={logout}>
          <button type="submit">로그아웃(익명으로 돌아가기)</button>
        </form>
      </>
    );
  }
  return (
    <>
      <h1>교사 로그인 (데모)</h1>
      <p className="muted">
        학생·방문자는 로그인 없이 미니앱 실행, 글 읽기, 자료 다운로드를 사용할 수 있습니다. 앱 등록·글쓰기·파일
        업로드·AI 키 발급은 교사 로그인이 필요합니다. 프로토타입에서는 구글·카카오 로그인 대신 이름과 학교급만
        입력합니다.
      </p>
      <p className="muted">
        같은 이름·역할로 다시 로그인하면 같은 계정으로 들어가, 전에 등록한 앱·글·자료와 CLI 토큰·API 키를 그대로
        관리할 수 있습니다. 데모 로그인에는 비밀번호가 없으므로 시연용으로만 사용하십시오.
      </p>
      {next && <p className="notice">로그인하면 요청하신 화면(연결 승인)으로 돌아갑니다.</p>}
      <LoginForm next={next} />
    </>
  );
}
