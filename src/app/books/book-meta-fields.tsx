"use client";

import { useState } from "react";
import { PiiInput, PiiTextarea } from "@/components/pii-guard";
import { SCHOOL_LEVELS } from "@/lib/constants";

// 책 등록·수정 폼의 공통 입력 칸(F-43 ~ F-45).
// 자유 입력 칸은 PiiInput/PiiTextarea로 실시간 경고하고(F-13), 서버가 저장 전에 한 번 더 가린다(F-14).
// 저작권 게이트(F-45): "제3자 저작물 포함"에 체크하면 공개 범위를 교사 전용으로 고정한다. 서버도 같은 규칙을 강제한다.

export type BookMetaDefaults = {
  title: string;
  summary: string;
  authorName: string;
  schoolLevel: string;
  license: string;
  visibility: "public" | "teachers";
  thirdParty: boolean;
  /** 표지 이미지 주소. 빈 문자열이면 표지 없음 */
  coverUrl: string;
};

export function BookMetaFields({
  defaults,
  licenses,
  copyrightWarning,
  titleRequired = true,
  titleHelp,
  coverHelp,
  onThirdPartyChange,
}: {
  defaults: BookMetaDefaults;
  licenses: readonly string[];
  copyrightWarning: string;
  titleRequired?: boolean;
  titleHelp?: string;
  coverHelp?: string;
  onThirdPartyChange?: (value: boolean) => void;
}) {
  const [thirdParty, setThirdParty] = useState(defaults.thirdParty);
  const [visibility, setVisibility] = useState<"public" | "teachers">(
    defaults.thirdParty ? "teachers" : defaults.visibility,
  );
  const effective = thirdParty ? "teachers" : visibility;

  return (
    <>
      <PiiInput name="title" label="책 제목" required={titleRequired} maxLength={100} defaultValue={defaults.title} />
      {titleHelp && (
        <p className="muted" style={{ margin: "-8px 0 0" }}>
          {titleHelp}
        </p>
      )}
      <PiiTextarea
        name="summary"
        label="소개 (선택)"
        rows={3}
        maxLength={1000}
        defaultValue={defaults.summary}
        placeholder="어떤 수업에 쓰는 책인지, 대상 학년과 읽는 방법을 적으십시오."
      />
      <PiiInput name="authorName" label="저자" maxLength={60} defaultValue={defaults.authorName} />

      <label className="field">
        <span>표지 이미지 주소 (선택)</span>
        <input
          type="url"
          name="coverUrl"
          maxLength={500}
          inputMode="url"
          defaultValue={defaults.coverUrl}
          placeholder="https://example.com/cover.png"
        />
      </label>
      <p className="muted" style={{ margin: "-8px 0 0" }}>
        {coverHelp ??
          "https로 시작하는 이미지 주소나 이 허브에 올린 사이트의 이미지 주소를 넣으면 서가에 표지로 보입니다. 비워 두면 제목으로 만든 표지를 보여 줍니다."}
      </p>

      <label className="field">
        <span>이용 조건(라이선스)</span>
        <select name="license" required defaultValue={defaults.license}>
          <option value="" disabled>
            선택하십시오
          </option>
          {licenses.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>학교급</span>
        <select name="schoolLevel" defaultValue={defaults.schoolLevel}>
          <option value="all">전체</option>
          {SCHOOL_LEVELS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </label>

      <fieldset>
        <legend>저작권 확인 (저작권법 제25조)</legend>
        <label>
          <input
            type="checkbox"
            name="thirdParty"
            value="yes"
            checked={thirdParty}
            onChange={(e) => {
              setThirdParty(e.target.checked);
              onThirdPartyChange?.(e.target.checked);
            }}
          />{" "}
          이 책에 다른 사람의 저작물(교과서·문제집·기사·사진 등)이 들어 있습니다.
        </label>
        {thirdParty ? (
          <p className="notice">
            {copyrightWarning} 공개 범위는 교사 전용으로 고정되고, 책 화면에 이 경고 문구가 표시됩니다.
          </p>
        ) : (
          <p className="muted" style={{ margin: "4px 0 0" }}>
            직접 쓴 내용이나 이용 허락을 받은 자료만 있으면 체크하지 않습니다.
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend>공개 범위</legend>
        <label style={{ marginRight: 12 }}>
          <input
            type="radio"
            name="visibility"
            value="public"
            checked={effective === "public"}
            disabled={thirdParty}
            onChange={() => setVisibility("public")}
          />{" "}
          공개 (로그인 없이 누구나 읽기)
        </label>
        <label>
          <input
            type="radio"
            name="visibility"
            value="teachers"
            checked={effective === "teachers"}
            onChange={() => setVisibility("teachers")}
          />{" "}
          교사 전용
        </label>
      </fieldset>
    </>
  );
}
