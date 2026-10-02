"use client";

import { useActionState } from "react";
import { PiiInput } from "@/components/pii-guard";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { reviewSkillAction, type SkillReviewState } from "./actions";

// 검토 대기 버전 하나의 승인·반려 폼. 반려 사유는 게시자에게 보이며 서버에서 개인정보를 한 번 더 가린다.
export function SkillReviewForm({ name, version }: { name: string; version: string }) {
  const [state, action, pending] = useActionState<SkillReviewState, FormData>(reviewSkillAction, {});
  if (state.message) {
    return (
      <p className="notice" role="status">
        {state.message}
      </p>
    );
  }
  return (
    <form action={action} onSubmit={(e) => submitWithoutReset(e, action)} className="stack">
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="version" value={version} />
      <PiiInput name="reason" label="검토 의견 (반려할 때 필수, 게시자에게 보입니다)" maxLength={300} />
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <div>
        <button type="submit" name="decision" value="approve" disabled={pending}>
          승인하고 공개
        </button>{" "}
        <button type="submit" name="decision" value="reject" className="button" disabled={pending}>
          반려
        </button>
      </div>
    </form>
  );
}
