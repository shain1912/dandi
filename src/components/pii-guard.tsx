"use client";

import { useState } from "react";
import { scanPII, type PiiMatch } from "@/lib/pii";

// F-13 클라이언트 1차 필터. 입력 중 실시간 경고, 제출 시 개인정보가 있으면 차단한다.
// 서버 액션 쪽에서도 maskPII로 한 번 더 가리므로(F-14) 이 필터를 우회해도 원문은 저장되지 않는다.

function Warning({ matches }: { matches: PiiMatch[] }) {
  if (matches.length === 0) return null;
  const labels = [...new Set(matches.map((m) => m.label))].join(", ");
  return (
    <p className="pii-warning" role="alert">
      개인정보로 보이는 내용이 있습니다: {labels}. 지우거나 바꾼 뒤 등록하십시오.
    </p>
  );
}

type FieldProps = {
  name: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
  maxLength?: number;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  pattern?: string;
};

export function PiiInput(props: FieldProps) {
  const [value, setValue] = useState(props.defaultValue ?? "");
  const matches = scanPII(value);
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        name={props.name}
        value={value}
        required={props.required}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        inputMode={props.inputMode}
        pattern={props.pattern}
        onChange={(e) => setValue(e.target.value)}
        aria-invalid={matches.length > 0}
      />
      <Warning matches={matches} />
    </label>
  );
}

export function PiiTextarea(props: FieldProps & { rows?: number }) {
  const [value, setValue] = useState(props.defaultValue ?? "");
  const matches = scanPII(value);
  return (
    <label className="field">
      <span>{props.label}</span>
      <textarea
        name={props.name}
        value={value}
        required={props.required}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        rows={props.rows ?? 5}
        onChange={(e) => setValue(e.target.value)}
        aria-invalid={matches.length > 0}
      />
      <Warning matches={matches} />
    </label>
  );
}

/**
 * 제출 직전에 폼 안의 모든 텍스트 입력을 검사해 개인정보가 있으면 제출을 막는다.
 * <form onSubmit={blockSubmitIfPII}> 형태로 사용한다. 서버 액션 form에도 그대로 붙일 수 있다.
 */
export function blockSubmitIfPII(e: React.FormEvent<HTMLFormElement>): void {
  const fields = e.currentTarget.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input[type="text"], input:not([type]), textarea',
  );
  for (const f of fields) {
    if (scanPII(f.value).length > 0) {
      e.preventDefault();
      f.focus();
      return;
    }
  }
}
