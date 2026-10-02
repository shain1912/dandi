"use client";

import { useActionState } from "react";
import { deleteBookAction, type BookFormState } from "../actions";

export function DeleteBookButton({ id, title, kind }: { id: string; title: string; kind: "webbook" | "pdf" }) {
  const [state, action, pending] = useActionState<BookFormState, FormData>(deleteBookAction, {});
  const note = kind === "pdf" ? " 자료실의 PDF 파일은 지워지지 않습니다." : "";
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`"${title}" 책을 서가에서 삭제하시겠습니까?${note}`)) e.preventDefault();
      }}
      style={{ display: "inline" }}
    >
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={pending}>
        {pending ? "삭제 중…" : "서가에서 삭제"}
      </button>
      {state.error && <p className="error">{state.error}</p>}
    </form>
  );
}
