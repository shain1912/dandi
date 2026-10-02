"use client";

import { useActionState, useState } from "react";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { updateModelsAction, type ProjectFormState } from "../actions";

export type ModelChoice = { id: string; name: string; allowed: boolean; statusLabel: string };

// F-34 프로젝트 허용 모델. 실제 호출 가능 모델 = 교육청 허용 ∩ 이 목록.
// 정책 검토 중인 모델도 미리 고를 수 있다(교육청이 허용하면 그때부터 호출된다).
export function ModelsForm({
  projectId,
  models,
  selected,
  disabled,
}: {
  projectId: string;
  models: ModelChoice[];
  /** null = 교육청 허용 모델 전체 */
  selected: string[] | null;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState<ProjectFormState, FormData>(updateModelsAction, {});
  const [mode, setMode] = useState<"all" | "custom">(selected === null ? "all" : "custom");

  return (
    <form action={action} onSubmit={(e) => submitWithoutReset(e, action)} className="stack">
      <input type="hidden" name="projectId" value={projectId} />
      <fieldset disabled={disabled}>
        <legend>허용 방식</legend>
        <label style={{ display: "block" }}>
          <input type="radio" name="mode" value="all" checked={mode === "all"} onChange={() => setMode("all")} /> 교육청
          허용 모델 전체 (교육청이 새로 허용한 모델도 바로 쓸 수 있습니다)
        </label>
        <label style={{ display: "block" }}>
          <input type="radio" name="mode" value="custom" checked={mode === "custom"} onChange={() => setMode("custom")} />{" "}
          직접 고르기 (이 프로젝트에서 쓸 모델만)
        </label>
      </fieldset>
      <fieldset disabled={disabled || mode === "all"}>
        <legend>모델</legend>
        {models.map((m) => (
          <label key={m.id} style={{ display: "block" }}>
            <input
              type="checkbox"
              name="modelIds"
              value={m.id}
              defaultChecked={selected === null ? m.allowed : selected.includes(m.id)}
            />{" "}
            {m.name} <code className="muted">{m.id}</code>{" "}
            <span className={m.allowed ? "badge" : "badge warn"}>{m.statusLabel}</span>
          </label>
        ))}
      </fieldset>
      <div>
        <button type="submit" disabled={pending || disabled}>
          {pending ? "저장 중…" : "허용 모델 저장"}
        </button>
      </div>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.message && (
        <p className="muted" role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
