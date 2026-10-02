import Link from "next/link";
import { listMyProjects } from "@/lib/projects";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { NewAppForm } from "./new-app-form";

// 미니앱 등록(F-04, F-16). 교사 전용.
export default async function NewAppPage() {
  const user = await getCurrentUser();
  if (!isTeacher(user)) {
    return (
      <>
        <h1>미니앱 등록</h1>
        <p className="notice">
          미니앱 등록은 교사 로그인이 필요합니다. <Link href="/login">교사 로그인</Link> 후 다시 시도하십시오.
        </p>
      </>
    );
  }
  return (
    <>
      <p className="muted">
        <Link href="/studio/apps">내 미니앱</Link>
      </p>
      <h1>미니앱 등록</h1>
      <p className="muted">
        다른 곳(Vercel 등)에 배포한 앱의 URL을 등록합니다. 정적 사이트는 <Link href="/studio/sites/new">허브에 직접 올리는 것</Link>이 더 간단합니다. 설명과 셀프점검에 적힌 개인정보는 저장 전에 자동으로
        가려집니다. 터미널에서 <code>dandi publish</code>로도 등록할 수 있습니다(<Link href="/studio/cli">CLI
        토큰 발급</Link>).
      </p>
      <NewAppForm
        defaultLevel={user.schoolLevel}
        projects={(await listMyProjects(user)).filter((p) => p.status === "active").map((p) => ({ id: p.id, name: p.name }))}
      />
    </>
  );
}
