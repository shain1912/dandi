import Link from "next/link";
import { appCategoryLabel, levelLabel } from "@/lib/constants";
import type { MiniApp } from "@/lib/types";

// 미니앱 카드(F-05 바로 실행, F-06 개인정보 표시). 허브(/)와 미니앱 목록(/apps)이 함께 사용한다.

/** ISO 시각을 한국 시간 기준 YYYY-MM-DD로 바꾼다. 서버 컴포넌트에서만 사용한다. */
export function formatKstDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** 셀프점검 답변 요약 배지(F-06): 학생 개인정보 처리, 외부 전송, 학교 내부 승인 상태. */
export function AppPrivacyBadges({ app }: { app: MiniApp }) {
  const approvedAt = formatKstDate(app.approvedAt);
  return (
    <>
      {app.handlesPersonalData ? (
        <span className="badge warn">학생 개인정보 처리</span>
      ) : (
        <span className="badge">학생 개인정보 없음</span>
      )}
      {app.privacyCheck?.externalTransfer && <span className="badge warn">외부 전송 있음</span>}
      {app.approvalStatus === "pending" && <span className="badge warn">승인 대기</span>}
      {app.approvalStatus === "approved" && (
        <span className="badge">내부 승인 완료{approvedAt ? ` ${approvedAt}` : ""}</span>
      )}
    </>
  );
}

export function AppMetaBadges({ app }: { app: MiniApp }) {
  return (
    <>
      <span className="badge">{appCategoryLabel(app.category)}</span>
      {app.schoolLevels.map((l) => (
        <span key={l} className="badge">
          {levelLabel(l)}
        </span>
      ))}
    </>
  );
}

export function AppCard({ app }: { app: MiniApp }) {
  return (
    <li>
      <div>
        <strong>
          <Link href={`/apps/${app.id}`}>{app.title}</Link>
        </strong>{" "}
        <AppMetaBadges app={app} />
      </div>
      {app.description && <p style={{ margin: "4px 0" }}>{app.description}</p>}
      <div className="muted">
        <AppPrivacyBadges app={app} /> 실행 {app.runs.toLocaleString("ko-KR")}회 · {app.authorName}
      </div>
      <p style={{ margin: "6px 0 0" }}>
        <Link href={`/apps/${app.id}`} className="button primary">
          바로 실행
        </Link>
      </p>
    </li>
  );
}
