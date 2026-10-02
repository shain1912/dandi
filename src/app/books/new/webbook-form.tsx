"use client";

import { useActionState } from "react";
import { submitWithoutReset } from "@/components/submit-without-reset";
import {
  createWebbookAction,
  previewWebbookAction,
  type BookFormState,
  type PreviewState,
} from "../actions";
import { BookMetaFields } from "../book-meta-fields";

// 웹북 등록(F-43): 1) 주소를 넣고 목차를 미리 가져온다 2) 확인한 뒤 책 정보를 채워 등록한다.
// 등록할 때 서버가 목차를 다시 가져와 저장한다(미리보기 결과를 브라우저에서 받지 않는다).

const SOURCE_LABEL = {
  search_index: "검색 색인(search/search_index.json)",
  sitemap: "사이트맵(sitemap.xml)",
  page: "첫 페이지",
} as const;

const PREVIEW_LIMIT = 120;

export function WebbookForm({
  licenses,
  copyrightWarning,
  defaultAuthor,
  defaultLevel,
}: {
  licenses: readonly string[];
  copyrightWarning: string;
  defaultAuthor: string;
  defaultLevel: string;
}) {
  const [pstate, previewAction, previewPending] = useActionState<PreviewState, FormData>(previewWebbookAction, {});
  const [cstate, createAction, createPending] = useActionState<BookFormState, FormData>(createWebbookAction, {});
  const preview = pstate.preview;

  return (
    <>
      <form
        action={previewAction}
        onSubmit={(e) => submitWithoutReset(e, previewAction, { checkPII: false })}
        className="stack"
      >
        <label className="field">
          <span>웹북 주소</span>
          <input
            type="url"
            name="url"
            required
            maxLength={500}
            inputMode="url"
            placeholder="https://shain1912.github.io/vibecoding-map-book/"
          />
        </label>
        <p className="muted" style={{ margin: 0 }}>
          GitHub Pages 같은 https 주소나 이 허브에 올린 사이트 주소를 입력하십시오. 서버가 sitemap.xml과
          search/search_index.json(mkdocs)을 읽어 목차를 만듭니다. 요청마다 5초, 2MB까지만 읽습니다.
        </p>
        {pstate.error && <p className="error">{pstate.error}</p>}
        <p style={{ margin: 0 }}>
          <button type="submit" disabled={previewPending}>
            {previewPending ? "목차를 가져오는 중…" : "목차 가져오기"}
          </button>
        </p>
      </form>

      {preview && (
        <section key={preview.baseUrl}>
          <h2>가져온 목차 확인</h2>
          <p className="muted">
            주소: {preview.baseUrl}
            <br />
            목차 {preview.toc.length}항목(페이지 {preview.pageCount}개) · 출처: {SOURCE_LABEL[preview.source]}
            {preview.lastmod && <> · 사이트 최종 수정 {preview.lastmod}</>}
          </p>
          {pstate.warnings?.map((w) => (
            <p key={w} className="notice">
              {w}
            </p>
          ))}
          <details open={preview.toc.length <= 40}>
            <summary>목차 보기</summary>
            <ul style={{ listStyle: "none", paddingLeft: 0 }}>
              {preview.toc.slice(0, PREVIEW_LIMIT).map((item) => (
                <li key={item.href} style={{ paddingLeft: item.depth * 16 }}>
                  {item.depth === 0 ? <strong>{item.title}</strong> : item.title}
                </li>
              ))}
            </ul>
            {preview.toc.length > PREVIEW_LIMIT && (
              <p className="muted">외 {preview.toc.length - PREVIEW_LIMIT}항목은 등록 후 리더에서 볼 수 있습니다.</p>
            )}
          </details>

          <h2>책 정보</h2>
          <form action={createAction} onSubmit={(e) => submitWithoutReset(e, createAction)} className="stack">
            <input type="hidden" name="url" value={preview.baseUrl} />
            <BookMetaFields
              defaults={{
                title: preview.title,
                summary: preview.summary,
                authorName: defaultAuthor,
                schoolLevel: defaultLevel,
                license: "",
                visibility: "public",
                thirdParty: false,
                coverUrl: preview.coverUrl ?? "",
              }}
              licenses={licenses}
              copyrightWarning={copyrightWarning}
              coverHelp={
                preview.coverUrl
                  ? "웹북 첫 페이지의 대표 이미지(og:image)를 표지로 넣었습니다. 다른 이미지를 쓰려면 주소를 바꾸고, 표지를 쓰지 않으려면 비우십시오."
                  : undefined
              }
            />
            {cstate.error && <p className="error">{cstate.error}</p>}
            <p style={{ margin: 0 }}>
              <button type="submit" disabled={createPending}>
                {createPending ? "등록 중…" : "서가에 등록"}
              </button>
            </p>
          </form>
        </section>
      )}
    </>
  );
}
