import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  clientLabel,
  codeLookupBlocked,
  friendlyIp,
  friendlyOs,
  getDeviceAuthByUserCode,
  noteFailedCodeLookup,
  normalizeUserCode,
  type DeviceView,
} from "@/lib/device-auth";
import { getCurrentUser, isTeacher } from "@/lib/session";
import type { User } from "@/lib/types";
import { decideDeviceAction } from "./actions";

// F-53 기기 연결 승인 화면(/device?code=WDJB-MJHT).
// 로그인보다 승인이 먼저 오지 않게 교사 세션을 먼저 요구하고(authenticate-then-initiate),
// 코드 대조·요청 기기 정보·피싱 경고를 보여 준 뒤 [승인]/[거부]를 받는다.

export const metadata: Metadata = {
  title: "기기 연결 승인 · Dandi",
  robots: { index: false, follow: false },
};

const ERRORS: Record<string, string> = {
  invalid: "요청을 처리하지 못했습니다. 다시 시도하십시오.",
  invalid_code: "코드 형식이 올바르지 않습니다.",
  not_found: "코드를 찾을 수 없습니다.",
  already_decided: "이미 처리된 코드입니다.",
  expired: "코드가 만료되었습니다. 터미널이나 AI 대화창에서 로그인을 다시 시작하십시오.",
  forbidden: "교사 로그인이 필요합니다.",
};

function formatKst(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "medium" });
}

/** 만료까지 남은 시간(서버 렌더링 시점 기준). 만료되었으면 null. */
function remainingText(expiresAt: string): string | null {
  const ms = Date.parse(expiresAt) - Date.now();
  if (ms <= 0) return null;
  return ms < 60_000 ? "1분 미만" : `약 ${Math.ceil(ms / 60_000)}분`;
}

function CodeForm({ defaultValue }: { defaultValue?: string }) {
  return (
    <form method="get" action="/device" className="stack">
      <label className="field">
        <span>AI 대화창·터미널에 보이는 코드</span>
        <input
          name="code"
          defaultValue={defaultValue}
          placeholder="예: WDJB-MJHT"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={20}
          required
        />
      </label>
      <button type="submit">코드 확인</button>
    </form>
  );
}

function Approval({ view, user, remaining }: { view: DeviceView; user: User; remaining: string }) {
  return (
    <>
      <p>AI 대화창·터미널에 보이는 코드와 같나요?</p>
      <p>
        <strong style={{ fontSize: "2rem", letterSpacing: "0.12em", fontFamily: "ui-monospace, Consolas, monospace" }}>
          {view.userCode}
        </strong>
      </p>
      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <th>요청 도구</th>
              <td>{clientLabel(view.client)}</td>
            </tr>
            <tr>
              <th>컴퓨터 이름</th>
              <td>{view.hostname === "unknown" ? "알 수 없음" : view.hostname}</td>
            </tr>
            <tr>
              <th>운영체제</th>
              <td>{friendlyOs(view.os)}</td>
            </tr>
            <tr>
              <th>요청한 곳</th>
              <td>{friendlyIp(view.ip)}</td>
            </tr>
            <tr>
              <th>요청 시각</th>
              <td>{formatKst(view.createdAt)}</td>
            </tr>
            <tr>
              <th>남은 시간</th>
              <td>{remaining}</td>
            </tr>
            <tr>
              <th>허용할 권한</th>
              <td>사이트 올리기·허브 등록·스킬 게시</td>
            </tr>
            <tr>
              <th>로그인할 계정</th>
              <td>{user.name}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="notice">
        직접 AI에게 Dandi 로그인을 시킨 경우에만 승인하십시오. 웹사이트나 다른 사람이 이 코드를 보냈다면
        거부하십시오.
      </p>
      <form action={decideDeviceAction} style={{ marginTop: 12 }}>
        <input type="hidden" name="code" value={view.userCode} />
        <button type="submit" name="decision" value="approve">
          승인
        </button>{" "}
        <button name="decision" value="deny">
          거부
        </button>
      </form>
    </>
  );
}

