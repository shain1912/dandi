"use client";

import { useActionState } from "react";
import { PiiInput, PiiTextarea } from "@/components/pii-guard";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { archiveProjectAction, updateSettingsAction, type ProjectFormState } from "../actions";

// 프로젝트 설정 탭: 이름·설명·월 예산(F-31, F-33).
export function SettingsForm({
  projectId,
  name,
  description,
  budget,
  minBudget,
  maxBudget,
}: {
  projectId: string;
  name: string;
  description: string;
  budget: number;
  minBudget: number;
  maxBudget: number;
}) {
  const [state, action, pending] = useActionState<ProjectFormState, FormData>(updateSettingsAction, {});
  return (
    <form action={action} onSubmit={(e) => submitWithoutReset(e, action)} className="stack">
      <input type="hidden" name="projectId" value={projectId} />
      <PiiInput name="name" label="프로젝트 이름" defaultValue={name} required maxLength={40} />
      <PiiTextarea name="description" label="설명 (선택)" defaultValue={description} rows={3} maxLength={300} />
      <label className="field">
        <span>월 예산 (토큰, 필수)</span>
        <input
          name="monthlyTokenBudget"
          type="number"
          inputMode="numeric"
          min={minBudget}
          max={maxBudget}
          step={1}
          defaultValue={budget}
          required
        />
      </label>
      <div>
        <button type="submit" disabled={pending}>
          {pending ? "저장 중…" : "설정 저장"}
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

// 프로젝트 보관: 모든 키를 비활성화하고 되돌릴 수 없다.
export function ArchiveProjectForm({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [state, action, pending] = useActionState<ProjectFormState, FormData>(archiveProjectAction, {});
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (
          !window.confirm(
            `'${projectName}' 프로젝트를 보관하시겠습니까? 모든 키가 비활성화되어 이 프로젝트를 쓰는 미니앱의 AI 호출이 바로 멈추며, 되돌릴 수 없습니다.`,
          )
        ) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="projectId" value={projectId} />
      <button disabled={pending}>{pending ? "보관 중…" : "프로젝트 보관"}</button>
      {state.error && (
        <span className="error" role="alert">
          {" "}
          {state.error}
        </span>
      )}
      {state.message && (
        <span className="muted" role="status">
          {" "}
          {state.message}
        </span>
      )}
    </form>
  );
}
