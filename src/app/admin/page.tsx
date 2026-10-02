import Link from "next/link";
import { DEPLOYMENT_LABEL, formatKst, monthKey, sumUsage } from "@/lib/ai";
import { MODEL_STATUS_LABEL } from "@/lib/constants";
import { readDb } from "@/lib/db";
import { projectStatsIn, TEACHER_MONTHLY_CAP } from "@/lib/projects";
import { getCurrentUser } from "@/lib/session";
import type { AuditEntry } from "@/lib/types";
import { ApproveAppButton } from "@/app/studio/apps/approve-app-button";
import { AddModelForm, ModelGuideForm, ModelStatusForm } from "./model-forms";

// [관리자: 모델 정책] 화면 (PRD 9): 모델별 허용/보류/차단(F-23), 정책 변경 이력(F-24), 운영 요약.

const n = (v: number) => v.toLocaleString("ko-KR");

const ACTION_LABEL: Record<string, string> = {
  "model.status": "모델 상태 변경",
  "model.add": "모델 추가",
  "model.guide": "모델 가이드 수정",
  "project.create": "프로젝트 생성",
  "project.update": "프로젝트 수정",
  "project.budget.update": "프로젝트 예산 변경",
  "project.models.update": "프로젝트 모델 변경",
  "project.archive": "프로젝트 보관",
  "apikey.create": "API 키 발급",
  "apikey.disable": "API 키 비활성화",
  "apikey.enable": "API 키 다시 켜기",
  "apikey.delete": "API 키 삭제",
  "skill.publish": "스킬 게시",
  "skill.approve": "스킬 승인",
  "skill.reject": "스킬 반려",
  "cli.device.approve": "CLI 기기 승인",
  "cli.device.deny": "CLI 기기 거부",
  "oauth.authorize.approve": "AI 도구 연결 허용",
  "oauth.authorize.deny": "AI 도구 연결 거부",
  "oauth.token.issue": "AI 도구 토큰 발급",
  "oauth.code.reuse": "인가 코드 재사용 감지",
  "oauth.refresh.reuse": "갱신 토큰 재사용 감지",
  "oauth.connection.revoke": "AI 도구 연결 해제",
  "apikey.issue": "API 키 발급",
  "apikey.revoke": "API 키 폐기",
  "auth.demo_login": "데모 로그인",
  "app.create": "앱 등록",
  "app.delete": "앱 삭제",
  "app.approve": "앱 내부 승인 완료",
  "comment.delete": "댓글 삭제",
  "file.upload": "파일 업로드",
  "file.delete": "파일 삭제",
  "post.create": "글 작성",
  "post.delete": "글 삭제",
  "comment.create": "댓글 작성",
  "template.create": "템플릿 등록",
  "cli.token.issue": "CLI 토큰 발급",
  "cli.token.revoke": "CLI 토큰 폐기",
};

const LOG_FILTERS = [
  { id: "all", label: "전체" },
  { id: "model", label: "모델 정책만" },
  { id: "apikey", label: "API 키만" },
  { id: "app", label: "미니앱만" },
  { id: "project", label: "프로젝트만" },
  { id: "skill", label: "스킬만" },
  { id: "oauth", label: "AI 도구 연결만" },
] as const;
type LogFilter = (typeof LOG_FILTERS)[number]["id"];

function isLogFilter(v: unknown): v is LogFilter {
  return LOG_FILTERS.some((f) => f.id === v);
}

