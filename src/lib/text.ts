import { scanPII } from "./pii";

// 입력 텍스트 공통 처리. 서버 쪽 도메인 함수가 길이 검사와 저장 전에 사용한다.

/**
 * 브라우저는 textarea 값을 CRLF로 보내지만 maxLength는 줄바꿈을 한 글자로 센다.
 * 서버 길이 검사를 브라우저와 맞추기 위해 먼저 LF로 통일한다.
 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

// 구글 캘린더 공개 임베드 주소의 그룹 캘린더 id(…@group.calendar.google.com)는 개인 이메일이 아니다.
const PUBLIC_CALENDAR_ID = /@group\.(?:v\.)?calendar\.google\.com$/i;

function urlTextHasPII(text: string): boolean {
  return scanPII(text).some((m) => !(m.type === "email" && PUBLIC_CALENDAR_ID.test(m.value)));
}

/**
 * URL에 개인정보가 섞였는지 본다(인코딩된 쿼리 문자열 포함).
 * URL은 가리면 링크가 깨지므로 마스킹하지 않고 등록을 거절하는 데 사용한다(F-14).
 * 호출하는 쪽에서 길이 상한을 먼저 확인한다.
 */
export function urlHasPII(url: string): boolean {
  if (urlTextHasPII(url)) return true;
  try {
    return urlTextHasPII(decodeURIComponent(url));
  } catch {
    return false;
  }
}
