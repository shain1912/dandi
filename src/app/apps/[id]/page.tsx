import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppMetaBadges, AppPrivacyBadges, formatKstDate } from "@/components/app-card";
import { AppRunCounter } from "@/components/app-run-counter";
import { canViewApp, getApp } from "@/lib/apps";
import { hubOrigin } from "@/lib/origin";
import { previewUrlForApp } from "@/lib/sites";
import { getCurrentUser } from "@/lib/session";
import { ApproveAppButton } from "@/app/studio/apps/approve-app-button";

// 미니앱 실행 화면(F-05): 허브 안 임베드 실행 + 새 창 열기, 개인정보 셀프점검 결과(F-06, F-16).

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const app = await getApp(id);
  // 승인 대기 앱의 제목이 메타데이터로 새지 않도록 열람 권한을 같이 본다.
  return app && canViewApp(app, await getCurrentUser()) ? { title: `${app.title} · Dandi` } : {};
}

function yesNo(v: boolean): string {
  return v ? "예" : "아니요";
}

export default async function AppRunPage({ params }: { params: Params }) {
  const { id } = await params;
  const app = await getApp(id);
  const user = await getCurrentUser();
  // F-16: 승인 대기 앱은 작성자·관리자에게만 보인다. 다른 사람에게는 존재 자체를 드러내지 않는다.
  if (!app || !canViewApp(app, user)) notFound();
  const canManage = user.role === "admin" || (user.role === "teacher" && user.id === app.authorId);
  const pc = app.privacyCheck;
  // 승인 대기 중인 허브 호스팅 앱: 공개 주소는 "승인 대기" 안내만 보이므로, 작성자·관리자에게는 미리보기를 보여 준다.
  const previewUrl =
    app.approvalStatus === "pending" && canManage ? await previewUrlForApp(app.id, await hubOrigin()) : null;
  const frameUrl = previewUrl ?? app.url;

  return (
    <>
      <p className="muted">
        <Link href="/apps">미니앱 목록</Link>
      </p>
      <h1>{app.title}</h1>
      <p>
        <AppMetaBadges app={app} /> <AppPrivacyBadges app={app} />
      </p>
      {app.description && <p>{app.description}</p>}
      <p className="muted">
        {app.authorName} · 실행 {app.runs.toLocaleString("ko-KR")}회 · 등록 {formatKstDate(app.createdAt)}
        {canManage && (
          <>
            {" "}
            · <Link href="/studio/apps">내 앱 관리</Link>
          </>
        )}
      </p>

      {app.approvalStatus === "pending" && (
        <div className="notice">
          <p style={{ margin: 0 }}>
            승인 대기: 셀프점검에서 학교 내부 승인이 필요하다고 답한 앱입니다. 내부 승인 완료를 표시하기 전까지는
            작성자와 관리자만 이 화면을 볼 수 있고, 허브 목록과 무로그인 실행에서 빠집니다.
          </p>
          {canManage && <ApproveAppButton appId={app.id} />}
        </div>
      )}

      {app.handlesPersonalData && (
        <p className="notice">
          이 앱은 학생 개인정보를 처리합니다. 학교 내부 승인(운영위원회 등) 여부를 확인한 뒤 사용하십시오.
        </p>
      )}

      {previewUrl && (
        <p className="muted">
          승인 전이라 공개 주소 대신 비공개 미리보기를 보여 드립니다. 미리보기 주소는 링크를 아는 사람만 볼 수
          있습니다.
        </p>
      )}
      <p>
        <a href={frameUrl} target="_blank" rel="noopener noreferrer" className="button">
          {previewUrl ? "미리보기 새 창으로 열기" : "새 창으로 열기"}
        </a>
      </p>
      <iframe
        className="app-frame"
        src={frameUrl}
        title={app.title}
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"
      />
      <p className="muted">
        화면이 보이지 않으면 배포 사이트가 다른 사이트 안에서 열리는 것을 막아 둔 경우입니다. 새 창으로 열기를
        사용하십시오.
      </p>

      <h2>개인정보 셀프점검 결과</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <th scope="row">학생 개인정보 수집·처리</th>
              <td>{yesNo(pc.collectsStudentData)}</td>
            </tr>
            <tr>
              <th scope="row">데이터 저장 위치</th>
              <td>{pc.storageLocation}</td>
            </tr>
            <tr>
              <th scope="row">보관 기간</th>
              <td>{pc.retention}</td>
            </tr>
            <tr>
              <th scope="row">외부 전송(해외 AI API 등)</th>
              <td>{yesNo(pc.externalTransfer)}</td>
            </tr>
            <tr>
              <th scope="row">학교 내부 승인 필요</th>
              <td>{yesNo(pc.needsSchoolApproval)}</td>
            </tr>
            <tr>
              <th scope="row">점검 완료일</th>
              <td>{formatKstDate(pc.checkedAt) || "기록 없음"}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="muted">셀프점검 내용은 앱을 등록한 교사가 직접 작성한 것입니다.</p>

      <AppRunCounter appId={app.id} />
    </>
  );
}
