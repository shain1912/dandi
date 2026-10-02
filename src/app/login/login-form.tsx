"use client";

import { useActionState } from "react";
import { PiiInput } from "@/components/pii-guard";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { SCHOOL_LEVELS } from "@/lib/constants";
import { demoLogin, type LoginState } from "./actions";

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(demoLogin, {});
  return (
    <form action={action} onSubmit={(e) => submitWithoutReset(e, action)} className="stack">
      {next && <input type="hidden" name="next" value={next} />}
      <PiiInput name="name" label="이름" required maxLength={30} placeholder="예: 김교사" />
      <label className="field">
        <span>학교급</span>
        <select name="schoolLevel" defaultValue="middle">
          {SCHOOL_LEVELS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>역할</legend>
        <label>
          <input type="radio" name="role" value="teacher" defaultChecked /> 교사
        </label>{" "}
        <label>
          <input type="radio" name="role" value="admin" /> 교육청 관리자(데모)
        </label>
      </fieldset>
      {state.error && <p className="error">{state.error}</p>}
      <button type="submit" disabled={pending}>
        {pending ? "로그인 중…" : "데모 로그인"}
      </button>
    </form>
  );
}
