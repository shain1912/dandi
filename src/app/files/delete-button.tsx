"use client";

import { useActionState } from "react";
import { deleteFileAction, type FileFormState } from "./actions";

export function DeleteFileButton({ id, title }: { id: string; title: string }) {
  const [state, action, pending] = useActionState<FileFormState, FormData>(deleteFileAction, {});
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`"${title}" 자료를 삭제하시겠습니까? 저장된 파일도 함께 지워집니다.`)) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={pending}>
        {pending ? "삭제 중…" : "삭제"}
      </button>
      {state.error && <p className="error">{state.error}</p>}
    </form>
  );
}
