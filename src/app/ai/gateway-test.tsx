"use client";

import { useActionState, useState } from "react";
import { PiiTextarea } from "@/components/pii-guard";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { testGateway, type GatewayTestState } from "./actions";

export type ModelOption = { id: string; name: string; allowed: boolean; statusLabel: string };
export type TestProject = {
  id: string;
  name: string;
  /** 호출에 쓸 수 있는 키(사용 중, inference·admin 역할) */
  keys: { id: string; label: string }[];
  /** 이 프로젝트에서 실제로 호출 가능한 모델 id(교육청 허용 ∩ 프로젝트 허용) */
  modelIds: string[];
};

const n = (v: number) => v.toLocaleString("ko-KR");

function firstCallable(models: ModelOption[], project: TestProject | undefined, preferred: string): string {
  const ok = (id: string) => models.some((m) => m.id === id && m.allowed) && !!project?.modelIds.includes(id);
  if (preferred && ok(preferred)) return preferred;
  return models.find((m) => ok(m.id))?.id ?? "";
}

// F-21 게이트웨이 테스트. 프로젝트와 그 프로젝트의 키를 고르면 서버가 그 키로 호출한다.
// 이 폼은 개인정보가 있어도 제출을 막지 않는다(서버가 모델로 보내기 전에 가리는 과정을 보여 주기 위해서다).
export function GatewayTestForm({
  projects,
  models,
  defaultProjectId,
}: {
  projects: TestProject[];
  models: ModelOption[];
  defaultProjectId: string;
}) {
  const [state, action, pending] = useActionState<GatewayTestState, FormData>(testGateway, {});
  const [projectId, setProjectId] = useState(defaultProjectId);
  const project = projects.find((p) => p.id === projectId);
  const [keyId, setKeyId] = useState(project?.keys[0]?.id ?? "");
  const [model, setModel] = useState(() => firstCallable(models, project, ""));
  const r = state.result;

  function changeProject(id: string) {
    const next = projects.find((p) => p.id === id);
    setProjectId(id);
    setKeyId(next?.keys[0]?.id ?? "");
    setModel((current) => firstCallable(models, next, current));
  }

  const optionLabel = (m: ModelOption) => {
    if (!m.allowed) return `${m.name} (${m.statusLabel})`;
    if (!project?.modelIds.includes(m.id)) return `${m.name} (이 프로젝트에서 허용 안 함)`;
    return m.name;
  };

  return (
    <>
      {/* 개인정보가 있어도 막지 않는다: 게이트웨이가 서버에서 가리는 것을 보여 주기 위한 화면이다. */}
      <form action={action} onSubmit={(e) => submitWithoutReset(e, action, { checkPII: false })} className="stack">
        <label className="field">
          <span>프로젝트</span>
          <select name="projectId" value={projectId} onChange={(e) => changeProject(e.target.value)} required>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.keys.length === 0 ? " (호출용 키 없음)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>API 키 (서버에서 이 키로 호출합니다)</span>
          <select name="keyId" value={keyId} onChange={(e) => setKeyId(e.target.value)} required>
            {project?.keys.length ? (
              project.keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))
            ) : (
              <option value="">이 프로젝트에 호출용 키가 없습니다</option>
            )}
          </select>
        </label>
        <label className="field">
          <span>모델 (이 프로젝트에서 허용된 모델만 선택할 수 있습니다)</span>
          <select name="model" value={model} onChange={(e) => setModel(e.target.value)} required>
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.allowed || !project?.modelIds.includes(m.id)}>
                {optionLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <PiiTextarea
          name="prompt"
          label="프롬프트"
          rows={6}
          maxLength={8000}
          required
          placeholder="예: 학부모 상담 안내 가정통신문 초안을 써 주십시오. 문의는 담임 010-1234-5678로 받습니다."
        />
        <p className="muted">
          이 테스트 폼은 개인정보 경고가 떠도 제출을 막지 않습니다. 게이트웨이가 서버에서 개인정보를 가린 뒤 모델로
          보내는 과정을 확인하십시오. 호출한 토큰은 고른 프로젝트의 월 예산에서 빠집니다.
        </p>
        <div>
          <button type="submit" disabled={pending || !keyId || !model}>
            {pending ? "호출 중…" : "게이트웨이로 호출"}
          </button>
        </div>
      </form>

      {state.error && (
        <p className="error" role="alert">
          {state.code ? `[${state.code}] ` : ""}
          {state.error}
          {state.hint ? ` ${state.hint}` : ""}
        </p>
      )}

      {r && (
        <section aria-live="polite">
          <h3>응답 ({r.modelName})</h3>
          <p className={r.piiMasked > 0 ? "notice" : "muted"}>
            {r.piiMasked > 0
              ? `게이트웨이가 개인정보 ${r.piiMasked}건(${r.piiLabels.join(", ")})을 *** 로 가린 뒤 모델로 전달했습니다.`
              : "프롬프트에서 가릴 개인정보가 발견되지 않았습니다."}
          </p>
          <pre>{r.output}</pre>
          <p className="muted">
            이번 호출 {n(r.tokens)}토큰 · 프로젝트 &apos;{r.projectName}&apos; 남은 예산 {n(r.remaining)} / {n(r.quota)}토큰 ·
            교사 전체 남은 한도 {n(r.teacherRemaining)} / {n(r.teacherCap)}토큰
          </p>
          {r.warnings.map((w) => (
            <p key={w} className="notice">
              {w}
            </p>
          ))}
        </section>
      )}
    </>
  );
}