function matchesFilter(entry: AuditEntry, filter: LogFilter): boolean {
  if (filter === "all") return true;
  return entry.action.startsWith(`${filter}.`);
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await getCurrentUser();
  if (user.role !== "admin") {
    return (
      <>
        <h1>관리자</h1>
        <p className="notice">
          교육청 관리자만 사용할 수 있는 화면입니다. <Link href="/login">데모 로그인</Link>에서 &apos;교육청
          관리자(데모)&apos; 역할로 로그인하십시오.
        </p>
      </>
    );
  }

  const sp = await searchParams;
  const logFilter: LogFilter = isLogFilter(sp.log) ? sp.log : "all";

  const db = await readDb();
  const month = monthKey();
  const usageThisMonth = db.usage.filter((r) => monthKey(r.createdAt) === month);
  const projectStats = projectStatsIn(db, month);
  const roleCount = (role: string) => db.users.filter((u) => u.role === role).length;
  const statusCount = (s: keyof typeof MODEL_STATUS_LABEL) => db.models.filter((m) => m.status === s).length;
  const pendingApps = db.apps.filter((a) => a.approvalStatus === "pending");
  const audit = [...db.audit]
    .filter((e) => matchesFilter(e, logFilter))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 100);

  const summary: [string, string][] = [
    [
      "사용자",
      `교사 ${n(roleCount("teacher"))}명 · 관리자 ${n(roleCount("admin"))}명 · 익명(활동 기록) ${n(roleCount("anon"))}명`,
    ],
    ["미니앱", `${n(db.apps.length)}개 (승인 대기 ${n(pendingApps.length)}개)`],
    ["게시글", `${n(db.posts.length)}개 (댓글 ${n(db.comments.length)}개)`],
    ["자료실 파일", `${n(db.files.length)}개`],
    ["템플릿", `${n(db.templates.length)}개`],
    // 프로젝트·키 통계(F-31 ~ F-33)
    [
      "프로젝트",
      `${n(projectStats.projects)}개 (활성 ${n(projectStats.activeProjects)} · 보관 ${n(projectStats.archivedProjects)}) · 교사 ${n(
        projectStats.owners,
      )}명 · 이번 달 예산 80% 넘은 프로젝트 ${n(projectStats.alertProjects)}개 · 교사 전체 상한(${n(
        TEACHER_MONTHLY_CAP,
      )}토큰) 도달 교사 ${n(projectStats.teachersAtCap)}명`,
    ],
    [
      "프로젝트 API 키",
      `사용 중 ${n(projectStats.keysActive)}개 (7일 안에 만료 ${n(projectStats.keysExpiringSoon)}) · 비활성화 ${n(
        projectStats.keysDisabled,
      )} · 만료 ${n(projectStats.keysExpired)} · 누적 발급 ${n(projectStats.keysTotal)}개`,
    ],
    [
      `이번 달(${month}) AI 사용`,
      `${n(sumUsage(db.usage, { month }))}토큰 · 호출 ${n(usageThisMonth.length)}회 · 프롬프트 개인정보 마스킹 ${n(
        usageThisMonth.reduce((s, r) => s + r.piiMasked, 0),
      )}건`,
    ],
    [
      "모델",
      `허용 ${statusCount("allowed")} · 보류 ${statusCount("pending")} · 차단 ${statusCount("blocked")}`,
    ],
  ];

  return (
    <>
      <h1>관리자</h1>

      <h2>운영 요약</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            {summary.map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>모델 허용 정책</h2>
      <p className="notice">허용 여부는 교육청 정책 판단에 따릅니다(PRD Q1). 시드 값은 시연용입니다.</p>
      <p className="muted">
        상태를 바꾸면 교사 화면(/ai)과 게이트웨이(/api/ai/chat)에 즉시 반영되고, 아래 감사 로그에 누가 언제 무엇을
        바꿨는지 남습니다.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>모델</th>
              <th>제공사 · 개발 국가</th>
              <th>실행 방식 · 데이터 처리 위치</th>
              <th>현재 상태</th>
              <th>변경</th>
            </tr>
          </thead>
          <tbody>
            {db.models.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.name}
                  <br />
                  <code className="muted">{m.id}</code>
                </td>
                <td>
                  {m.provider} · {m.origin}
                </td>
                <td>
                  {DEPLOYMENT_LABEL[m.deployment]} · {m.dataLocation}
                  <br />
                  <span className="muted">권장 용도: {m.recommendedUse}</span>
                  <ModelGuideForm key={m.id} model={m} />
                </td>
                <td>
                  <span className={m.status === "allowed" ? "badge" : "badge warn"}>
                    {MODEL_STATUS_LABEL[m.status]}
                  </span>
                  <br />
                  <span className="muted">{formatKst(m.updatedAt)}</span>
                </td>
                <td>
                  <ModelStatusForm modelId={m.id} status={m.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>모델 추가</h2>
      <AddModelForm />

      <h2>스킬 검토</h2>
      <p>
        <Link href="/admin/skills">스킬 검토 대기열</Link>에서 스크립트·훅이 들어 있는 스킬 버전을 승인하거나 반려합니다(F-40).
      </p>

      <h2>승인 대기 미니앱</h2>
      <p className="muted">
        셀프점검에서 학교 내부 승인이 필요하다고 답한 앱입니다(F-16). 승인 완료를 표시하기 전까지 허브 목록과 무로그인
        실행에서 빠집니다. 승인 여부 확인 주체는 미결 사항입니다(PRD Q5).
      </p>
      {pendingApps.length === 0 ? (
        <p className="muted">승인 대기 중인 앱이 없습니다.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>앱</th>
                <th>등록자</th>
                <th>학생 개인정보 · 저장 위치 · 보관 기간</th>
                <th>처리</th>
              </tr>
            </thead>
            <tbody>
              {pendingApps.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link href={`/apps/${a.id}`}>{a.title}</Link>
                  </td>
                  <td>{a.authorName}</td>
                  <td>
                    {a.privacyCheck.collectsStudentData ? "처리함" : "처리 안 함"} · {a.privacyCheck.storageLocation} ·{" "}
                    {a.privacyCheck.retention}
                  </td>
                  <td>
                    <ApproveAppButton appId={a.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>감사 로그</h2>
      <p className="muted">최근 100건. 모델 정책 변경(F-24), API 키 발급, 파일 업로드 등 기록 대상 작업을 보여 줍니다.</p>
      <nav className="filter" aria-label="감사 로그 필터">
        {LOG_FILTERS.map((f) => (
          <Link
            key={f.id}
            href={f.id === "all" ? "/admin" : `/admin?log=${f.id}`}
            aria-current={f.id === logFilter ? "page" : undefined}
          >
            {f.label}
          </Link>
        ))}
      </nav>
      {audit.length === 0 ? (
        <p className="muted">기록이 없습니다.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>시각</th>
                <th>사용자</th>
                <th>작업</th>
                <th>대상</th>
                <th>내용</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{formatKst(e.createdAt)}</td>
                  <td>{e.actorName}</td>
                  <td>
                    {ACTION_LABEL[e.action] ?? e.action}
                    <br />
                    <code className="muted">{e.action}</code>
                  </td>
                  <td>
                    <code>{e.target}</code>
                  </td>
                  <td>{e.detail || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
