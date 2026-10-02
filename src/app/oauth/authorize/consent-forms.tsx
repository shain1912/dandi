"use client";

import { useSyncExternalStore } from "react";

// 동의 화면의 [허용]/[거부] 버튼. 다른 사이트가 이 화면을 보이지 않는 틀(iframe)에 넣고 클릭을 유도하지 못하도록,
// 틀 안에서 열리면 버튼 대신 안내를 보여 준다. 서버 렌더링 결과에는 버튼이 있어 JavaScript 없이도 동작한다.

function subscribe(): () => void {
  return () => {};
}

function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

function HiddenFields({ fields }: { fields: [string, string][] }) {
  return (
    <>
      {fields.map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

export function ConsentForms({
  fields,
  approve,
  deny,
}: {
  fields: [string, string][];
  approve: (formData: FormData) => Promise<void>;
  deny: (formData: FormData) => Promise<void>;
}) {
  const framed = useSyncExternalStore(subscribe, isFramed, () => false);
  if (framed) {
    return (
      <p className="error" role="alert">
        다른 사이트 안에 끼워 넣은 화면에서는 연결을 승인할 수 없습니다. 이 주소를 브라우저 새 창에서 직접 여십시오.
      </p>
    );
  }
  return (
    <div className="filter">
      <form action={approve}>
        <HiddenFields fields={fields} />
        <button type="submit">허용</button>
      </form>
      <form action={deny}>
        <HiddenFields fields={fields} />
        <button>거부</button>
      </form>
    </div>
  );
}
