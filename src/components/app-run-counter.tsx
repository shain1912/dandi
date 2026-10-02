"use client";

import { startTransition, useEffect, useRef } from "react";
import { recordAppRun } from "@/app/apps/actions";

// 미니앱 실행 화면이 한 번 열릴 때마다 실행 수를 1 올린다(F-05).
// 개발 모드의 StrictMode 이중 실행에도 한 번만 집계되도록 ref로 막는다.
export function AppRunCounter({ appId }: { appId: string }) {
  const counted = useRef<string | null>(null);
  useEffect(() => {
    if (counted.current === appId) return;
    counted.current = appId;
    startTransition(async () => {
      try {
        await recordAppRun(appId);
      } catch {
        // 집계 실패는 앱 실행을 막지 않는다.
      }
    });
  }, [appId]);
  return null;
}
