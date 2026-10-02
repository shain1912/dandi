import Link from "next/link";
import { notFound } from "next/navigation";
import { ApproveAppButton } from "@/app/studio/apps/approve-app-button";
import { hubOrigin } from "@/lib/origin";
import { listMyProjects } from "@/lib/projects";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { SITE_ALLOWED_EXT, SITE_LIMITS, getMySite } from "@/lib/sites";
import { FolderUpload } from "../folder-upload";
import { emptyPublishValues, formatBytes, formatKstDateTime, publishValuesFromApp, siteStatus } from "../format";
import { PublishForm } from "../publish-form";
import { DeleteSiteForm, SiteProjectForm } from "../site-settings";

// 사이트 관리(F-51, F-52): 미리보기·공개 주소, 배포 이력, 새 버전 올리기, 허브 등록(셀프점검),
// 연결 프로젝트 바꾸기(F-31), 허브에 등록하지 않은 사이트 지우기.

type Params = Promise<{ id: string }>;

export default async function SiteDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!isTeacher(user)) {
    return (
      <>
        <h1>사이트 관리</h1>
        <p className="notice">
          사이트 관리는 교사 로그인이 필요합니다. <Link href={`/login?next=/studio/sites/${encodeURIComponent(id)}`}>교사 로그인</Link>{" "}
          후 다시 시도하십시오.
        </p>
      </>
    );
  }

  const hub = await hubOrigin();
  const detail = await getMySite(user, id, hub);
  if (!detail) notFound();
  const { summary, app, deploys } = detail;
  const keptPrevious = summary.pendingPreviewUrl !== null;
  const status = siteStatus(summary.approvalStatus, { hasPreview: summary.previewUrl !== null, keptPrevious });
  const ready = deploys.filter((d) => d.status === "ready");
  const defaults = app ? publishValuesFromApp(app) : emptyPublishValues(summary.title, user.schoolLevel);
  const projects = (await listMyProjects(user))
    .filter((p) => p.status === "active")
    .map((p) => ({ id: p.id, name: p.name }));
  // 처음 등록한 앱이 승인 대기 중이면 공개 주소에 연결된 버전은 아직 공개되지 않았다.
  const awaitingFirstApproval = app?.approvalStatus === "pending" && !keptPrevious;

  return (
    <>
      <p className="muted">
        <Link href="/studio">스튜디오</Link> / <Link href="/studio/sites">내 사이트</Link> / {summary.slug}
      </p>
      <h1>{summary.title}</h1>
      <p>
        <span className={status.warn ? "badge warn" : "badge"}>{status.label}</span>
        <span className="badge">
          사이트 id <code>{summary.id}</code>
        </span>
      </p>

      <ul className="list">
        <li>
          미리보기(최신 버전, 링크를 아는 사람만):{" "}
          {summary.previewUrl ? (
            <a href={summary.previewUrl} target="_blank" rel="noopener noreferrer">
              {summary.previewUrl}
            </a>
          ) : (
            <span className="muted">확정된 버전이 없습니다.</span>
          )}
        </li>
        <li>
          공개 주소:{" "}
          {summary.liveUrl ? (
            <a href={summary.liveUrl} target="_blank" rel="noopener noreferrer">
              {summary.liveUrl}
            </a>
          ) : (
            <span className="muted">허브에 등록하면 열립니다.</span>
          )}
        </li>
        {summary.pendingPreviewUrl && (
          <li>
            승인 대기 중인 새 버전:{" "}
            <a href={summary.pendingPreviewUrl} target="_blank" rel="noopener noreferrer">
              {summary.pendingPreviewUrl}
            </a>
          </li>
        )}
        {app && (
          <li>
            허브 앱 화면: <Link href={`/apps/${app.id}`}>{app.title}</Link>
          </li>
        )}
      </ul>

      {app?.approvalStatus === "pending" && (
        <div className="notice">
          <p style={{ margin: 0 }}>
            {keptPrevious
              ? "새 버전 승인 대기: 새 버전의 셀프점검에서 학교 내부 승인이 필요합니다. 내부 승인 완료를 표시할 때까지 공개 주소는 이전에 공개한 버전을 계속 보여 주고, 표시하면 새 버전으로 바뀝니다. 승인 대기 동안 이 앱은 허브 목록과 무로그인 실행에서 빠집니다."
              : "승인 대기: 셀프점검에서 학교 내부 승인이 필요하다고 답했습니다. 내부 승인 완료를 표시하기 전까지 공개 주소는 \"학교 내부 승인 대기 중\" 안내를 보여 주고, 허브 목록과 무로그인 실행에서 빠집니다. 그동안에는 미리보기 주소로 확인하십시오."}
          </p>
          <ApproveAppButton appId={app.id} />
        </div>
      )}

      <h2>배포 이력</h2>
      {deploys.length === 0 ? (
        <p className="muted">배포가 없습니다.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>올린 시각</th>
                <th>상태</th>
                <th>파일</th>
                <th>미리보기</th>
              </tr>
            </thead>
            <tbody>
              {deploys.map((d) => (
                <tr key={d.id}>
                  <td>
                    {formatKstDateTime(d.createdAt)}
                    <div className="muted">
                      <code>{d.id}</code>
                    </div>
                  </td>
                  <td>
                    {d.isPending ? (
                      <span className="badge warn">승인 대기 버전</span>
                    ) : d.isLive ? (
                      <span className={awaitingFirstApproval ? "badge warn" : "badge"}>
                        {awaitingFirstApproval ? "승인 후 공개할 버전" : "공개 버전"}
                      </span>
                    ) : d.status === "ready" ? (
                      <span className="badge">미리보기</span>
                    ) : (
                      <span className="badge warn">올리는 중·확정 안 됨</span>
                    )}
                  </td>
                  <td>
                    {d.fileCount}개 · {formatBytes(d.totalBytes)}
                  </td>
                  <td>
                    {d.previewUrl ? (
                      <a href={d.previewUrl} target="_blank" rel="noopener noreferrer">
                        열기
                      </a>
                    ) : (
                      <span className="muted">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>{app ? "허브 등록 정보 고치기·공개 버전 바꾸기" : "허브에 등록"}</h2>
      {ready.length === 0 ? (
        <p className="muted">미리보기까지 끝난 버전이 없습니다. 아래에서 폴더를 먼저 올리십시오.</p>
      ) : (
        <>
          <p className="muted">
            셀프점검 5문항에 직접 답해야 등록됩니다. 등록하면 공개 주소가 고른 버전을 보여 줍니다.
          </p>
          <PublishForm
            key={ready[0].id /* 새 버전을 올리면 다시 그려 최신 버전이 기본 선택되게 한다 */}
            siteId={summary.id}
            deployOptions={ready.map((d, i) => ({
              id: d.id,
              label: `${formatKstDateTime(d.finalizedAt ?? d.createdAt)} 버전${i === 0 ? " (최신)" : ""}${
                d.isPending ? " · 승인 대기" : d.isLive && !awaitingFirstApproval ? " · 현재 공개" : ""
              }`,
            }))}
            defaults={defaults}
            republish={Boolean(app)}
          />
        </>
      )}

      <h2>새 버전 올리기</h2>
      <p className="muted">
        같은 사이트에 새 버전을 올리면 새 미리보기 주소가 생깁니다. 공개 주소는 허브 등록을 다시 해야 새 버전으로 바뀝니다.
      </p>
      <FolderUpload
        siteId={summary.id}
        limits={SITE_LIMITS}
        allowedExt={SITE_ALLOWED_EXT}
        publishDefaults={defaults}
        republish={Boolean(app)}
        hub={hub}
      />

      <h2>프로젝트</h2>
      <SiteProjectForm siteId={summary.id} projectId={summary.projectId} projects={projects} />

      {!app && (
        <>
          <h2>사이트 삭제</h2>
          <p className="muted">
            허브에 등록하지 않은 사이트만 지울 수 있습니다. 업로드가 중간에 멈춘 사이트나 더 쓰지 않는 미리보기를 정리할 때
            쓰십시오.
          </p>
          <DeleteSiteForm siteId={summary.id} slug={summary.slug} />
        </>
      )}
    </>
  );
}
