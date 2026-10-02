"use client";

import { useEffect, useRef, useState } from "react";

// 서가 카드의 표지(F-43). 표지 이미지 주소가 없거나 이미지를 불러오지 못하면 제목으로 만든 글자 표지를 보여 준다.
// 표지는 장식이므로 대체 텍스트를 비우고(제목 링크가 바로 옆에 있다) 스크린 리더에서 숨긴다.
// 외부 이미지 서버에 허브 주소가 전해지지 않도록 referrerPolicy="no-referrer"로 불러온다.

const WIDTH = 72;
const HEIGHT = 100;

const boxStyle: React.CSSProperties = {
  width: WIDTH,
  height: HEIGHT,
  flex: `0 0 ${WIDTH}px`,
  border: "1px solid var(--line)",
  borderRadius: 4,
  overflow: "hidden",
};

export function BookCover({ src, title, label }: { src: string | null; title: string; label: string }) {
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // 하이드레이션 전에 이미 실패한 이미지는 onError가 오지 않을 수 있으므로 한 번 더 확인한다.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, [src]);

  if (src && !failed) {
    return (
      <div style={boxStyle} aria-hidden="true">
        {/* 교사가 등록한 외부 주소라 next/image(원격 도메인 허용 목록)를 쓰지 않는다. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={src}
          alt=""
          width={WIDTH}
          height={HEIGHT}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }}
        />
      </div>
    );
  }

  const text = title.trim().slice(0, 12);
  return (
    <div
      aria-hidden="true"
      style={{
        ...boxStyle,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 6,
        boxSizing: "border-box",
        fontSize: "0.75rem",
        lineHeight: 1.3,
        wordBreak: "keep-all",
        overflowWrap: "anywhere",
      }}
    >
      <span>{text}</span>
      <span className="muted">{label}</span>
    </div>
  );
}
