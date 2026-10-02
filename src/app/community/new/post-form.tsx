"use client";

import { useActionState, useState } from "react";
import { PiiInput, PiiTextarea } from "@/components/pii-guard";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { POST_CATEGORIES, SCHOOL_LEVELS } from "@/lib/constants";
import type { LevelOrAll, PostCategory } from "@/lib/types";
import { createPostAction, type FormState } from "../actions";

export function PostForm({
  defaultLevel,
  titleMax,
  bodyMax,
}: {
  defaultLevel: LevelOrAll;
  titleMax: number;
  bodyMax: number;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(createPostAction, {});
  const [category, setCategory] = useState<PostCategory>("free");
  const [level, setLevel] = useState<LevelOrAll>(defaultLevel);
  return (
    <form action={action} onSubmit={(e) => submitWithoutReset(e, action)} className="stack">
      <PiiInput name="title" label="제목" required maxLength={titleMax} />
      <label className="field">
        <span>분류</span>
        <select name="category" value={category} onChange={(e) => setCategory(e.target.value as PostCategory)}>
          {POST_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>학교급</span>
        <select name="schoolLevel" value={level} onChange={(e) => setLevel(e.target.value as LevelOrAll)}>
          <option value="all">전체</option>
          {SCHOOL_LEVELS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <PiiTextarea name="body" label="내용" required maxLength={bodyMax} rows={12} />
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "등록 중…" : "등록"}
      </button>
    </form>
  );
}
