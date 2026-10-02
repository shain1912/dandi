import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { levelLabel } from "@/lib/constants";
import {
  ACCESS_TOKEN_TTL_SEC,
  authorizeFields,
  authorizePagePath,
  describeRedirect,
  pickAuthorizeParams,
  REFRESH_TOKEN_TTL_SEC,
  validateAuthorizeRequest,
} from "@/lib/oauth";
import { hubOrigin } from "@/lib/origin";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { approveAuthorizationAction, denyAuthorizationAction } from "./actions";
import { ConsentForms } from "./consent-forms";

// F-57 OAuth 동의 화면. Claude Code·Cursor 같은 AI 도구가 원격 MCP(<hub>/mcp)에 연결하려 할 때 브라우저로 연다.
// 교사 세션이 필요하며(없으면 로그인 후 이 화면으로 돌아옴), 도구 이름·돌아갈 주소·권한·교사 계정을 보여 주고
// [허용]하면 코드·state·iss를 붙여 도구로 돌려보낸다.

export const metadata: Metadata = {
  title: "AI 도구 연결 승인 · Dandi",
  robots: { index: false, follow: false },
};

const PERMISSIONS = [
  "사이트 파일을 올려 비공개 미리보기 주소 만들기",
  "셀프점검 5문항에 교사가 직접 답한 사이트를 허브에 미니앱으로 등록하기",
  "내 사이트 목록과 계정 정보(이름·역할·학교급) 보기",
  "공개 스킬 검색과 스킬 설명 읽기",
];

function ErrorView({ message, detail, back }: { message: string; detail?: string; back?: { url: string; host: string } }) {
  return (
    <>
      <h1>AI 도구 연결 승인</h1>
      <p className="error" role="alert">
        {message}
      </p>
      {detail && (
        <p className="muted">
          기술 정보: <code>{detail}</code>
        </p>
      )}
      {back && (
        <p>
          <a href={back.url} className="button">
            AI 도구로 돌아가기 ({back.host})
          </a>
        </p>
      )}
      <p className="muted">
        연결 방법은 <Link href="/connect">AI로 연결하기</Link>를 참고하십시오.
      </p>
    </>
  );
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = pickAuthorizeParams((key) => sp[key]);
  const hub = await hubOrigin();
  const check = await validateAuthorizeRequest(params, hub);
  if (!check.ok) {
    if (check.kind === "page") return <ErrorView message={check.message} />;
    // 이 컴퓨터에서 기다리는 도구에는 오류를 바로 돌려주고, 인터넷 주소는 교사가 확인하고 누르게 한다.
    if (check.local) redirect(check.url);
    return <ErrorView message={check.message} detail={check.detail} back={{ url: check.url, host: check.host }} />;
  }

  const user = await getCurrentUser();
  if (!isTeacher(user)) redirect(`/login?next=${encodeURIComponent(authorizePagePath(params))}`);

  const { client, redirectUri } = check.request;
  const target = describeRedirect(redirectUri);

  return (
    <>
      <h1>AI 도구 연결 승인</h1>
      <p className="notice">
        직접 AI 도구(Claude Code, Cursor, Codex 등)에서 Dandi 연결을 시작한 경우에만 허용하십시오. 웹사이트나 다른
        사람이 이 링크를 보냈다면 거부하십시오.
      </p>

      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <th scope="row">연결하려는 도구</th>
              <td>
                {client.clientName}
                <br />
                <span className="muted">
                  AI 도구가 등록할 때 스스로 밝힌 이름입니다. 아래 돌아갈 주소로 실제 도구인지 확인하십시오.
                </span>
              </td>
            </tr>
            <tr>
              <th scope="row">승인 후 돌아갈 주소</th>
              <td>
                <code>{target.host}</code>{" "}
                {target.local ? (
                  <span className="badge">이 컴퓨터</span>
                ) : (
                  <span className="badge warn">인터넷 서비스</span>
                )}
                <br />
                <span className="muted">
                  {target.local
                    ? "이 컴퓨터에서 실행 중인 AI 도구(터미널·편집기)가 연결을 받습니다."
                    : "인터넷에 있는 서비스가 연결을 받습니다. 사용하는 AI 서비스의 주소가 맞는지 확인하십시오."}
                </span>
              </td>
            </tr>
            <tr>
              <th scope="row">허용할 권한</th>
              <td>
                <ul>
                  {PERMISSIONS.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <span className="muted">
                  로그인 정보, 프로젝트 API 키, 다른 교사의 자료에는 접근할 수 없습니다.
                </span>
              </td>
            </tr>
            <tr>
              <th scope="row">연결할 교사 계정</th>
              <td>
                {user.name} · {user.role === "admin" ? "교육청 관리자" : "교사"}
                {user.schoolLevel ? ` · ${levelLabel(user.schoolLevel)}` : ""}
              </td>
            </tr>
            <tr>
              <th scope="row">연결 유지</th>
              <td>
                AI 도구는 {ACCESS_TOKEN_TTL_SEC / 60}분마다 접근 권한을 새로 받으며, {REFRESH_TOKEN_TTL_SEC / 86400}일
                동안 쓰지 않으면 연결이 끊깁니다. <Link href="/oauth/connections">연결된 AI 도구</Link>에서 언제든 끊을 수
                있습니다.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <ConsentForms fields={authorizeFields(params)} approve={approveAuthorizationAction} deny={denyAuthorizationAction} />

      <p className="muted">
        다른 계정으로 연결하려면 <Link href={`/login?next=${encodeURIComponent(authorizePagePath(params))}`}>계정</Link>{" "}
        화면에서 로그아웃한 뒤 다시 로그인하십시오.
      </p>
    </>
  );
}
