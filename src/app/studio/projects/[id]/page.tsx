import Link from "next/link";
import { notFound } from "next/navigation";
import { teacherStatusLabel } from "@/lib/ai";
import { hubOrigin } from "@/lib/origin";
import {
  BUDGET_ALERT_PCT,
  DEFAULT_EXPIRY,
  EXPIRY_PRESETS,
  formatKeyIp,
  formatKst,
  getProjectDetail,
  KEY_ROLES,
  KEY_STATUS_LABEL,
  keyRoleLabel,
  LOCAL_CLIENT_IP,
  MAX_PROJECT_BUDGET,
  MIN_PROJECT_BUDGET,
  semesterEnd,
  type ProjectDetail,
} from "@/lib/projects";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { KeyCreateForm } from "./key-create-form";
import { KeyRowActions } from "./key-row-actions";
import { ModelsForm } from "./models-form";
import { ArchiveProjectForm, SettingsForm } from "./settings-form";

// [프로젝트 /studio/projects/[id]] 개요 · 키 · 사용량 · 모델 · 설정 탭(?tab=) (F-31 ~ F-35).

const TABS = [
  { id: "overview", label: "개요" },
  { id: "keys", label: "키" },
  { id: "usage", label: "사용량" },
  { id: "models", label: "모델" },
  { id: "settings", label: "설정" },
] as const;
type Tab = (typeof TABS)[number]["id"];

function isTab(v: unknown): v is Tab {
  return TABS.some((t) => t.id === v);
}

const n = (v: number) => v.toLocaleString("ko-KR");

function BudgetBadge({ pct }: { pct: number }) {
  if (pct >= 100) return <span className="badge warn">예산 소진, 호출 차단</span>;
  if (pct >= BUDGET_ALERT_PCT) return <span className="badge warn">예산 {BUDGET_ALERT_PCT}% 넘음</span>;
  return null;
}

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const user = await getCurrentUser();
  if (!isTeacher(user)) {
    return (
      <>
        <h1>프로젝트</h1>
        <p className="notice">
          프로젝트는 교사 로그인 후 사용할 수 있습니다.{" "}
          <Link href={`/login?next=${encodeURIComponent(`/studio/projects/${id}`)}`}>교사 로그인</Link>
        </p>
      </>
    );
  }
  const detail = await getProjectDetail(user, id);
  if (!detail) notFound();
  const tab: Tab = isTab(sp.tab) ? sp.tab : "overview";
  const { project } = detail;
  const archived = project.status === "archived";
  const hub = await hubOrigin();

  return (
    <>
      <p className="muted">
        <Link href="/studio">스튜디오</Link> / <Link href="/studio/projects">프로젝트</Link> / {project.name}
      </p>
      <h1>
        {project.name} {archived && <span className="badge">보관됨</span>}
      </h1>
      {project.description && <p className="muted">{project.description}</p>}
      {archived && (
        <p className="notice">
          보관한 프로젝트입니다. 키는 모두 비활성화되어 게이트웨이를 호출할 수 없고, 설정과 키를 바꿀 수 없습니다.
        </p>
      )}

      <nav className="filter" aria-label="프로젝트 탭">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={t.id === "overview" ? `/studio/projects/${project.id}` : `/studio/projects/${project.id}?tab=${t.id}`}
            aria-current={t.id === tab ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "overview" && <OverviewTab detail={detail} />}
      {tab === "keys" && <KeysTab detail={detail} hub={hub} />}
      {tab === "usage" && <UsageTab detail={detail} />}
      {tab === "models" && <ModelsTab detail={detail} />}
      {tab === "settings" && <SettingsTab detail={detail} archivedKeys={archivedKeysParam(sp.archived)} />}
    </>
  );
}

