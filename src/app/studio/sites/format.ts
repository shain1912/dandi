import type { ApprovalStatus, MiniApp, SchoolLevel } from "@/lib/types";
import type { PublishValues } from "./actions";

// 사이트 화면(F-51, F-52) 표시 도우미. 서버 컴포넌트에서 쓴다.

export function formatKstDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 허브 등록·승인 상태 문구와 경고 표시 여부.
 * - hasPreview: 확정(미리보기)까지 끝난 버전이 있는가. 없으면 업로드가 중간에 멈춘 사이트다(QA UX-15).
 * - keptPrevious: 새 버전이 승인을 기다리는 동안 공개 주소가 이전 버전을 계속 보여 주는가.
 */
export function siteStatus(
  approval: ApprovalStatus | null,
  opts: { hasPreview: boolean; keptPrevious?: boolean } = { hasPreview: true },
): { label: string; warn: boolean } {
  if (approval === null) {
    return opts.hasPreview ? { label: "허브 등록 전(미리보기만)", warn: false } : { label: "업로드 미완료", warn: true };
  }
  if (approval === "pending") {
    return opts.keptPrevious ? { label: "새 버전 승인 대기(이전 버전 공개 중)", warn: true } : { label: "승인 대기", warn: true };
  }
  if (approval === "approved") return { label: "공개 중(내부 승인 완료)", warn: false };
  return { label: "공개 중", warn: false };
}

/** 처음 등록할 때의 기본값. 셀프점검 답은 비워 두어 교사가 직접 고르게 한다. */
export function emptyPublishValues(title: string, level: SchoolLevel | null): PublishValues {
  return {
    title,
    description: "",
    schoolLevels: level ? [level] : [],
    category: "class",
    collectsStudentData: "",
    storageLocation: "",
    retention: "",
    externalTransfer: "",
    needsSchoolApproval: "",
  };
}

/** 다시 등록할 때는 지난번 등록 내용을 채워 둔다. */
export function publishValuesFromApp(app: MiniApp): PublishValues {
  const yn = (v: boolean) => (v ? "yes" : "no");
  return {
    title: app.title,
    description: app.description,
    schoolLevels: [...app.schoolLevels],
    category: app.category,
    collectsStudentData: yn(app.privacyCheck.collectsStudentData),
    storageLocation: app.privacyCheck.storageLocation,
    retention: app.privacyCheck.retention,
    externalTransfer: yn(app.privacyCheck.externalTransfer),
    needsSchoolApproval: yn(app.privacyCheck.needsSchoolApproval),
  };
}
