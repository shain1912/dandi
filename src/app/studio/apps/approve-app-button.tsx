"use client";

import { useActionState } from "react";
import { approveAppAction, type ApproveAppState } from "./actions";

// 승인 대기 앱에 "학교 내부 승인 완료" 표시(F-16). 작성자·관리자 화면에서 사용한다.
export function ApproveAppButton({ appId }: { appId: string }) {
  const [state, action, pending] = useActionState<ApproveAppState, FormData>(approveAppAction, {});
  if (state.done) return <span className="muted">승인 완료로 표시했습니다.</span>;
  return (
    <form action={action}>
      <input type="hidden" name="id" value={appId} />
      <button type="submit" disabled={pending}>
        {pending ? "처리 중…" : "내부 승인 완료 표시"}
      </button>
      {state.error && <p className="error">{state.error}</p>}
    </form>
  );
}
