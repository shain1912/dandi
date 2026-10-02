import { permanentRedirect } from "next/navigation";

// 예전 따라하기 가이드(F-11)는 사용 문서(/docs)로 옮겼다. 308로 영구 이동한다.
// 브라우저는 #앵커를 그대로 가져가므로 /guide#step-6 같은 예전 링크는 /docs 목록의 같은 id로 이어진다
// (#connect는 "AI에게 줄 주소" 상자, #step-1~8·#downloads는 해당 문서 항목. src/lib/docs의 LEGACY_GUIDE_ANCHORS).
export default function GuidePage(): never {
  permanentRedirect("/docs");
}
