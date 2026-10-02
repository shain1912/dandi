"use client";

import { useActionState } from "react";
import { submitWithoutReset } from "@/components/submit-without-reset";
import { refreshTocAction, updateBookAction, type BookNoticeState } from "../../actions";
import { BookMetaFields, type BookMetaDefaults } from "../../book-meta-fields";

export function EditBookForm({
  id,
  defaults,
  licenses,
  copyrightWarning,
}: {
  id: string;
  defaults: BookMetaDefaults;
  licenses: readonly string[];
  copyrightWarning: string;
}) {
  const [state, action, pending] = useActionState<BookNoticeState, FormData>(updateBookAction, {});
  return (
    <form action={action} onSubmit={(e) => submitWithoutReset(e, action)} className="stack">
      <input type="hidden" name="id" value={id} />
      <BookMetaFields defaults={defaults} licenses={licenses} copyrightWarning={copyrightWarning} />
      {state.error && <p className="error">{state.error}</p>}
      {state.notice && <p className="notice">{state.notice}</p>}
      <p style={{ margin: 0 }}>
        <button type="submit" disabled={pending}>
          {pending ? "저장 중…" : "저장"}
        </button>
      </p>
    </form>
  );
}

/** 웹북 목차 다시 가져오기(F-43). 사이트를 고친 뒤 허브 목차를 최신으로 맞춘다. */
export function RefreshTocButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState<BookNoticeState, FormData>(refreshTocAction, {});
  return (
    <form action={action} onSubmit={(e) => submitWithoutReset(e, action, { checkPII: false })}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={pending}>
        {pending ? "목차를 가져오는 중…" : "목차 다시 가져오기"}
      </button>
      {state.error && <p className="error">{state.error}</p>}
      {state.notice && <p className="notice">{state.notice}</p>}
    </form>
  );
}
