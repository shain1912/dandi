"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { PiiInput, PiiTextarea } from "@/components/pii-guard";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { APP_CATEGORIES, SCHOOL_LEVELS } from "@/lib/constants";
import { publishSiteAction, type PublishState, type PublishValues } from "./actions";

// 사이트 허브 등록(F-51 publish)과 배포 전 개인정보 셀프점검(F-16).
// 문항과 안내 문구는 미니앱 등록 폼(studio/apps/new/new-app-form.tsx)과 같게 둔다.

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

export type DeployOption = { id: string; label: string };

export function PublishForm({
  siteId,
  deployOptions,
  defaults,
  republish,
}: {
  siteId: string;
  /** 공개할 배포 후보(최신이 먼저). 하나뿐이면 선택 칸 없이 그 배포를 쓴다. */
  deployOptions: DeployOption[];
  defaults: PublishValues;
  republish: boolean;
}) {
  const [state, action, pending] = useActionState<PublishState, FormData>(publishSiteAction, {});
  const v = state.values ?? defaults;
  const [collects, setCollects] = useState(v.collectsStudentData);
  const [category, setCategory] = useState(v.category || "class");

  if (state.result) {
    const r = state.result;
    return (
      <div>
        {/* 공개 주소가 바로 바뀌었는지, 승인 전까지 이전 버전(또는 승인 대기 안내)을 보여 주는지는 서버 message가 알려 준다. */}
        <p className="notice" role="status">
          {r.message}
        </p>
        <ul className="list">
          <li>
            공개 주소:{" "}
            <a href={r.liveUrl} target="_blank" rel="noopener noreferrer">
              {r.liveUrl}
            </a>
            {r.liveVersion === "kept_until_approval" && <span className="muted"> (승인 후 이 버전으로 바뀝니다)</span>}
          </li>
          {r.liveVersion === "kept_until_approval" && (
            <li>
              이번에 등록한 버전 미리보기:{" "}
              <a href={r.previewUrl} target="_blank" rel="noopener noreferrer">
                {r.previewUrl}
              </a>
            </li>
          )}
          <li>
            허브 앱 화면: <Link href={`/apps/${r.appId}`}>{r.appUrl}</Link>
          </li>
          <li>
            <Link href={`/studio/sites/${siteId}`}>사이트 관리 화면으로 가기</Link>
          </li>
        </ul>
      </div>
    );
  }

  return (
    <form action={action} onSubmit={(e) => submitWithoutReset(e, action)} className="stack">
      <input type="hidden" name="siteId" value={siteId} />
      {deployOptions.length > 1 ? (
        <label className="field">
          <span>공개할 버전</span>
          <select name="deployId" defaultValue={deployOptions[0].id}>
            {deployOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <input type="hidden" name="deployId" value={deployOptions[0]?.id ?? ""} />
      )}

      <PiiInput name="title" label="앱 이름" required maxLength={80} defaultValue={v.title} />
      <PiiTextarea
        name="description"
        label="설명"
        rows={4}
        maxLength={2000}
        defaultValue={v.description}
        placeholder="어떤 수업·업무에 쓰는 앱인지 적으십시오. 학생 이름이나 연락처는 적지 마십시오."
      />

      <fieldset>
        <legend>학교급 (하나 이상)</legend>
        {SCHOOL_LEVELS.map((l) => (
          <label key={l.id} style={{ marginRight: 12 }}>
            <input type="checkbox" name="schoolLevels" value={l.id} defaultChecked={v.schoolLevels.includes(l.id)} />{" "}
            {l.label}
          </label>
        ))}
      </fieldset>

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
          value={v.collectsStudentData}
          onChange={setCollects}
        />
        <PiiInput
          name="storageLocation"
          label="데이터 저장 위치"
          required
          maxLength={200}
          defaultValue={v.storageLocation}
          placeholder="예: 저장 안 함(브라우저 안에서만 처리), Supabase(서울 리전)"
        />
        <PiiInput
          name="retention"
          label="보관 기간"
          required
          maxLength={200}
          defaultValue={v.retention}
          placeholder="예: 저장 안 함, 학기 종료 시 삭제"
        />
        <YesNo
          name="externalTransfer"
          legend="입력 내용을 외부 서비스(해외 AI API 등)로 보냅니까?"
          value={v.externalTransfer}
        />
        <YesNo
          name="needsSchoolApproval"
          legend="학교 내부 승인(운영위원회 등)이 필요합니까?"
          value={v.needsSchoolApproval}
          help="학생 개인정보를 수집·처리하는 앱은 학교 내부 승인을 거친 뒤 사용해야 합니다. 교사단 논의에서, 한 학교의 학생지도 앱이 개인정보 문제로 운영위원회를 통과할 때까지 사용이 보류된 사례가 있었습니다. 승인 절차를 미리 확인하십시오. '예'를 선택하면 승인 대기 상태로 등록되어, 내부 승인 완료를 표시하기 전까지 허브 목록과 무로그인 실행에서 빠집니다."
        />
        {collects === "yes" && (
          <p className="notice" style={{ margin: 0 }}>
            학생 개인정보를 처리하는 앱은 학교 내부 승인 필요 여부를 &quot;예&quot;로 선택해야 등록됩니다. 앱
            카드에는 &quot;개인정보 처리&quot; 표시가 붙습니다.
          </p>
        )}
        {republish && (
          <p className="muted" style={{ margin: 0 }}>
            다시 등록하면 공개 주소가 고른 버전으로 바뀝니다. 이미 내부 승인을 받은 앱을 같은 셀프점검 답으로 다시 등록하면
            승인 완료 상태를 유지합니다. 답이 바뀌어 학교 내부 승인이 다시 필요하면 새 버전은 승인 대기 상태가 되고, 승인
            완료를 표시할 때까지 공개 주소는 이전에 공개한 버전을 계속 보여 줍니다.
          </p>
        )}
      </fieldset>

      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending || deployOptions.length === 0}>
        {pending ? "등록 중…" : republish ? "셀프점검 완료 후 다시 등록" : "셀프점검 완료 후 허브에 등록"}
      </button>
    </form>
  );
}
