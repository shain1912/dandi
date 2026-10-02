"use client";

import { startTransition, useActionState, useState } from "react";
import { blockSubmitIfPII, PiiInput, PiiTextarea } from "@/components/pii-guard";
import { SCHOOL_LEVELS, UPLOAD_ALLOWED_EXT, UPLOAD_MAX_BYTES } from "@/lib/constants";
import { hasPII } from "@/lib/pii";
import type { LevelOrAll } from "@/lib/types";
import { uploadFileAction, type FileFormState } from "../actions";

const ACCEPT = UPLOAD_ALLOWED_EXT.map((e) => `.${e}`).join(",");

/** 서버로 보내기 전에 형식과 크기를 미리 확인한다. 최종 검사는 서버(saveUpload)가 한다. */
function precheck(file: File | undefined): string | null {
  if (!file || file.size === 0) return "업로드할 파일을 선택하십시오. 빈 파일은 올릴 수 없습니다.";
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (!UPLOAD_ALLOWED_EXT.includes(ext)) {
    return `허용되지 않는 형식입니다. 허용 확장자: ${UPLOAD_ALLOWED_EXT.join(", ")}`;
  }
  if (file.size > UPLOAD_MAX_BYTES) {
    return `파일이 너무 큽니다. 최대 ${UPLOAD_MAX_BYTES / (1024 * 1024)}MB까지 올릴 수 있습니다.`;
  }
  // F-13: 파일 이름은 목록과 다운로드 이름으로 공개되므로 개인정보가 보이면 막는다(서버도 가린다).
  if (hasPII(file.name)) return "파일 이름에 개인정보로 보이는 내용이 있습니다. 이름을 바꾼 뒤 올리십시오.";
  return null;
}

export function UploadForm({
  defaultLevel,
  titleMax,
  descriptionMax,
}: {
  defaultLevel: LevelOrAll;
  titleMax: number;
  descriptionMax: number;
}) {
  const [state, action, pending] = useActionState<FileFormState, FormData>(uploadFileAction, {});
  const [clientError, setClientError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    // F-13: 제목·설명에 개인정보가 있으면 제출을 막는다.
    blockSubmitIfPII(e);
    if (e.defaultPrevented) {
      setClientError("개인정보로 보이는 내용을 지우거나 바꾼 뒤 등록하십시오.");
      return;
    }
    const input = e.currentTarget.elements.namedItem("file");
    const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
    const err = precheck(file);
    setClientError(err);
    // 직접 보낸다(preventDefault). React 19는 action 속성으로 보낸 폼을 끝난 뒤 초기화하는데, 그러면 서버 오류가 났을 때
    // 고른 파일·확인 체크·학교급이 모두 지워지기 때문이다. action 속성은 JS가 없거나 하이드레이션 전 제출(POST)용으로 남긴다.
    e.preventDefault();
    if (err) return;
    const formData = new FormData(e.currentTarget);
    startTransition(() => action(formData));
  }

  return (
    <form action={action} onSubmit={onSubmit} className="stack">
      <label className="field">
        <span>파일</span>
        <input
          type="file"
          name="file"
          required
          accept={ACCEPT}
          onChange={(e) => setClientError(precheck(e.target.files?.[0]))}
        />
      </label>
      <PiiInput name="title" label="제목" required maxLength={titleMax} placeholder="예: 수행평가 채점 도우미 설치 파일" />
      <PiiTextarea
        name="description"
        label="설명 (선택)"
        maxLength={descriptionMax}
        rows={4}
        placeholder="사용 방법, 대상 학년, 실행 환경 등을 적으십시오."
      />
      <label className="field">
        <span>학교급</span>
        <select name="schoolLevel" defaultValue={defaultLevel}>
          <option value="all">전체</option>
          {SCHOOL_LEVELS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input type="checkbox" name="noStudentData" value="yes" required /> 이 파일에 학생 개인정보(이름·번호·연락처·성적
        등)가 들어 있지 않음을 확인했습니다.
      </label>
      {clientError && <p className="error">{clientError}</p>}
      {!clientError && state.error && <p className="error">{state.error}</p>}
      <button type="submit" disabled={pending}>
        {pending ? "업로드 중…" : "업로드"}
      </button>
    </form>
  );
}
