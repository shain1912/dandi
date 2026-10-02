import Link from "next/link";
import { DEPLOYMENT_LABEL, listModels, PROMPT_MAX_CHARS, teacherStatusLabel } from "@/lib/ai";
import { hubOrigin } from "@/lib/origin";
import { keyRoleLabel, listMyProjectsWithKeys, TEACHER_MONTHLY_CAP } from "@/lib/projects";
import { getCurrentUser, isTeacher } from "@/lib/session";
import type { AiModel } from "@/lib/types";
import { GatewayTestForm, type ModelOption, type TestProject } from "./gateway-test";

// [AI 사용] 화면: 모델 가이드(F-22) · 프로젝트 키로 게이트웨이 테스트(F-21, F-32) · API 호출 예시 ·
// 미니앱 서버 프록시 예시(F-35). 키 발급·예산·허용 모델은 프로젝트 화면(/studio/projects)에서 관리한다.

const n = (v: number) => v.toLocaleString("ko-KR");

function StatusBadge({ model }: { model: AiModel }) {
  return <span className={model.status === "allowed" ? "badge" : "badge warn"}>{teacherStatusLabel(model)}</span>;
}

function LoginNotice({ what }: { what: string }) {
  return (
    <p className="notice">
      {what}은(는) 교사 로그인 후 사용할 수 있습니다. <Link href="/login?next=/ai">교사 로그인</Link>으로 이동하십시오.
    </p>
  );
}

function proxyRouteExample(model: string): string {
  return `// app/api/ai/route.ts  (미니앱의 서버 함수. Vercel·Next.js App Router 예시)
// 키는 환경변수에서만 읽습니다. NEXT_PUBLIC_ 접두어를 붙이면 브라우저로 새어 나가므로 붙이지 마십시오.
export async function POST(req: Request) {
  const { prompt } = await req.json();
  if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > 2000) {
    return Response.json({ error: "prompt는 1~2000자 문자열이어야 합니다." }, { status: 400 });
  }
  const res = await fetch(\`\${process.env.DANDI_HUB_URL}/api/ai/chat\`, {
    method: "POST",
    headers: {
      "x-api-key": process.env.DANDI_PROJECT_KEY ?? "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "${model}", prompt }),
  });
  const data = await res.json();
  if (!res.ok) {
    return Response.json({ error: data.error?.message ?? "AI 호출에 실패했습니다." }, { status: res.status });
  }
  return Response.json({ output: data.output });
}`;
}

const BROWSER_EXAMPLE = `// 브라우저(미니앱 화면) 코드: 키 없이 내 서버 함수만 부릅니다.
const res = await fetch("/api/ai", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "오늘 배운 광합성을 초등학생 눈높이로 세 줄 요약" }),
});
const { output, error } = await res.json();`;

