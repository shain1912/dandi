"use client";

import { startTransition } from "react";
import { blockSubmitIfPII } from "./pii-guard";

/**
 * 서버 액션을 직접 보낸다. <form action={action} onSubmit={(e) => submitWithoutReset(e, action)}>
 *
 * React 19는 action 속성으로 보낸 폼을 끝난 뒤 form.reset()으로 초기화한다. 이때 select는 서버 렌더링 때
 * 선택된 값으로 돌아가고(제어 컴포넌트여도 마찬가지), 서버 검증 오류 뒤 다시 제출하면 사용자가 고른 값이
 * 조용히 바뀐다. 이 함수가 preventDefault로 React의 액션 실행과 초기화를 건너뛰고 같은 액션을 직접 보낸다.
 * action 속성은 그대로 둔다. 서버 렌더링 결과가 POST 폼이 되어, JS가 없거나 하이드레이션 전에 제출해도
 * 입력값이 URL(GET)에 실리지 않고 서버 액션으로 전달된다.
 * 기본으로 F-13 개인정보 차단(blockSubmitIfPII)을 먼저 적용한다.
 */
export function submitWithoutReset(
  e: React.FormEvent<HTMLFormElement>,
  action: (formData: FormData) => void,
  { checkPII = true }: { checkPII?: boolean } = {},
): void {
  if (checkPII) {
    blockSubmitIfPII(e);
    if (e.defaultPrevented) return;
  }
  e.preventDefault();
  const submitter = (e.nativeEvent as SubmitEvent).submitter;
  const formData = new FormData(e.currentTarget, submitter);
  startTransition(() => action(formData));
}
