import Link from "next/link";
import { PiiView } from "./pii-view";

// PRD 9장 "실시간 개인정보 필터링 검증 뷰". 로그인 없이 사용할 수 있다.
// 작성 폼의 1차 필터(F-13)와 서버 마스킹(F-14)이 쓰는 규칙(src/lib/pii.ts)을 그대로 보여 준다.

export default function StudioPiiPage() {
  return (
    <>
      <p className="muted">
        <Link href="/studio">스튜디오</Link> / 개인정보 검증
      </p>
      <h1>개인정보 필터링 검증</h1>
      <p className="muted">
        허브의 모든 입력창은 같은 규칙으로 개인정보를 검사합니다. 글을 올리기 전에 여기에 붙여 넣어 무엇이 감지되고
        어떻게 가려지는지 확인하십시오. 검사는 브라우저 안에서만 이루어집니다.
      </p>
      <PiiView />
    </>
  );
}
