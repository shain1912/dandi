"use client";

import { useState, useTransition } from "react";

// 원클릭 복사 버튼(F-10). navigator.clipboard가 막힌 환경(http, 오래된 브라우저)에서는 textarea 방식으로 대신 복사한다.
// onCopyAction에 서버 액션을 넘기면 복사에 성공한 뒤 호출한다(예: 복사 수 집계).

function fallbackCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 권한 거부 등: 아래 방식으로 다시 시도한다.
    }
  }
  return fallbackCopy(text);
}

type Status = "idle" | "copied" | "failed";

export function CopyButton({
  text,
  label = "복사",
  copiedMessage = "복사했습니다.",
  onCopyAction,
}: {
  text: string;
  label?: string;
  copiedMessage?: string;
  onCopyAction?: () => Promise<unknown>;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [, startTransition] = useTransition();

  async function handleClick() {
    const ok = await copyText(text);
    setStatus(ok ? "copied" : "failed");
    if (ok && onCopyAction) {
      startTransition(async () => {
        try {
          await onCopyAction();
        } catch {
          // 집계 실패는 복사 자체에 영향을 주지 않는다.
        }
      });
    }
  }

  return (
    <span>
      <button type="button" className="button primary" onClick={handleClick}>
        {label}
      </button>{" "}
      <span role="status" aria-live="polite" className={status === "failed" ? "error" : "muted"}>
        {status === "copied" && copiedMessage}
        {status === "failed" && "자동 복사가 막혀 있습니다. 본문을 직접 선택해 복사하십시오."}
      </span>
    </span>
  );
}
