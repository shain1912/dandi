"use client";

import { startTransition, useActionState, useState } from "react";
import { blockSubmitIfPII } from "@/components/pii-guard";
import { UPLOAD_MAX_BYTES } from "@/lib/constants";
import { hasPII } from "@/lib/pii";
import { createPdfBookAction, type BookFormState } from "../actions";
import { BookMetaFields } from "../book-meta-fields";

// PDF 책 등록(F-44): 자료실(F-08)에 올린 PDF를 고르거나, 새 PDF를 올린다(새 파일은 자료실에도 등록된다).

export type PdfFileOption = { id: string; label: string };

/** 보내기 전 확인. 최종 검사는 서버가 한다(확장자·크기·PDF 머리말). */
function precheck(file: File | undefined): string | null {
  if (!file || file.size === 0) return "올릴 PDF 파일을 선택하십시오.";
  if (!/\.pdf$/i.test(file.name)) return "PDF 파일(.pdf)만 올릴 수 있습니다.";
  if (file.size > UPLOAD_MAX_BYTES) {
    return `파일이 너무 큽니다. 최대 ${UPLOAD_MAX_BYTES / (1024 * 1024)}MB까지 올릴 수 있습니다.`;
  }
  // F-13: 파일 이름은 자료실 목록과 다운로드 이름으로 공개되므로 개인정보가 보이면 막는다(서버도 가린다).
  if (hasPII(file.name)) return "파일 이름에 개인정보로 보이는 내용이 있습니다. 이름을 바꾼 뒤 올리십시오.";
  return null;
}

export function PdfBookForm({
  files,
  preselectFileId,
  licenses,
  copyrightWarning,
  defaultAuthor,
  defaultLevel,
}: {
  files: PdfFileOption[];
  preselectFileId: string | null;
  licenses: readonly string[];
  copyrightWarning: string;
  defaultAuthor: string;
  defaultLevel: string;
}) {
  const [state, action, pending] = useActionState<BookFormState, FormData>(createPdfBookAction, {});
  const [source, setSource] = useState<"existing" | "upload">(files.length > 0 ? "existing" : "upload");
  const [thirdParty, setThirdParty] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    // F-13: 제목·소개·저자에 개인정보가 있으면 제출을 막는다.
    blockSubmitIfPII(e);
    if (e.defaultPrevented) {
      setClientError("개인정보로 보이는 내용을 지우거나 바꾼 뒤 등록하십시오.");
      return;
    }
    let err: string | null = null;
    if (source === "upload") {
      const input = e.currentTarget.elements.namedItem("file");
      err = precheck(input instanceof HTMLInputElement ? input.files?.[0] : undefined);
    }
    setClientError(err);
    // 직접 보낸다. action 속성으로 보내면 끝난 뒤 폼이 초기화되어 고른 파일과 체크가 지워진다.
    e.preventDefault();
    if (err) return;
    const formData = new FormData(e.currentTarget);
    startTransition(() => action(formData));
  }

  return (
    <form action={action} onSubmit={onSubmit} className="stack">
      <fieldset>
        <legend>PDF 가져올 곳</legend>
        <label style={{ marginRight: 12 }}>
          <input
            type="radio"
            name="source"
            value="existing"
            checked={source === "existing"}
            disabled={files.length === 0}
            onChange={() => setSource("existing")}
          />{" "}
          자료실에 올린 PDF
        </label>
        <label>
          <input type="radio" name="source" value="upload" checked={source === "upload"} onChange={() => setSource("upload")} />{" "}
          새 PDF 올리기
        </label>
        {files.length === 0 && (
          <p className="muted" style={{ margin: "4px 0 0" }}>
            자료실에 직접 올린 PDF가 없습니다. 새 PDF를 올리십시오.
          </p>
        )}
      </fieldset>

      {source === "existing" ? (
        <label className="field">
          <span>자료실 PDF</span>
          <select name="fileId" required defaultValue={preselectFileId ?? files[0]?.id ?? ""}>
            {files.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <label className="field">
            <span>PDF 파일</span>
            <input
              type="file"
              name="file"
              required
              accept=".pdf,application/pdf"
              onChange={(e) => setClientError(precheck(e.target.files?.[0]))}
            />
          </label>
          <p className="notice">
            새로 올린 PDF는 자료실에도 등록되어 로그인하지 않은 방문자도 내려받을 수 있습니다.
            {thirdParty && " 제3자 저작물이 들어 있으면 수업에 필요한 부분만 담은 파일을 올리십시오."}
          </p>
          <label>
            <input type="checkbox" name="noStudentData" value="yes" required /> 이 파일에 학생 개인정보(이름·번호·연락처·성적
            등)가 들어 있지 않음을 확인했습니다.
          </label>
        </>
      )}

      <BookMetaFields
        defaults={{
          title: "",
          summary: "",
          authorName: defaultAuthor,
          schoolLevel: defaultLevel,
          license: "",
          visibility: "public",
          thirdParty: false,
          coverUrl: "",
        }}
        licenses={licenses}
        copyrightWarning={copyrightWarning}
        titleRequired={false}
        titleHelp="비워 두면 자료실 자료 제목(새 파일은 파일 이름)을 씁니다."
        onThirdPartyChange={setThirdParty}
      />

      {clientError && <p className="error">{clientError}</p>}
      {!clientError && state.error && <p className="error">{state.error}</p>}
      <p style={{ margin: 0 }}>
        <button type="submit" disabled={pending}>
          {pending ? "등록 중…" : "서가에 등록"}
        </button>
      </p>
    </form>
  );
}