export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const rawCode = typeof sp.code === "string" ? sp.code.slice(0, 32) : "";
  const errorKey = typeof sp.error === "string" ? sp.error : "";

  const user = await getCurrentUser();
  if (!isTeacher(user)) {
    const back = rawCode ? `/device?code=${encodeURIComponent(rawCode)}` : "/device";
    redirect(`/login?next=${encodeURIComponent(back)}`);
  }

  const intro = (
    <>
      <h1>기기 연결 승인</h1>
      <p className="muted">
        AI 코딩 도구나 터미널의 dandi가 이 계정({user.name})으로 로그인하려고 합니다. 승인하면 그 기기에서 이
        계정으로 사이트를 올리고 허브에 등록할 수 있습니다. 토큰이나 비밀번호를 대화창에 붙여 넣을 필요는 없습니다.
      </p>
      {ERRORS[errorKey] && <p className="error">{ERRORS[errorKey]}</p>}
    </>
  );
  const footer = (
    <p className="muted">
      로그인된 기기는 <Link href="/studio/cli">로그인된 기기 관리</Link> 화면에서 확인하고 폐기할 수 있습니다.
    </p>
  );

  if (!rawCode) {
    return (
      <>
        {intro}
        <p>AI 대화창이나 터미널에 보이는 8자리 코드를 입력하십시오.</p>
        <CodeForm />
        {footer}
      </>
    );
  }

  if (codeLookupBlocked(user.id)) {
    return (
      <>
        {intro}
        <p className="error">코드를 너무 여러 번 잘못 입력했습니다. 1시간 뒤 다시 시도하십시오.</p>
        {footer}
      </>
    );
  }

  const code = normalizeUserCode(rawCode);
  const view = code ? await getDeviceAuthByUserCode(code) : null;
  if (!view) {
    noteFailedCodeLookup(user.id);
    return (
      <>
        {intro}
        <p className="error">
          코드를 찾을 수 없습니다. 만료되었거나 잘못 입력했을 수 있습니다. 코드를 다시 확인하거나, 터미널이나 AI
          대화창에서 로그인을 다시 시작하십시오.
        </p>
        <CodeForm defaultValue={rawCode} />
        {footer}
      </>
    );
  }

  const mine = view.userId === user.id;
  if (view.status !== "pending" && !mine) {
    return (
      <>
        {intro}
        <p className="notice">이미 처리된 코드입니다. 새로 로그인하려면 터미널이나 AI 대화창에서 다시 시작하십시오.</p>
        <CodeForm />
        {footer}
      </>
    );
  }

  const remaining = remainingText(view.expiresAt);
  let body: React.ReactNode;
  if (view.status === "approved") {
    body = (
      <p className="notice">
        승인했습니다. 터미널이나 AI 대화창으로 돌아가십시오. 몇 초 안에 로그인이 끝납니다.
      </p>
    );
  } else if (view.status === "consumed") {
    body = (
      <p className="notice">
        연결을 마쳤습니다. 이 기기({clientLabel(view.client)} · {view.hostname === "unknown" ? "이름 없는 컴퓨터" : view.hostname} ·{" "}
        {friendlyOs(view.os)})가 이 계정의 로그인된 기기로 추가되었습니다.
      </p>
    );
  } else if (view.status === "denied") {
    body = (
      <p className="notice">
        거부했습니다. 이 코드로는 로그인할 수 없습니다. 직접 요청한 로그인이 아니었다면 아무것도 하지 않아도 됩니다.
      </p>
    );
  } else if (!remaining) {
    body = <p className="error">코드가 만료되었습니다. 터미널이나 AI 대화창에서 로그인을 다시 시작하십시오.</p>;
  } else {
    body = <Approval view={view} user={user} remaining={remaining} />;
  }

  return (
    <>
      {intro}
      {body}
      {footer}
    </>
  );
}
