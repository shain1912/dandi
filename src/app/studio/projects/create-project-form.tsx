"use client";

import { useActionState } from "react";
import { PiiInput, PiiTextarea } from "@/components/pii-guard";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { createProjectAction, type ProjectFormState } from "./actions";

// F-31 새 프로젝트. 월 예산은 필수(F-33). 성공하면 서버 액션이 프로젝트 키 탭으로 보낸다.
export function CreateProjectForm({
  defaultName,
  defaultBudget,
  minBudget,
  maxBudget,
  disabled,
}: {
  defaultName: string;
  defaultBudget: number;
  minBudget: number;
  maxBudget: number;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState<ProjectFormState, FormData>(createProjectAction, {});
  return (
    <form action={action} onSubmit={(e) => submitWithoutReset(e, action)} className="stack">
      <PiiInput
        name="name"
        label="프로젝트 이름"
        defaultValue={defaultName}
        required
        maxLength={40}
        placeholder="예: 3반 퀴즈앱"
      />
      <PiiTextarea name="description" label="설명 (선택)" rows={3} maxLength={300} />
      <label className="field">
        <span>월 예산 (토큰, 필수)</span>
        <input
          name="monthlyTokenBudget"
          type="number"
          inputMode="numeric"
          min={minBudget}
          max={maxBudget}
          step={1}
          defaultValue={defaultBudget}
          required
        />
      </label>
      <p className="muted">
        월 예산의 80%를 넘으면 알림을 표시하고, 100%에 이르면 이 프로젝트의 호출을 막습니다. 예산은 한국 시각 기준 매월
        1일에 초기화됩니다.
      </p>
      <div>
        <button type="submit" disabled={pending || disabled}>
          {pending ? "만드는 중…" : "프로젝트 만들기"}
        </button>
      </div>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
