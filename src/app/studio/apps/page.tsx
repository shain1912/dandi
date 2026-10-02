import Link from "next/link";
import { AppPrivacyBadges, formatKstDate } from "@/components/app-card";
import { appCategoryLabel, levelLabel } from "@/lib/constants";
import { readDb } from "@/lib/db";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { ApproveAppButton } from "./approve-app-button";
import { DeleteAppButton } from "./delete-app-button";

// 교사 스튜디오: 내가 등록한 미니앱 관리(F-04). 관리자는 모든 앱을 본다.
export default async function StudioAppsPage() {
  const user = await getCurrentUser();
  if (!isTeacher(user)) {
    return (
      <>
        <h1>내 미니앱</h1>
        <p className="notice">
          미니앱 관리는 교사 로그인이 필요합니다. <Link href="/login">교사 로그인</Link> 후 다시 시도하십시오.
        </p>
      </>
    );
  }

  const isAdmin = user.role === "admin";
  const db = await readDb();
  const apps = db.apps
    .filter((a) => isAdmin || a.authorId === user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <>
      <p className="muted">
        <Link href="/studio">스튜디오</Link>
      </p>
      <h1>{isAdmin ? "전체 미니앱 관리" : "내 미니앱"}</h1>
      <p>
        <Link href="/studio/apps/new" className="button primary">
          새 미니앱 등록
        </Link>
      </p>
      {isAdmin && <p className="muted">관리자는 모든 교사의 앱을 보고 삭제할 수 있습니다.</p>}
      <p className="muted">
        &quot;승인 대기&quot; 앱은 허브 목록과 무로그인 실행에서 빠져 있습니다. 운영위원회 등 학교 내부 승인을 받은 뒤
        &quot;내부 승인 완료 표시&quot;를 누르면 공개됩니다.
      </p>

      {apps.length === 0 ? (
        <p className="muted">등록한 미니앱이 없습니다.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>앱 이름</th>
                <th>분류</th>
                <th>학교급</th>
                <th>개인정보·승인</th>
                <th>실행 수</th>
                {isAdmin && <th>등록자</th>}
                <th>등록일</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => (
                <tr key={app.id}>
                  <td>
                    <Link href={`/apps/${app.id}`}>{app.title}</Link>
                  </td>
                  <td>{appCategoryLabel(app.category)}</td>
                  <td>{app.schoolLevels.map((l) => levelLabel(l)).join(", ")}</td>
                  <td>
                    <AppPrivacyBadges app={app} />
                  </td>
                  <td>{app.runs.toLocaleString("ko-KR")}</td>
                  {isAdmin && <td>{app.authorName}</td>}
                  <td>{formatKstDate(app.createdAt)}</td>
                  <td>
                    {app.approvalStatus === "pending" && <ApproveAppButton appId={app.id} />}
                    <DeleteAppButton appId={app.id} title={app.title} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
