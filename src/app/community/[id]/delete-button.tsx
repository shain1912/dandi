"use client";

import { useActionState } from "react";
import type { FormState } from "../actions";

// 작성자·관리자에게만 보이는 삭제 버튼. 권한은 서버 액션에서 다시 확인한다(F-15 프로토타입).
export function DeleteButton({
  action,
  label,
  confirmMessage,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  label: string;
  confirmMessage: string;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {});
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      {/* type을 생략해도 제출 버튼이다. 강조 색(submit 스타일)을 쓰지 않으려고 생략한다. */}
      <button disabled={pending}>{pending ? "삭제 중…" : label}</button>
      {state.error && (
        <span className="error" role="alert">
          {" "}
          {state.error}
        </span>
      )}
    </form>
  );
}
