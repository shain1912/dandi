import type { Metadata } from "next";
import Link from "next/link";
import { listConnections, type OAuthConnection } from "@/lib/oauth";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { revokeConnectionAction } from "./actions";

// F-57 연결된 AI 도구 목록과 폐기. 원격 MCP(<hub>/mcp)에 OAuth로 연결한 도구가 여기에 나온다.
// CLI 로그인(dd_cli_ 토큰)은 /studio/cli에서 관리한다.

export const metadata: Metadata = { title: "연결된 AI 도구 · Dandi" };

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" });
}

function StatusBadge({ c }: { c: OAuthConnection }) {
  if (c.status === "active") return <span className="badge">사용 중</span>;
  if (c.status === "revoked") return <span className="badge warn">끊김 {formatDate(c.revokedAt)}</span>;
  return <span className="badge">만료됨</span>;
}

export default async function ConnectionsPage() {
  const user = await getCurrentUser();
  if (!isTeacher(user)) {
    return (
      <>
        <h1>연결된 AI 도구</h1>
        <p className="notice">
          교사 로그인 후 볼 수 있습니다. <Link href="/login?next=%2Foauth%2Fconnections">교사 로그인</Link>
        </p>
      </>
    );
  }

  const connections = await listConnections(user.id);

  return (
    <>
      <p className="muted">
        <Link href="/studio">스튜디오</Link> / 연결된 AI 도구
      </p>
      <h1>연결된 AI 도구</h1>
      <p className="muted">
        Claude Code·Cursor·Codex 같은 AI 도구를 Dandi 원격 MCP에 연결하면 여기에 표시됩니다. 연결을 끊으면 그 도구가
        받은 접근 권한이 바로 폐기되고, 다시 쓰려면 도구에서 연결 승인을 새로 받아야 합니다. 쓰지 않는 도구나 기억나지 않는
        연결은 끊으십시오.
      </p>

      {connections.length === 0 ? (
        <p className="muted">연결된 AI 도구가 없습니다. 연결 방법은 <Link href="/connect">AI로 연결하기</Link>를 참고하십시오.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>도구 이름</th>
                <th>돌아갈 주소</th>
                <th>처음 연결</th>
                <th>마지막 사용</th>
                <th>상태</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
                <tr key={c.clientId}>
                  <td>{c.clientName}</td>
                  <td>
                    {c.redirectHosts.map((h) => (
                      <span key={h.host} className="badge">
                        {h.host}
                        {h.local ? " (이 컴퓨터)" : ""}
                      </span>
                    ))}
                  </td>
                  <td>{formatDate(c.firstSeenAt)}</td>
                  <td>{formatDate(c.lastUsedAt)}</td>
                  <td>
                    <StatusBadge c={c} />
                  </td>
                  <td>
                    {c.status === "active" && (
                      <form action={revokeConnectionAction}>
                        <input type="hidden" name="clientId" value={c.clientId} />
                        <button>연결 끊기</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>함께 관리할 것</h2>
      <ul>
        <li>
          터미널에서 <code>dandi login</code>으로 로그인한 기기는 <Link href="/studio/cli">CLI 토큰</Link>에서
          폐기합니다.
        </li>
        <li>
          AI 도구 연결 방법과 안전 안내는 <Link href="/connect">AI로 연결하기</Link>에 있습니다.
        </li>
      </ul>
    </>
  );
}
