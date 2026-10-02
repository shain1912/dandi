"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";

// 웹북 이어 읽기(F-43). 허브 목차에서 마지막으로 연 장을 이 브라우저의 localStorage에 기억한다.
// 본문(iframe)은 다른 출처라 그 안에서 이동한 위치는 읽을 수 없다. 그래서 "허브 목차 기준"의 근사치다.

type Saved = { href: string; title: string };

function storageKey(bookId: string): string {
  return `dandi.book.${bookId}.chapter`;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function parseSaved(raw: string | null): Saved | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Saved>;
    return typeof v.href === "string" && typeof v.title === "string" ? { href: v.href, title: v.title } : null;
  } catch {
    return null;
  }
}

export function ChapterMemory({
  bookId,
  current,
  hrefs,
  currentTitle,
}: {
  bookId: string;
  /** 주소에 ?ch=가 있으면 그 번호, 없으면 null */
  current: number | null;
  hrefs: string[];
  currentTitle: string;
}) {
  const currentHref = current !== null ? (hrefs[current] ?? null) : null;

  useEffect(() => {
    if (!currentHref) return;
    try {
      window.localStorage.setItem(storageKey(bookId), JSON.stringify({ href: currentHref, title: currentTitle }));
    } catch {
      // 사생활 보호 모드 등으로 저장할 수 없으면 기억하지 않는다.
    }
  }, [bookId, currentHref, currentTitle]);

  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return window.localStorage.getItem(storageKey(bookId));
      } catch {
        return null;
      }
    },
    () => null,
  );

  if (current !== null) return null;
  const saved = parseSaved(raw);
  const index = saved ? hrefs.indexOf(saved.href) : -1;
  if (!saved || index <= 0) return null;
  return (
    <p className="notice">
      이 브라우저에서 마지막으로 연 장: <Link href={`/books/${bookId}?ch=${index}`}>{saved.title}</Link> (이어 읽기)
    </p>
  );
}
