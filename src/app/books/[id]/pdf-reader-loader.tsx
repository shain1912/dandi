"use client";

import dynamic from "next/dynamic";

// react-pdf(pdf.js)는 브라우저 API를 쓰므로 서버 렌더링에서 빼고 브라우저에서만 불러온다(F-44).
// next/dynamic의 ssr: false는 클라이언트 컴포넌트 안에서만 쓸 수 있어 이 파일을 따로 둔다.
const PdfReader = dynamic(() => import("@/components/pdf-reader"), {
  ssr: false,
  loading: () => <p className="muted">PDF 리더를 불러오는 중입니다.</p>,
});

export function PdfReaderLoader({ bookId, fileUrl }: { bookId: string; fileUrl: string }) {
  return <PdfReader bookId={bookId} fileUrl={fileUrl} />;
}
