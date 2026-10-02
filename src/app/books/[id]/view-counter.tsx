"use client";

import { startTransition, useEffect, useRef } from "react";
import { recordBookView } from "../actions";

// 리더 화면이 브라우저에 뜰 때마다 열람 수를 1 올린다. 같은 화면에서 장을 옮기는 것은 다시 세지 않는다.
// 개발 모드의 StrictMode 이중 실행에도 한 번만 집계되도록 ref로 막는다.
export function BookViewCounter({ bookId }: { bookId: string }) {
  const counted = useRef<string | null>(null);
  useEffect(() => {
    if (counted.current === bookId) return;
    counted.current = bookId;
    startTransition(async () => {
      try {
        await recordBookView(bookId);
      } catch {
        // 집계 실패는 읽기를 막지 않는다.
      }
    });
  }, [bookId]);
  return null;
}
