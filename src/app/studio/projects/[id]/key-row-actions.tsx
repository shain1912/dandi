"use client";

import { useActionState } from "react";
import { keyAction, type KeyActionState } from "../actions";

// F-32 키 관리 버튼: 비활성화(복구 가능) · 다시 켜기 · 삭제(영구, 확인 필요).
export function KeyRowActions({
  projectId,
  keyId,
  keyName,
  status,
  archived,
}: {
  projectId: string;
  keyId: string;
  keyName: string;
  status: "active" | "disabled" | "expired" | "deleted";
  archived: boolean;
}) {
  const [state, action, pending] = useActionState<KeyActionState, FormData>(keyAction, {});

  return (
    <form
      action={action}
      onSubmit={(e) => {
        const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        if (
          submitter?.value === "delete" &&
          !window.confirm(`'${keyName}' 키를 삭제하시겠습니까? 삭제하면 되돌릴 수 없고, 이 키를 쓰는 미니앱은 바로 멈춥니다.`)
        ) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="keyId" value={keyId} />
      {status === "active" && (
        <button name="op" value="disable" disabled={pending}>
          비활성화
        </button>
      )}
      {status === "disabled" && !archived && (
        <button name="op" value="enable" disabled={pending}>
          다시 켜기
        </button>
      )}{" "}
      <button name="op" value="delete" disabled={pending}>
        삭제
      </button>
      {state.error && (
        <span className="error" role="alert">
          {" "}
          {state.error}
        </span>
      )}
    </form>
  );
}