function OverviewTab({ detail }: { detail: ProjectDetail }) {
  const { project, usage, keys, effective, sites, apps } = detail;
  const activeKeys = keys.filter((k) => k.status === "active");
  const expiring = activeKeys.filter((k) => k.expiryWarning);
  const defaultApps = apps.filter((a) => a.link === "default").length;
  return (
    <>
      <h2>개요</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <th scope="row">프로젝트 ID</th>
              <td>
                <code>{project.id}</code>
              </td>
            </tr>
            <tr>
              <th scope="row">상태</th>
              <td>{project.status === "active" ? "사용 중" : "보관됨"}</td>
            </tr>
            <tr>
              <th scope="row">소유 교사 · 만든 날짜</th>
              <td>
                {detail.owner.name} · {formatKst(project.createdAt)}
              </td>
            </tr>
            <tr>
              <th scope="row">이번 달({usage.month}) 사용량</th>
              <td>
                {n(usage.projectTokens)} / {n(usage.budget)}토큰 ({usage.budgetPct}%) <BudgetBadge pct={usage.budgetPct} />
              </td>
            </tr>
            <tr>
              <th scope="row">교사 전체 상한</th>
              <td>
                {n(usage.teacherTokens)} / {n(usage.teacherCap)}토큰 ({usage.teacherPct}%, 모든 프로젝트 합계){" "}
                <BudgetBadge pct={usage.teacherPct} />
              </td>
            </tr>
            <tr>
              <th scope="row">사용 중인 키</th>
              <td>
                <Link href={`/studio/projects/${project.id}?tab=keys`}>{activeKeys.length}개</Link>
                {expiring.length > 0 && <span className="badge warn">곧 만료되는 키 {expiring.length}개</span>}
              </td>
            </tr>
            <tr>
              <th scope="row">호출 가능 모델</th>
              <td>
                {effective.length > 0 ? effective.map((m) => m.name).join(", ") : "없음"}{" "}
                <span className="muted">(교육청 허용 ∩ 프로젝트 허용)</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>연결된 미니앱</h2>
      {apps.length === 0 ? (
        <p className="muted">아직 이 프로젝트에 연결된 미니앱이 없습니다.</p>
      ) : (
        <ul className="list">
          {apps.map((a) => (
            <li key={a.id}>
              <Link href={`/apps/${a.id}`}>{a.title}</Link>{" "}
              {a.siteSlug ? (
                <span className="badge">허브 사이트 {a.siteSlug}</span>
              ) : (
                <span className="badge">외부 주소</span>
              )}
              {a.approvalStatus === "pending" && <span className="badge warn">학교 승인 대기</span>}
              {a.link === "default" && <span className="badge">기본 프로젝트로 연결</span>}
              <br />
              <span className="muted">
                {a.url} · 등록 {formatKst(a.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {defaultApps > 0 && (
        <p className="muted">
          &quot;기본 프로젝트로 연결&quot; 앱은 프로젝트를 정하지 않고 등록해, 가장 먼저 만든 사용 중인 프로젝트에 연결된 것으로
          봅니다.
        </p>
      )}

      <h2>연결된 사이트</h2>
      {sites.length === 0 ? (
        <p className="muted">
          아직 연결된 사이트가 없습니다. 새 사이트를 CLI로 올릴 때 이 프로젝트에 연결하려면 앱 폴더의 dandi.json에
          projectId를 적으십시오.
        </p>
      ) : (
        <ul className="list">
          {sites.map((s) => (
            <li key={s.id}>
              {s.title} <code className="muted">{s.slug}</code>{" "}
              {s.appId ? <Link href={`/apps/${s.appId}`}>허브 미니앱</Link> : <span className="badge">미리보기만</span>}{" "}
              <Link href={`/studio/sites/${s.id}`} className="muted">
                사이트 관리
              </Link>
            </li>
          ))}
        </ul>
      )}
      <pre>{`// dandi.json\n{\n  "projectId": "${project.id}"\n}`}</pre>

      <h2>다음 단계</h2>
      <ol>
        <li>
          <Link href={`/studio/projects/${project.id}?tab=keys`}>키 탭</Link>에서 inference 역할의 키를 만듭니다.
        </li>
        <li>키를 미니앱 서버의 환경변수 DANDI_PROJECT_KEY에 넣습니다(HTML·JavaScript에는 넣지 않습니다).</li>
        <li>
          <Link href="/ai">AI 사용</Link> 화면에서 이 프로젝트의 키로 게이트웨이를 시험 호출합니다.
        </li>
      </ol>
    </>
  );
}

function KeysTab({ detail, hub }: { detail: ProjectDetail; hub: string }) {
  const { project, keys } = detail;
  const archived = project.status === "archived";
  const semester = formatKst(semesterEnd().toISOString());
  return (
    <>
      <h2>API 키</h2>
      <p className="muted">
        키는 이 프로젝트의 월 예산과 허용 모델을 따릅니다. Authorization: Bearer 또는 x-api-key 헤더로 보냅니다. 원문은
        만들 때 한 번만 보여 드리고, 이후에는 앞·뒷자리 힌트만 표시합니다. 비활성화한 키는 다시 켤 수 있고, 삭제한 키는
        되돌릴 수 없습니다.
      </p>

      {!archived && (
        <>
          <h3>새 API 키</h3>
          <KeyCreateForm
            projectId={project.id}
            roles={KEY_ROLES.map((r) => ({ id: r.id, label: r.label, desc: r.desc }))}
            expiries={EXPIRY_PRESETS.map((e) => ({
              id: e.id,
              label: e.id === "semester" ? `${e.label} (${semester}까지)` : e.label,
            }))}
            defaultExpiry={DEFAULT_EXPIRY}
            activeKeyIds={keys.filter((k) => k.status === "active").map((k) => k.id)}
            hubOrigin={hub}
          />
        </>
      )}

      <h3>키 목록</h3>
      {keys.length === 0 ? (
        <p className="muted">아직 만든 키가 없습니다.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>이름</th>
                <th>역할</th>
                <th>키 힌트</th>
                <th>만든 사람 · 날짜</th>
                <th>마지막 사용</th>
                <th>만료</th>
                <th>상태</th>
                <th>이번 달</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td>{keyRoleLabel(k.role)}</td>
                  <td>
                    <code>{k.hint}</code>
                  </td>
                  <td>
                    {k.createdByName}
                    <br />
                    <span className="muted">{formatKst(k.createdAt)}</span>
                  </td>
                  <td>
                    {k.lastUsedAt ? (
                      <>
                        {formatKst(k.lastUsedAt)}
                        <br />
                        <span
                          className="muted"
                          title={
                            k.lastUsedIp === LOCAL_CLIENT_IP
                              ? "허브에 프록시 설정(TRUST_PROXY)이 없어 요청한 컴퓨터의 IP를 알 수 없습니다."
                              : undefined
                          }
                        >
                          {k.lastUsedIp === LOCAL_CLIENT_IP ? `IP ${formatKeyIp(k.lastUsedIp)}` : formatKeyIp(k.lastUsedIp)}
                        </span>
                      </>
                    ) : (
                      <span className="muted">사용 기록 없음</span>
                    )}
                  </td>
                  <td>
                    {k.expiresAt ? formatKst(k.expiresAt) : "없음"}
                    {k.expiryWarning && (
                      <>
                        <br />
                        <span className="badge warn">{k.expiryWarning}</span>
                      </>
                    )}
                  </td>
                  <td>
                    <span className={k.status === "active" ? "badge" : "badge warn"}>{KEY_STATUS_LABEL[k.status]}</span>
                  </td>
                  <td>
                    {n(k.monthTokens)}토큰
                    <br />
                    <span className="muted">{n(k.monthCalls)}회</span>
                  </td>
                  <td>
                    <KeyRowActions
                      projectId={project.id}
                      keyId={k.id}
                      keyName={k.name}
                      status={k.status}
                      archived={archived}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">
        역할: inference는 게이트웨이 호출만, admin은 호출과 API로 키 발급·조회, readonly는 API로 사용량·설정 조회만 할 수
        있습니다. 만료 7일 전부터 배지를 표시합니다.
      </p>
    </>
  );
}

function UsageTab({ detail }: { detail: ProjectDetail }) {
  const { usage } = detail;
  return (
    <>
      <h2>이번 달({usage.month}) 사용량</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <th scope="row">프로젝트</th>
              <td>
                {n(usage.projectTokens)} / {n(usage.budget)}토큰 ({usage.budgetPct}%) · 호출 {n(usage.projectCalls)}회{" "}
                <BudgetBadge pct={usage.budgetPct} />
              </td>
            </tr>
            <tr>
              <th scope="row">교사 전체(모든 프로젝트)</th>
              <td>
                {n(usage.teacherTokens)} / {n(usage.teacherCap)}토큰 ({usage.teacherPct}%) <BudgetBadge pct={usage.teacherPct} />
              </td>
            </tr>
            <tr>
              <th scope="row">프롬프트 개인정보 마스킹</th>
              <td>{n(usage.piiMasked)}건</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="muted">
        월 예산의 {BUDGET_ALERT_PCT}%를 넘으면 알림을 표시하고, 100%에 이르면 429 project_quota_exceeded로 호출을 막습니다.
        교사 전체 상한을 넘으면 429 teacher_quota_exceeded입니다. 한국 시각 기준 매월 1일에 초기화됩니다.
      </p>

      <h3>키별</h3>
      {usage.byKey.length === 0 ? (
        <p className="muted">이번 달 호출 기록이 없습니다.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>키</th>
                <th>힌트</th>
                <th>호출</th>
                <th>토큰</th>
              </tr>
            </thead>
            <tbody>
              {usage.byKey.map((k) => (
                <tr key={k.keyId}>
                  <td>{k.name}</td>
                  <td>
                    <code>{k.hint}</code>
                  </td>
                  <td>{n(k.calls)}회</td>
                  <td>{n(k.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {usage.byModel.length > 0 && (
        <>
          <h3>모델별</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>모델</th>
                  <th>호출</th>
                  <th>토큰</th>
                </tr>
              </thead>
              <tbody>
                {usage.byModel.map((m) => (
                  <tr key={m.modelId || m.modelName}>
                    <td>{m.modelName}</td>
                    <td>{n(m.calls)}회</td>
                    <td>{n(m.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {usage.recent.length > 0 && (
        <>
          <h3>최근 호출</h3>
          <ul className="list">
            {usage.recent.map((r) => (
              <li key={r.id}>
                {formatKst(r.createdAt)} · {r.keyName} · {r.modelName} · {n(r.tokens)}토큰
                {r.piiMasked > 0 && <span className="badge warn">개인정보 {r.piiMasked}건 마스킹</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function ModelsTab({ detail }: { detail: ProjectDetail }) {
  const { project, visibleModels, effective } = detail;
  return (
    <>
      <h2>허용 모델</h2>
      <p className="muted">
        이 프로젝트에서 실제로 호출할 수 있는 모델은 교육청이 허용한 모델과 이 프로젝트가 허용한 모델의 교집합입니다.
        교육청 정책 검토 중인 모델은 골라 두어도 교육청이 허용하기 전까지 호출되지 않습니다.
      </p>
      <p>
        지금 호출 가능:{" "}
        {effective.length > 0 ? (
          effective.map((m) => (
            <span key={m.id} className="badge">
              {m.name}
            </span>
          ))
        ) : (
          <span className="badge warn">없음</span>
        )}
      </p>
      <ModelsForm
        projectId={project.id}
        models={visibleModels.map((m) => ({
          id: m.id,
          name: m.name,
          allowed: m.status === "allowed",
          statusLabel: teacherStatusLabel(m),
        }))}
        selected={project.modelIds}
        disabled={project.status === "archived"}
      />
    </>
  );
}

/** 보관 직후 이동한 주소의 ?archived=<비활성화한 키 수>. 숫자가 아니면 null. */
function archivedKeysParam(raw: string | string[] | undefined): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && /^\d{1,4}$/.test(v) ? Number(v) : null;
}

function SettingsTab({ detail, archivedKeys }: { detail: ProjectDetail; archivedKeys: number | null }) {
  const { project } = detail;
  if (project.status === "archived") {
    return (
      <>
        <h2>설정</h2>
        {archivedKeys !== null && (
          <p className="notice" role="status">
            프로젝트를 보관했습니다. 키 {n(archivedKeys)}개를 비활성화했습니다.
          </p>
        )}
        <p className="muted">보관한 프로젝트는 설정을 바꿀 수 없습니다.</p>
      </>
    );
  }
  return (
    <>
      <h2>설정</h2>
      <SettingsForm
        projectId={project.id}
        name={project.name}
        description={project.description}
        budget={project.monthlyTokenBudget}
        minBudget={MIN_PROJECT_BUDGET}
        maxBudget={MAX_PROJECT_BUDGET}
      />
      <p className="muted">
        월 예산은 {n(MIN_PROJECT_BUDGET)} ~ {n(MAX_PROJECT_BUDGET)}토큰 사이로 정합니다. 여러 프로젝트의 예산 합이 교사 전체
        상한을 넘어도 되지만, 실제 호출은 교사 전체 상한에서 한 번 더 막힙니다.
      </p>

      <h2>프로젝트 보관</h2>
      <p className="muted">
        보관하면 이 프로젝트의 키가 모두 비활성화되어 AI 호출이 멈춥니다. 사용 기록은 남고, 보관은 되돌릴 수 없습니다.
      </p>
      <ArchiveProjectForm projectId={project.id} projectName={project.name} />
    </>
  );
}
