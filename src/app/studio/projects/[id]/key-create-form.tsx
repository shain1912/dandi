"use client";

import { useActionState } from "react";
import { CopyButton } from "@/components/copy-button";
import { PiiInput } from "@/components/pii-guard";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { createKeyAction, type KeyCreateState } from "../actions";

type Option = { id: string; label: string; desc?: string };

// F-32 새 API 키. 이름·역할·만료 프리셋을 고르고, 원문은 발급 직후 이 화면에서 한 번만 보여 준다.
// 방금 만든 키를 목록에서 비활성화·삭제하면 원문 표시를 감춘다(activeKeyIds와 비교).
export function KeyCreateForm({
  projectId,
  roles,
  expiries,
  defaultExpiry,
  activeKeyIds,
  hubOrigin,
}: {
  projectId: string;
  roles: Option[];
  expiries: Option[];
  defaultExpiry: string;
  activeKeyIds: string[];
  hubOrigin: string;
}) {
  const [state, action, pending] = useActionState<KeyCreateState, FormData>(createKeyAction, {});
  const secret = state.secret && state.keyId && activeKeyIds.includes(state.keyId) ? state.secret : null;

  return (
    <>
      {secret && (
        <div className="notice" role="status">
          <p>
            <strong>새 API 키 &apos;{state.name}&apos;를 만들었습니다. 이 키는 지금 한 번만 표시됩니다.</strong> 지금 복사해
            미니앱 서버의 환경변수에 저장하십시오. 이 화면을 벗어나면 다시 볼 수 없으며, 잃어버리면 새 키를 만들어야
            합니다.
          </p>
          <p>
            <code style={{ wordBreak: "break-all" }}>{secret}</code>
          </p>
          <p>
            <CopyButton text={secret} label="키 복사" copiedMessage="복사했습니다. 안전한 곳에 붙여 넣으십시오." />
          </p>
          <p>
            HTML·JavaScript 파일, 공개 저장소, 채팅에 붙여 넣지 마십시오. 브라우저에서 이 키로 직접 부르면 게이트웨이가
            401(browser_key_forbidden)로 거부합니다. 미니앱 서버의 .env.local 파일이나 배포 환경변수에 아래처럼
            넣으십시오.
          </p>
          <pre>{`DANDI_PROJECT_KEY=${secret}\nDANDI_HUB_URL=${hubOrigin}`}</pre>
        </div>
      )}

      <form
        key={state.savedAt ?? "new"}
        action={action}
        onSubmit={(e) => submitWithoutReset(e, action)}
        className="stack"
      >
        <input type="hidden" name="projectId" value={projectId} />
        <PiiInput name="name" label="키 이름" required maxLength={40} placeholder="예: 3반 퀴즈앱 서버" />
        <fieldset>
          <legend>역할</legend>
          {roles.map((r, i) => (
            <label key={r.id} style={{ display: "block" }}>
              <input type="radio" name="role" value={r.id} defaultChecked={i === 0} required /> {r.label}
              {r.desc && <span className="muted"> · {r.desc}</span>}
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>만료</span>
          <select name="expires" defaultValue={defaultExpiry}>
            {expiries.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
        <div>
          <button type="submit" disabled={pending}>
            {pending ? "만드는 중…" : "새 API 키 만들기"}
          </button>
        </div>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
      </form>
    </>
  );
}
