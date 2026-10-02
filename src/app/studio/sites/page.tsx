import Link from "next/link";
import { hubOrigin } from "@/lib/origin";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { listMySites } from "@/lib/sites";
import { formatKstDateTime, siteStatus } from "./format";

// 교사 스튜디오: 내 사이트(F-51, F-52). 허브가 직접 호스팅하는 사이트의 미리보기·공개 주소와 승인 상태를 본다.

export default async function StudioSitesPage() {
  const user = await getCurrentUser();
  if (!isTeacher(user)) {
    return (
      <>
        <h1>내 사이트</h1>
        <p className="notice">
          사이트 올리기는 교사 로그인이 필요합니다. <Link href="/login?next=/studio/sites">교사 로그인</Link> 후 다시
          시도하십시오.
        </p>
      </>
    );
  }

  const sites = await listMySites(user, await hubOrigin());

  return (
    <>
      <p className="muted">
        <Link href="/studio">스튜디오</Link> / 내 사이트
      </p>
      <h1>내 사이트</h1>
      <p>
        <Link href="/studio/sites/new" className="button primary">
          폴더 올리기(새 사이트)
        </Link>
      </p>
      <p className="muted">
        사이트 폴더(index.html이 있는 폴더)를 올리면 허브가 직접 호스팅합니다. 올리면 먼저 링크를 아는 사람만 볼 수 있는
        미리보기가 만들어지고, 셀프점검 5문항에 답해 허브에 등록하면 공개 주소가 열립니다. AI 코딩 도구에 맡기려면{" "}
        <Link href="/connect">AI로 연결하기</Link>를 보십시오.
      </p>

      {sites.length === 0 ? (
        <p className="muted">올린 사이트가 없습니다.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>사이트</th>
                <th>미리보기</th>
                <th>공개 주소</th>
                <th>상태</th>
                <th>수정</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => {
                const status = siteStatus(s.approvalStatus, {
                  hasPreview: s.previewUrl !== null,
                  keptPrevious: s.pendingPreviewUrl !== null,
                });
                return (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/studio/sites/${s.id}`}>{s.title}</Link>
                      <div className="muted">
                        <code>{s.slug}</code>
                      </div>
                    </td>
                    <td>
                      {s.previewUrl ? (
                        <a href={s.previewUrl} target="_blank" rel="noopener noreferrer">
                          미리보기
                        </a>
                      ) : (
                        <span className="muted">없음</span>
                      )}
                    </td>
                    <td>
                      {s.liveUrl ? (
                        <a href={s.liveUrl} target="_blank" rel="noopener noreferrer">
                          {s.liveUrl}
                        </a>
                      ) : (
                        <span className="muted">허브 등록 전</span>
                      )}
                    </td>
                    <td>
                      <span className={status.warn ? "badge warn" : "badge"}>{status.label}</span>
                      {s.appId && (
                        <div>
                          <Link href={`/apps/${s.appId}`}>허브 앱 화면</Link>
                        </div>
                      )}
                      {s.pendingPreviewUrl && (
                        <div>
                          <a href={s.pendingPreviewUrl} target="_blank" rel="noopener noreferrer">
                            승인 대기 버전 미리보기
                          </a>
                        </div>
                      )}
                      {!s.appId && !s.previewUrl && (
                        <div className="muted">
                          파일을 끝까지 올리지 못했습니다. <Link href={`/studio/sites/${s.id}`}>사이트 관리</Link>에서 다시
                          올리거나 지우십시오.
                        </div>
                      )}
                    </td>
                    <td>{formatKstDateTime(s.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