export default async function AiPage() {
  const user = await getCurrentUser();
  const teacher = isTeacher(user);
  // F-23: 차단 모델은 교사 화면에서 숨긴다.
  const models = (await listModels()).filter((m) => m.status !== "blocked");
  const allowed = models.filter((m) => m.status === "allowed");
  const origin = await hubOrigin();
  const exampleModel = allowed[0]?.id ?? "허용된_모델_id";

  const mine = teacher ? await listMyProjectsWithKeys(user) : [];
  const testProjects: TestProject[] = mine.map(({ project, keys }) => ({
    id: project.id,
    name: project.name,
    keys: keys
      .filter((k) => k.status === "active" && k.role !== "readonly")
      .map((k) => ({ id: k.id, label: `${k.name} · ${keyRoleLabel(k.role)} · ${k.hint}` })),
    modelIds: project.effectiveModelIds,
  }));
  const defaultProject = testProjects.find((p) => p.keys.length > 0) ?? testProjects[0];

  const options: ModelOption[] = models.map((m) => ({
    id: m.id,
    name: m.name,
    allowed: m.status === "allowed",
    statusLabel: teacherStatusLabel(m),
  }));

  const curl = [
    `curl -X POST ${origin}/api/ai/chat \\`,
    `  -H "x-api-key: dd_sk_발급받은_키" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"model":"${exampleModel}","prompt":"중학교 1학년 과학 수업 도입 활동 아이디어 3개를 제안해 주십시오."}'`,
  ].join("\n");

  const powershell = [
    `$body = @{ model = "${exampleModel}"; prompt = "중학교 1학년 과학 수업 도입 활동 아이디어 3개를 제안해 주십시오." } | ConvertTo-Json`,
    `Invoke-RestMethod -Method Post -Uri ${origin}/api/ai/chat \``,
    `  -Headers @{ "x-api-key" = "dd_sk_발급받은_키" } \``,
    `  -ContentType "application/json; charset=utf-8" \``,
    `  -Body ([Text.Encoding]::UTF8.GetBytes($body))`,
  ].join("\n");

  return (
    <>
      <h1>AI 사용</h1>
      <p className="muted">
        AI 호출은 프로젝트 API 키로 Dandi 게이트웨이를 거칩니다. 키·월 예산·허용 모델은{" "}
        <Link href="/studio/projects">프로젝트</Link>마다 정하고, 교사 한 명의 모든 프로젝트 합계에는 월{" "}
        {n(TEACHER_MONTHLY_CAP)}토큰 상한이 걸립니다. 교육청 관리자가 허용한 모델만 통과하며, 프롬프트에 섞인 개인정보는
        모델로 보내기 전에 서버에서 가립니다. 프로토타입은 실제 모델 대신 모의 응답을 돌려줍니다.
      </p>

      <h2>모델 가이드</h2>
      <p className="muted">
        모델마다 제공사, 실행 방식, 프롬프트가 처리되는 위치, 권장 용도가 다릅니다. 용도에 맞는 모델을 고르십시오.
        &apos;허용&apos; 상태인 모델만 호출할 수 있으며, 허용 여부는 교육청 정책 판단에 따릅니다. 프로젝트에서 허용 모델을 더
        좁힐 수 있습니다(실제 호출 가능 = 교육청 허용 ∩ 프로젝트 허용).
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>모델</th>
              <th>제공사</th>
              <th>개발 국가</th>
              <th>실행 방식</th>
              <th>데이터 처리 위치</th>
              <th>권장 용도</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.name}
                  <br />
                  <code className="muted">{m.id}</code>
                </td>
                <td>{m.provider}</td>
                <td>{m.origin}</td>
                <td>{DEPLOYMENT_LABEL[m.deployment]}</td>
                <td>{m.dataLocation}</td>
                <td>{m.recommendedUse}</td>
                <td>
                  <StatusBadge model={m} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        로컬·온프레미스 모델은 교육청 자체 서버 연결(F-25) 이후 실제로 사용할 수 있습니다. 목록은{" "}
        <a href="/api/ai/models">GET /api/ai/models</a>에서 JSON으로도 볼 수 있습니다.
      </p>

      <h2>게이트웨이 테스트</h2>
      {!teacher ? (
        <LoginNotice what="게이트웨이 테스트" />
      ) : testProjects.length === 0 ? (
        <p className="notice">
          프로젝트가 없습니다. <Link href="/studio/projects">프로젝트</Link>를 만들고 키 탭에서 inference 키를 만든 뒤 다시
          오십시오.
        </p>
      ) : (
        <>
          {!defaultProject?.keys.length && (
            <p className="notice">
              호출에 쓸 키(사용 중인 inference·admin 키)가 없습니다.{" "}
              <Link href={`/studio/projects/${defaultProject?.id ?? ""}?tab=keys`}>프로젝트 키 탭</Link>에서 키를 먼저
              만드십시오.
            </p>
          )}
          {allowed.length === 0 && (
            <p className="notice">현재 허용된 모델이 없습니다. 교육청 관리자의 허용 결정을 기다리십시오.</p>
          )}
          <p className="muted">
            고른 키로 허브 서버가 호출하므로 키 원문을 입력할 필요가 없습니다. 프롬프트는 최대 {n(PROMPT_MAX_CHARS)}자까지
            보낼 수 있습니다. readonly 키는 게이트웨이를 호출할 수 없어 목록에서 뺐습니다.
          </p>
          <GatewayTestForm projects={testProjects} models={options} defaultProjectId={defaultProject?.id ?? ""} />
        </>
      )}

      <h2>API로 호출하기</h2>
      <p className="muted">
        프로젝트 키를 <code>x-api-key</code> 헤더(또는 <code>Authorization: Bearer</code>)에 넣어 서버·터미널에서
        호출합니다. 아래의 dd_sk_발급받은_키 자리에 프로젝트 키를 넣으십시오. 키만 있으면 프로젝트가 정해지므로
        프로젝트 id는 보내지 않고, 응답 헤더 <code>x-dandi-project-id</code>로 알려 드립니다. OpenAI 형식의{" "}
        <code>{`{"model":"${exampleModel}","messages":[{"role":"user","content":"..."}]}`}</code> 본문도 받습니다.
      </p>
      <p className="muted">macOS·Linux·Git Bash</p>
      <pre>{curl}</pre>
      <p className="muted">Windows PowerShell</p>
      <pre>{powershell}</pre>
      <p className="muted">
        성공하면 <code>{"{ model, output, projectId, usage: { tokens, remaining, quota, teacherRemaining, teacherCap }, warnings, piiMasked, mock }"}</code>
        을 돌려줍니다. 오류는 <code>{"{ error: { code, message, hint } }"}</code> 형식입니다.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>상태</th>
              <th>code</th>
              <th>뜻</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>401</td>
              <td>
                <code>missing_key</code> <code>invalid_key</code> <code>key_disabled</code> <code>key_expired</code>
              </td>
              <td>키가 없거나, 삭제·비활성화·만료된 키입니다.</td>
            </tr>
            <tr>
              <td>401</td>
              <td>
                <code>browser_key_forbidden</code>
              </td>
              <td>브라우저에서 비밀 키(dd_sk_)로 직접 불렀습니다. 서버 프록시로 바꾸십시오.</td>
            </tr>
            <tr>
              <td>403</td>
              <td>
                <code>project_archived</code> <code>insufficient_role</code>
              </td>
              <td>보관한 프로젝트의 키이거나, readonly 키로 호출했습니다.</td>
            </tr>
            <tr>
              <td>403</td>
              <td>
                <code>model_not_allowed</code>
              </td>
              <td>교육청 정책 검토 중인 모델이거나, 프로젝트에서 허용하지 않은 모델입니다.</td>
            </tr>
            <tr>
              <td>400</td>
              <td>
                <code>invalid_request</code> <code>model_not_found</code>
              </td>
              <td>요청 형식 오류이거나 없는 모델입니다.</td>
            </tr>
            <tr>
              <td>429</td>
              <td>
                <code>project_quota_exceeded</code> <code>teacher_quota_exceeded</code>
              </td>
              <td>프로젝트 월 예산 또는 교사 전체 월 상한을 넘었습니다.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>미니앱에서 안전하게 호출하기</h2>
      <p className="notice">
        프로젝트 키(dd_sk_)를 HTML·JavaScript에 넣지 마십시오. 페이지를 여는 누구나 키를 볼 수 있습니다. 게이트웨이는
        브라우저에서 이 키로 온 요청(Origin 헤더 등)을 401 <code>browser_key_forbidden</code>으로 거부합니다.
      </p>
      <p className="muted">
        미니앱의 서버 함수(프록시)가 환경변수 <code>DANDI_PROJECT_KEY</code>로 키를 읽어 게이트웨이를 부르고, 브라우저는
        그 서버 함수만 부릅니다. Vercel이면 프로젝트 설정의 Environment Variables에 <code>DANDI_PROJECT_KEY</code>와{" "}
        <code>DANDI_HUB_URL</code>(<code>{origin}</code>)을 넣습니다. 허브의 정적 호스팅에 올린 사이트는 서버 함수를 둘 수
        없으므로, AI 호출이 필요한 앱은 서버 함수를 지원하는 곳에 배포하십시오.
      </p>
      <pre>{proxyRouteExample(exampleModel)}</pre>
      <pre>{BROWSER_EXAMPLE}</pre>
      <p className="muted">
        전체 예제(Next.js·Vercel 함수·Express, 환경변수 설정, 점검 목록):{" "}
        <a href="/downloads/ai-proxy-example.md">ai-proxy-example.md</a>
      </p>
    </>
  );
}
