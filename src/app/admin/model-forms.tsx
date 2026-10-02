"use client";

import { useActionState, useState } from "react";
import { PiiInput } from "@/components/pii-guard";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { MODEL_STATUS_LABEL } from "@/lib/constants";
import type { AiModel, ModelDeployment, ModelStatus } from "@/lib/types";
import { createModel, updateModelGuideAction, updateModelStatus, type AdminFormState } from "./actions";

const STATUSES: ModelStatus[] = ["allowed", "pending", "blocked"];

// 폼은 submitWithoutReset으로 보내 React 19의 자동 초기화(select가 처음 값으로 돌아감)를 피한다.
// 성공 후 비울 입력칸은 savedAt을 key로 다시 마운트한다.

// 모델 허용 정책 표의 한 행에 들어가는 상태 변경 폼(F-23).
export function ModelStatusForm({ modelId, status }: { modelId: string; status: ModelStatus }) {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(updateModelStatus, {});
  const [selected, setSelected] = useState<ModelStatus>(status);
  return (
    <form action={action} onSubmit={(e) => submitWithoutReset(e, action)} style={{ display: "grid", gap: 6, minWidth: 220 }}>
      <input type="hidden" name="modelId" value={modelId} />
      <label className="field">
        <span>상태</span>
        <select name="status" value={selected} onChange={(e) => setSelected(e.target.value as ModelStatus)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {MODEL_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <PiiInput
        key={state.savedAt ?? "init"}
        name="reason"
        label="사유(선택)"
        maxLength={200}
        placeholder="예: 2026-10 교육청 지침"
      />
      <button type="submit" disabled={pending}>
        {pending ? "저장 중…" : "저장"}
      </button>
      {state.error && <span className="error">{state.error}</span>}
      {state.message && <span className="muted">{state.message}</span>}
    </form>
  );
}

function DeploymentSelect({
  value,
  onChange,
}: {
  value: ModelDeployment;
  onChange: (v: ModelDeployment) => void;
}) {
  return (
    <label className="field">
      <span>실행 방식</span>
      <select name="deployment" value={value} onChange={(e) => onChange(e.target.value as ModelDeployment)}>
        <option value="api">온라인 API</option>
        <option value="local">로컬·온프레미스</option>
      </select>
    </label>
  );
}

// 모델 가이드 수정 폼(F-22). 표의 각 행에서 펼쳐 사용한다.
export function ModelGuideForm({ model }: { model: AiModel }) {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(updateModelGuideAction, {});
  const [deployment, setDeployment] = useState<ModelDeployment>(model.deployment);
  return (
    <details>
      <summary>가이드 수정</summary>
      <form action={action} onSubmit={(e) => submitWithoutReset(e, action)} className="stack" style={{ marginTop: 8 }}>
        <input type="hidden" name="modelId" value={model.id} />
        <PiiInput name="name" label="모델 이름" required maxLength={60} defaultValue={model.name} />
        <PiiInput name="provider" label="제공사" required maxLength={60} defaultValue={model.provider} />
        <PiiInput name="origin" label="개발 국가" required maxLength={60} defaultValue={model.origin} />
        <DeploymentSelect value={deployment} onChange={setDeployment} />
        <PiiInput
          name="dataLocation"
          label="데이터 처리 위치"
          required
          maxLength={60}
          defaultValue={model.dataLocation}
        />
        <PiiInput
          name="recommendedUse"
          label="권장 용도"
          required
          maxLength={200}
          defaultValue={model.recommendedUse}
        />
        <button type="submit" disabled={pending}>
          {pending ? "저장 중…" : "가이드 저장"}
        </button>
        {state.error && <span className="error">{state.error}</span>}
        {state.message && <span className="muted">{state.message}</span>}
      </form>
    </details>
  );
}

// 모델 추가 폼(F-23). 상태는 선택할 수 없고 항상 '보류'로 추가된다.
// 성공하면 savedAt이 바뀌어 입력칸이 모두 비고, 실패하면 입력값이 그대로 남는다.
export function AddModelForm() {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(createModel, {});
  return <AddModelFields key={state.savedAt ?? "init"} state={state} action={action} pending={pending} />;
}

function AddModelFields({
  state,
  action,
  pending,
}: {
  state: AdminFormState;
  action: (formData: FormData) => void;
  pending: boolean;
}) {
  const [deployment, setDeployment] = useState<ModelDeployment>("api");
  return (
    <form action={action} onSubmit={(e) => submitWithoutReset(e, action)} className="stack">
      <PiiInput
        name="id"
        label="모델 id (게이트웨이 호출용, 영문 소문자·숫자·하이픈)"
        required
        maxLength={40}
        pattern="[a-z0-9][a-z0-9._\-]{1,39}"
        placeholder="예: solar-pro"
      />
      <PiiInput name="name" label="모델 이름" required maxLength={60} placeholder="예: Solar Pro" />
      <PiiInput name="provider" label="제공사" required maxLength={60} placeholder="예: Upstage" />
      <PiiInput name="origin" label="개발 국가" required maxLength={60} placeholder="예: 대한민국" />
      <DeploymentSelect value={deployment} onChange={setDeployment} />
      <PiiInput name="dataLocation" label="데이터 처리 위치" required maxLength={60} placeholder="예: 국내" />
      <PiiInput
        name="recommendedUse"
        label="권장 용도"
        required
        maxLength={200}
        placeholder="예: 한국어 문서 작성, 업무 자동화"
      />
      <p className="muted">새 모델은 &apos;보류&apos; 상태로 추가됩니다. 허용하려면 위 표에서 상태를 바꾸십시오.</p>
      <button type="submit" disabled={pending}>
        {pending ? "추가 중…" : "모델 추가"}
      </button>
      {state.error && <p className="error">{state.error}</p>}
      {state.message && <p className="muted">{state.message}</p>}
    </form>
  );
}
