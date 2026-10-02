"use client";

import { useActionState } from "react";
import { deleteAppAction, type DeleteAppState } from "./actions";

export function DeleteAppButton({ appId, title }: { appId: string; title: string }) {
  const [state, action, pending] = useActionState<DeleteAppState, FormData>(deleteAppAction, {});
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`"${title}" 앱을 삭제하시겠습니까? 되돌릴 수 없습니다.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={appId} />
      <button disabled={pending}>{pending ? "삭제 중…" : "삭제"}</button>
      {state.error && (
        <span className="error" role="alert">
          {" "}
          {state.error}
        </span>
      )}
    </form>
  );
}
