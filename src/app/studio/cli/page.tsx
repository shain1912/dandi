import Link from "next/link";
import { hubOrigin } from "@/lib/origin";
import { cliPrefix, readCliVersion } from "@/lib/runbook";
import { listCliTokens } from "@/lib/cli";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { revokeTokenAction } from "./actions";
import { IssueTokenForm } from "./issue-form";

// F-17 CLI 토큰 발급·폐기와 dandi 사용법(PRD 9장 "CLI 토큰 발급").

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "short",
    timeStyle: "short",
  });
}

export default async function StudioCliPage() {
  const user = await getCurrentUser();
  if (!isTeacher(user)) {
    return (
      <>
        <h1>CLI 토큰</h1>
        <p className="notice">
          CLI 토큰은 교사 로그인 후 발급할 수 있습니다. <Link href="/login">교사 로그인</Link>
        </p>
      </>
    );
  }

  const [tokens, origin] = await Promise.all([listCliTokens(user.id), hubOrigin()]);
  const cli = cliPrefix(origin, readCliVersion());

  return (
    <>
      <p className="muted">
        <Link href="/studio">스튜디오</Link> / CLI 토큰
      </p>
      <h1>CLI 토큰·연결된 기기</h1>
      <p className="muted">
        보통은 토큰을 직접 발급할 필요가 없습니다. 터미널이나 AI 코딩 도구에서 <code>login</code>을 실행하면 브라우저에서
        코드를 확인하고 승인하는 것만으로 이 목록에 토큰이 생깁니다. 직접 발급은 CI·자동화용입니다. 쓰지 않는 기기의
        토큰은 폐기하십시오. MCP로 연결된 AI 도구는 <Link href="/oauth/connections">연결된 AI 도구</Link>에서 관리합니다.
      </p>
      <pre>{`${cli} login`}</pre>

      <h2>CI용 토큰 발급</h2>
      <IssueTokenForm
        origin={origin}
        cli={cli}
        activePrefixes={tokens.filter((t) => !t.revokedAt).map((t) => t.tokenPrefix)}
      />

      <h2>내 토큰</h2>
      {tokens.length === 0 ? (
        <p className="muted">발급한 토큰이 없습니다.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>기기</th>
                <th>토큰 앞부분</th>
                <th>발급</th>
                <th>마지막 사용</th>
                <th>상태</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.label ?? "직접 발급(CI)"}</td>
                  <td>
                    <code>{t.tokenPrefix}…</code>
                  </td>
                  <td>{formatDate(t.createdAt)}</td>
                  <td>{formatDate(t.lastUsedAt)}</td>
                  <td>
                    {t.revokedAt ? (
                      <span className="badge">폐기됨 {formatDate(t.revokedAt)}</span>
                    ) : (
                      <span className="badge">사용 중</span>
                    )}
                  </td>
                  <td>
                    {!t.revokedAt && (
                      <form action={revokeTokenAction}>
                        <input type="hidden" name="id" value={t.id} />
                        <button>폐기</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>사용법</h2>
      <p className="muted">
        Node.js 18 이상만 있으면 설치 없이 <code>npx</code>로 실행됩니다. AI 코딩 도구에 맡기려면{" "}
        <Link href="/connect">AI로 연결하기</Link>의 문장 한 줄을 붙여 넣으십시오.
      </p>
      <pre>{`# 1. 로그인: 브라우저가 열리면 화면의 코드가 터미널의 코드와 같은지 확인하고 [승인]
${cli} login
${cli} whoami

# 2. 사이트 폴더에서 등록 정보 만들기: dandi.json(셀프점검 5항목)과 llms.txt 뼈대
${cli} init

# 3. 허브에 올리기: 비공개 미리보기 주소가 나옵니다
${cli} deploy

# 4. dandi.json의 셀프점검 5항목을 채운 뒤 허브에 등록(공개)
${cli} publish

# 다른 곳에 이미 배포한 앱은 주소만 등록
${cli} publish --url https://내-앱.vercel.app

# AI에게 보여 줄 안내문 원문, 로그아웃
${cli} guide
${cli} logout`}</pre>
      <p className="muted">
        dandi.json의 privacyCheck는 배포 전 개인정보 셀프점검입니다. init은 예·아니요 항목을 비워 두므로 5항목에 모두
        답해야 등록됩니다. 올린 사이트는 <Link href="/studio/sites">내 사이트</Link>, 등록한 앱은{" "}
        <Link href="/studio/apps">내 미니앱</Link>에서 확인하십시오.
      </p>
    </>
  );
}
