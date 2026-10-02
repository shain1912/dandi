"use client";

import { useEffect, useRef, useState } from "react";
import { Document, Outline, Page, pdfjs } from "react-pdf";

// PDF 리더(F-44). react-pdf 11(pdf.js 6). 쪽 이동, 확대·축소, PDF 목차(outline), 이어 읽기(마지막 쪽을 localStorage에 기억).
// 서버 렌더링에서 빼야 하므로 반드시 next/dynamic(ssr: false)으로 불러온다(src/app/books/[id]/pdf-reader-loader.tsx).
//
// 워커·CMap·표준 글꼴은 scripts/copy-cmaps.mjs가 public/으로 복사한 정적 파일을 쓴다(번들러 설정과 무관).
// react-pdf 문서대로 워커 경로는 컴포넌트를 쓰는 이 모듈에서 지정한다.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";

// options는 컴포넌트 밖에 두어 렌더링마다 문서를 다시 불러오지 않게 한다.
// /api/files/[id]/view는 Range 요청(206)을 지원한다. 스트리밍과 미리 받기를 끄면 pdf.js가 지금 그릴 쪽에 필요한
// 부분만 나눠 받는다(50MB 교재도 전부 받기 전에 첫 쪽이 뜨고, 학교망에서 읽지 않는 부분을 받지 않는다).
// 파일이 작으면(128KB 이하) pdf.js가 알아서 한 번에 받는다.
const OPTIONS = {
  cMapUrl: "/cmaps/",
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  disableStream: true,
  disableAutoFetch: true,
};

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const FIT_INDEX = 2; // 1 = 화면 폭에 맞춤
const MAX_PAGE_WIDTH = 1100;

function storageKey(bookId: string): string {
  return `dandi.book.${bookId}.page`;
}

function readSavedPage(bookId: string): number | null {
  try {
    const n = Number(window.localStorage.getItem(storageKey(bookId)));
    return Number.isInteger(n) && n >= 1 ? n : null;
  } catch {
    return null;
  }
}

export default function PdfReader({ bookId, fileUrl }: { bookId: string; fileUrl: string }) {
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [zoomIndex, setZoomIndex] = useState(FIT_INDEX);
  const [width, setWidth] = useState(0);
  const [hasOutline, setHasOutline] = useState<boolean | null>(null);
  const [resumed, setResumed] = useState<number | null>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  // 페이지 폭을 리더 영역 폭에 맞춘다. 세로 스크롤 막대 자리만큼 빼서 폭이 흔들리지 않게 한다.
  useEffect(() => {
    const el = measureRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0);
      setWidth(Math.max(200, Math.min(MAX_PAGE_WIDTH, w - 24)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 이어 읽기: 문서를 연 뒤 쪽이 바뀔 때마다 기억한다.
  useEffect(() => {
    if (numPages === 0) return;
    try {
      window.localStorage.setItem(storageKey(bookId), String(page));
    } catch {
      // 저장할 수 없으면 기억하지 않는다.
    }
  }, [bookId, page, numPages]);

  function goTo(n: number, total = numPages) {
    if (!total || !Number.isFinite(n)) return;
    const p = Math.min(Math.max(1, Math.round(n)), total);
    setPage(p);
    setPageInput(String(p));
  }

  function onLoadSuccess(pdf: { numPages: number }) {
    setNumPages(pdf.numPages);
    const saved = readSavedPage(bookId);
    if (saved && saved > 1 && saved <= pdf.numPages) {
      setResumed(saved);
      goTo(saved, pdf.numPages);
    } else {
      goTo(1, pdf.numPages);
    }
  }

  const zoom = ZOOMS[zoomIndex];
  const ready = numPages > 0;

  return (
    <div ref={measureRef}>
      <div className="filter" role="toolbar" aria-label="PDF 리더 도구">
        <button type="button" onClick={() => goTo(page - 1)} disabled={!ready || page <= 1}>
          이전 쪽
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            goTo(Number(pageInput));
          }}
          style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
        >
          <label>
            <span className="muted">쪽 </span>
            <input
              type="number"
              min={1}
              max={numPages || 1}
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              disabled={!ready}
              style={{ width: "5em" }}
              aria-label="이동할 쪽 번호"
            />
          </label>
          <span className="muted">/ {numPages || "?"}</span>
          <button type="submit" disabled={!ready}>
            이동
          </button>
        </form>
        <button type="button" onClick={() => goTo(page + 1)} disabled={!ready || page >= numPages}>
          다음 쪽
        </button>
        <button type="button" onClick={() => setZoomIndex((i) => Math.max(0, i - 1))} disabled={zoomIndex === 0}>
          축소
        </button>
        <span className="muted" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoomIndex((i) => Math.min(ZOOMS.length - 1, i + 1))}
          disabled={zoomIndex === ZOOMS.length - 1}
        >
          확대
        </button>
        <button type="button" onClick={() => setZoomIndex(FIT_INDEX)} disabled={zoomIndex === FIT_INDEX}>
          폭 맞춤
        </button>
      </div>

      {resumed && (
        <p className="muted">
          이 브라우저에서 마지막으로 본 {resumed}쪽부터 이어서 보여 줍니다.{" "}
          <button type="button" onClick={() => goTo(1)}>
            처음부터 보기
          </button>
        </p>
      )}

      <Document
        file={fileUrl}
        options={OPTIONS}
        suspense={false}
        onLoadSuccess={onLoadSuccess}
        onItemClick={({ pageNumber }) => goTo(pageNumber)}
        loading={<p className="muted">PDF를 불러오는 중입니다.</p>}
        error={<p className="error">PDF를 열지 못했습니다. 원본 열기로 확인하거나 잠시 후 다시 시도하십시오.</p>}
        noData={<p className="muted">열 PDF가 없습니다.</p>}
      >
        <details style={{ margin: "0 0 8px" }}>
          <summary>PDF 목차</summary>
          {hasOutline === false && <p className="muted">이 PDF에는 목차 정보가 없습니다.</p>}
          <Outline onLoadSuccess={(outline) => setHasOutline(!!outline && outline.length > 0)} />
        </details>
        <div
          style={{
            overflow: "auto",
            maxHeight: "80vh",
            border: "1px solid var(--line)",
            borderRadius: 4,
          }}
        >
          <Page
            pageNumber={page}
            width={width || undefined}
            scale={zoom}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            loading={<p className="muted">쪽을 그리는 중입니다.</p>}
            error={<p className="error">이 쪽을 그리지 못했습니다.</p>}
          />
        </div>
      </Document>
    </div>
  );
}
