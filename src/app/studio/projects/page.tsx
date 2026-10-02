import Link from "next/link";
import {
  DEFAULT_PROJECT_BUDGET,
  DEFAULT_PROJECT_NAME,
  formatKst,
  listMyProjects,
  MAX_PROJECT_BUDGET,
  MIN_PROJECT_BUDGET,
  monthKey,
  PROJECT_LIMIT,
  TEACHER_MONTHLY_CAP,
  teacherMonthUsage,
} from "@/lib/projects";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { CreateProjectForm } from "./create-project-form";

// [프로젝트 /studio/projects] 목록·만들기 (F-31, Edge Impulse 방식).
// 키와 한도·모델 정책은 프로젝트에 속한다. 교사 전체 상한은 모든 프로젝트 합계에 걸린다(F-33).

const n = (v: number) => v.toLocaleString("ko-KR");

export default async function ProjectsPage() {
  const user = await getCurrentUser();
  if (!isTeacher(user)) {
    return (
      <>
        <h1>프로젝트·API 키</h1>
        <p className="notice">
          프로젝트는 교사 로그인 후 사용할 수 있습니다. <Link href="/login?next=/studio/projects">교사 로그인</Link>
        </p>
      </>
    );
  }

  const [projects, teacherUsed] = await Promise.all([listMyProjects(user), teacherMonthUsage(user.id)]);
  const active = projects.filter((p) => p.status === "active");
  const archived = projects.filter((p) => p.status === "archived");
  const atLimit = active.length >= PROJECT_LIMIT;
  const teacherPct = Math.floor((teacherUsed / TEACHER_MONTHLY_CAP) * 100);

  return (
    <>
      <p className="muted">
        <Link href="/studio">스튜디오</Link> / 프로젝트
      </p>
      <h1>프로젝트·API 키</h1>
      <p className="muted">
        미니앱·사이트마다 프로젝트를 만들고, 프로젝트마다 API 키를 여러 개 발급합니다. 월 예산과 허용 모델은 프로젝트
        단위로 정하고, 키는 인증 수단으로만 씁니다. 키 원문은 발급할 때 한 번만 보여 드립니다.
      </p>

      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <th scope="row">이번 달({monthKey()}) 교사 전체 사용량</th>
              <td>
                {n(teacherUsed)} / {n(TEACHER_MONTHLY_CAP)}토큰 ({teacherPct}%){" "}
                {teacherPct >= 80 && <span className="badge warn">상한 {teacherPct >= 100 ? "도달" : "80% 넘음"}</span>}
                <br />
                <span className="muted">
                  모든 프로젝트 합계에 걸리는 상한입니다. 프로젝트를 늘려도 올라가지 않습니다.
                </span>
              </td>
            </tr>
            <tr>
              <th scope="row">활성 프로젝트</th>
              <td>
                {active.length} / {PROJECT_LIMIT}개{archived.length > 0 && ` (보관 ${archived.length}개)`}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>내 프로젝트</h2>
      {active.length === 0 ? (
        <p className="muted">
          아직 프로젝트가 없습니다. 아래에서 첫 프로젝트를 만드십시오. CLI로 사이트를 올리면 &apos;{DEFAULT_PROJECT_NAME}
          &apos;가 자동으로 만들어집니다.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>프로젝트</th>
                <th>이번 달 사용량 / 월 예산</th>
                <th>사용 중인 키</th>
                <th>호출 가능 모델</th>
                <th>만든 날짜</th>
              </tr>
            </thead>
            <tbody>
              {active.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/studio/projects/${p.id}`}>{p.name}</Link>
                    <br />
                    <code className="muted">{p.id}</code>
                  </td>
                  <td>
                    {n(p.monthTokens)} / {n(p.monthlyTokenBudget)}토큰 ({p.budgetPct}%){" "}
                    {p.budgetPct >= 100 ? (
                      <span className="badge warn">예산 소진, 호출 차단</span>
                    ) : (
                      p.budgetAlert && <span className="badge warn">예산 80% 넘음</span>
                    )}
                  </td>
                  <td>
                    <Link href={`/studio/projects/${p.id}?tab=keys`}>
                      {p.activeKeys}개{p.totalKeys > p.activeKeys ? ` (전체 ${p.totalKeys}개)` : ""}
                    </Link>
                  </td>
                  <td>{p.effectiveModelIds.length > 0 ? `${p.effectiveModelIds.length}개` : "없음"}</td>
                  <td>{formatKst(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>새 프로젝트</h2>
      {atLimit ? (
        <p className="notice">
          프로젝트는 교사 1명당 {PROJECT_LIMIT}개까지 만들 수 있습니다. 쓰지 않는 프로젝트를 설정 탭에서 보관하십시오.
        </p>
      ) : (
        <CreateProjectForm
          defaultName={active.length === 0 ? DEFAULT_PROJECT_NAME : ""}
          defaultBudget={DEFAULT_PROJECT_BUDGET}
          minBudget={MIN_PROJECT_BUDGET}
          maxBudget={MAX_PROJECT_BUDGET}
          disabled={atLimit}
        />
      )}

      {archived.length > 0 && (
        <>
          <h2>보관한 프로젝트</h2>
          <p className="muted">보관한 프로젝트의 키는 모두 비활성화되어 호출할 수 없습니다. 사용 기록은 남아 있습니다.</p>
          <ul className="list">
            {archived.map((p) => (
              <li key={p.id}>
                <Link href={`/studio/projects/${p.id}`}>{p.name}</Link> <span className="badge">보관됨</span>{" "}
                <span className="muted">{formatKst(p.createdAt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>키를 쓰는 방법</h2>
      <p className="muted">
        프로젝트 키(dd_sk_...)는 비밀번호와 같습니다. 미니앱의 서버 함수(프록시)에서 환경변수로 읽어 게이트웨이를 부르고,
        HTML·JavaScript에는 넣지 마십시오. 브라우저에서 이 키로 직접 부르면 게이트웨이가 401로 거부합니다. 예시는{" "}
        <Link href="/ai">AI 사용</Link> 화면과 <a href="/downloads/ai-proxy-example.md">서버 프록시 예제</a>에 있습니다.
      </p>
    </>
  );
}
