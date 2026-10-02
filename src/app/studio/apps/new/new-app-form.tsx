"use client";

import { useActionState, useState } from "react";
import { PiiInput, PiiTextarea } from "@/components/pii-guard";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { APP_CATEGORIES, SCHOOL_LEVELS } from "@/lib/constants";
import type { SchoolLevel } from "@/lib/types";
import { createAppAction, type NewAppState } from "../actions";

// 미니앱 등록 폼(F-04)과 배포 전 개인정보 셀프점검(F-16).
// 자유 입력 칸은 PiiInput/PiiTextarea로 실시간 경고하고(F-13), 제출 시 개인정보가 있으면 막는다.

function YesNo({
  name,
  legend,
  value,
  help,
  onChange,
}: {
  name: string;
  legend: string;
  value?: string;
  help?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <label>
        <input
          type="radio"
          name={name}
          value="yes"
          required
          defaultChecked={value === "yes"}
          onChange={() => onChange?.("yes")}
        />{" "}
        예
      </label>{" "}
      <label>
        <input
          type="radio"
          name={name}
          value="no"
          defaultChecked={value === "no"}
          onChange={() => onChange?.("no")}
        />{" "}
        아니요
      </label>
      {help && (
        <p className="muted" style={{ margin: "4px 0 0" }}>
          {help}
        </p>
      )}
    </fieldset>
  );
}

export function NewAppForm({
  defaultLevel,
  projects,
}: {
  defaultLevel: SchoolLevel | null;
  projects: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState<NewAppState, FormData>(createAppAction, {});
  const v = state.values;
  const [collects, setCollects] = useState(v?.collectsStudentData ?? "");
  const [category, setCategory] = useState(v?.category ?? "class");
  const checkedLevels: string[] = v?.schoolLevels ?? (defaultLevel ? [defaultLevel] : []);

  return (
    <form action={action} onSubmit={(e) => submitWithoutReset(e, action)} className="stack">
      <PiiInput name="title" label="앱 이름" required maxLength={80} defaultValue={v?.title} />
      <PiiTextarea
        name="description"
        label="설명"
        rows={4}
        maxLength={2000}
        defaultValue={v?.description}
        placeholder="어떤 수업·업무에 쓰는 앱인지 적으십시오. 학생 이름이나 연락처는 적지 마십시오."
      />
      <PiiInput
        name="url"
        label="배포 URL"
        inputMode="url"
        required
        maxLength={500}
        defaultValue={v?.url}
        placeholder="https://my-app.vercel.app"
      />

      <fieldset>
        <legend>학교급 (하나 이상)</legend>
        {SCHOOL_LEVELS.map((l) => (
          <label key={l.id} style={{ marginRight: 12 }}>
            <input
              type="checkbox"
              name="schoolLevels"
              value={l.id}
              defaultChecked={checkedLevels.includes(l.id)}
            />{" "}
            {l.label}
          </label>
        ))}
      </fieldset>

      {projects.length > 0 && (
        <label className="field">
          <span>연결할 프로젝트 (AI API 키와 예산을 쓰는 단위)</span>
          <select name="projectId" defaultValue="">
            <option value="">기본 프로젝트</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="field">
        <span>분류</span>
        <select name="category" required value={category} onChange={(e) => setCategory(e.target.value)}>
          {APP_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <fieldset style={{ display: "grid", gap: 12 }}>
        <legend>배포 전 개인정보 셀프점검 (필수)</legend>
        <p className="muted" style={{ margin: 0 }}>
          모든 항목을 작성해야 앱이 공개됩니다. 점검 결과는 앱 실행 화면에 그대로 표시됩니다.
        </p>
        <YesNo
          name="collectsStudentData"
          legend="학생 개인정보(이름, 학번, 연락처, 상담 기록 등)를 수집하거나 처리합니까?"
          value={v?.collectsStudentData}
          onChange={setCollects}
        />
        <PiiInput
          name="storageLocation"
          label="데이터 저장 위치"
          required
          maxLength={200}
          defaultValue={v?.storageLocation}
          placeholder="예: 저장 안 함(브라우저 안에서만 처리), Supabase(서울 리전)"
        />
        <PiiInput
          name="retention"
          label="보관 기간"
          required
          maxLength={200}
          defaultValue={v?.retention}
          placeholder="예: 저장 안 함, 학기 종료 시 삭제"
        />
        <YesNo
          name="externalTransfer"
          legend="입력 내용을 외부 서비스(해외 AI API 등)로 보냅니까?"
          value={v?.externalTransfer}
        />
        <YesNo
          name="needsSchoolApproval"
          legend="학교 내부 승인(운영위원회 등)이 필요합니까?"
          value={v?.needsSchoolApproval}
          help="학생 개인정보를 수집·처리하는 앱은 학교 내부 승인을 거친 뒤 사용해야 합니다. 교사단 논의에서, 한 학교의 학생지도 앱이 개인정보 문제로 운영위원회를 통과할 때까지 사용이 보류된 사례가 있었습니다. 승인 절차를 미리 확인하십시오. '예'를 선택하면 승인 대기 상태로 등록되어, 내부 승인 완료를 표시하기 전까지 허브 목록과 무로그인 실행에서 빠집니다."
        />
        {collects === "yes" && (
          <p className="notice" style={{ margin: 0 }}>
            학생 개인정보를 처리하는 앱은 학교 내부 승인 필요 여부를 &quot;예&quot;로 선택해야 등록됩니다. 앱
            카드에는 &quot;개인정보 처리&quot; 표시가 붙습니다.
          </p>
        )}
      </fieldset>

      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "등록 중…" : "셀프점검 완료 후 등록"}
      </button>
    </form>
  );
}
