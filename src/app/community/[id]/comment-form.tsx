"use client";

import { useActionState } from "react";
import { blockSubmitIfPII, PiiTextarea } from "@/components/pii-guard";
import type { FormState } from "../actions";

export function CommentForm({
  action,
  maxLength,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  maxLength: number;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, { seq: 0 });
  return (
    <form action={formAction} onSubmit={blockSubmitIfPII} className="stack" style={{ marginTop: 16 }}>
      {/* 등록에 성공하면 seq가 바뀌어 입력창을 비운다. 실패하면 입력한 내용을 그대로 둔다. */}
      <PiiTextarea key={state.seq ?? 0} name="body" label="댓글 쓰기" required maxLength={maxLength} rows={3} />
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p className="notice" role="status">
          {state.notice}
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "등록 중…" : "댓글 등록"}
      </button>
    </form>
  );
}
