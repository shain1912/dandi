"use client";

import { useActionState, useTransition } from "react";
import { blockSubmitIfPII, PiiInput, PiiTextarea } from "@/components/pii-guard";
import { APP_CATEGORIES, SCHOOL_LEVELS } from "@/lib/constants";
import type { SchoolLevel } from "@/lib/types";
import { createTemplateAction, type TemplateFormState } from "../actions";

const WORK_ORDER_SKELETON = `# 작업 지시서: (앱 이름)

## 1. 목표
- 이 앱으로 해결할 문제를 한두 문장으로 적습니다.

## 2. 사용자
- 누가, 어떤 상황에서 쓰는지 적습니다. (예: 담임교사가 조회 시간에 사용)

## 3. 화면 구성
- 화면 1: ...
- 화면 2: ...

## 4. 기능 목록
1. ...
2. ...

## 5. 데이터와 개인정보
- 학생 이름·연락처 등 개인정보를 입력받거나 저장하지 않는다.
- 데이터는 (저장하지 않음 / 브라우저에만 저장) 한다.
- 외부 서버나 해외 AI API로 입력 내용을 보내지 않는다.

## 6. 디자인
- 프로젝트 루트의 DESIGN.md를 따른다.

## 7. 배포
- Vercel에 배포한 뒤 \`dandi publish\`로 허브에 등록한다.

## 8. 완료 기준
- [ ] 휴대전화 화면에서도 모든 기능을 쓸 수 있다.
- [ ] 개인정보 셀프점검 5개 항목을 확인했다.
`;

export function TemplateForm({ defaultLevel }: { defaultLevel: SchoolLevel | null }) {
  const [state, action, pending] = useActionState<TemplateFormState, FormData>(createTemplateAction, {});
  const [, startTransition] = useTransition();

  // 직접 호출한다(preventDefault). 검증 오류가 나도 긴 작업 지시서 입력이 초기화되지 않게 하기 위해서다.
  // action 속성은 JS가 없거나 하이드레이션 전 제출(POST)용으로 남긴다.
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    blockSubmitIfPII(e);
    if (e.defaultPrevented) return;
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    startTransition(() => action(formData));
  }

  return (
    <form action={action} className="stack" onSubmit={handleSubmit}>
      <PiiInput name="title" label="템플릿 이름" required maxLength={80} placeholder="예: 급식 메뉴 알림판" />
      <PiiInput
        name="summary"
        label="한 줄 소개"
        required
        maxLength={300}
        placeholder="예: 이번 주 급식 메뉴를 학급 화면에 띄우는 업무 앱"
      />
      <label className="field">
        <span>분류</span>
        <select name="category" defaultValue="work">
          {APP_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>학교급 (하나 이상)</legend>
        {SCHOOL_LEVELS.map((l) => (
          <label key={l.id}>
            <input
              type="checkbox"
              name="schoolLevels"
              value={l.id}
              defaultChecked={defaultLevel ? defaultLevel === l.id : false}
            />{" "}
            {l.label}{" "}
          </label>
        ))}
      </fieldset>
      <PiiInput
        name="exampleUrl"
        label="예시 사이트 주소"
        inputMode="url"
        required
        maxLength={500}
        placeholder="https://내-앱.vercel.app 또는 /examples/quiz.html"
      />
      <p className="muted">
        배포한 내 앱 주소(http 또는 https)를 적으십시오. 허브에 포함된 예시를 쓰려면 /examples/파일이름.html 형식으로
        적습니다.
      </p>
      <PiiTextarea
        name="workOrder"
        label="작업 지시서 (마크다운)"
        required
        rows={20}
        maxLength={20000}
        defaultValue={WORK_ORDER_SKELETON}
      />
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "등록 중…" : "템플릿 등록"}
      </button>
    </form>
  );
}
