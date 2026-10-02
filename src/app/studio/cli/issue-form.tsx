"use client";

import { useActionState, useState } from "react";
import { issueTokenAction, type IssueState } from "./actions";

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? "복사했습니다" : "복사"}
    </button>
  );
}

function CommandBlock({ label, command }: { label: string; command: string }) {
  return (
    <div>
      <p>
        {label} <CopyButton text={command} />
      </p>
      <pre>{command}</pre>
    </div>
  );
}

export function IssueTokenForm({
  origin,
  cli,
  activePrefixes,
}: {
  origin: string;
  cli: string;
  activePrefixes: string[];
}) {
  const [state, action, pending] = useActionState<IssueState>(issueTokenAction, {});
  // 방금 발급한 토큰을 표에서 폐기하면 원문과 로그인 명령을 더 이상 보여 주지 않는다.
  const secret = state.secret && activePrefixes.some((p) => state.secret!.startsWith(p)) ? state.secret : null;
  return (
    <>
      <form action={action}>
        <button type="submit" disabled={pending}>
          {pending ? "발급 중…" : "새 CLI 토큰 발급"}
        </button>
      </form>
      {state.error && <p className="error">{state.error}</p>}
      {secret && (
        <div role="status">
          <p className="notice">
            토큰 원문은 지금 한 번만 보여 드립니다. 이 화면을 벗어나면 다시 볼 수 없으므로 CI 비밀값에 바로 넣으십시오.
            토큰은 비밀번호와 같으니 대화창이나 다른 사람에게 붙여 넣지 마십시오.
          </p>
          <CommandBlock label="토큰" command={secret} />
          <CommandBlock
            label="CI·자동화에서 로그인 (토큰은 표준입력으로 전달해 셸 기록에 남지 않게 합니다)"
            command={`echo "$DANDI_TOKEN" | ${cli} login --token-stdin --hub ${origin}`}
          />
          <p className="muted">
            CI 대신 환경변수 DANDI_TOKEN과 DANDI_HUB만 설정해도 모든 명령이 이 토큰을 사용합니다.
          </p>
        </div>
      )}
    </>
  );
}
