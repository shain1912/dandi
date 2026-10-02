// 사이트 파일 비밀값 검사 규칙(계약 2-2, QA R8). 서버 finalize(src/lib/sites.ts)와 웹 폴더 올리기(folder-upload.tsx)가
// 이 파일 하나를 함께 쓴다(브라우저에서도 돌아가도록 server-only를 두지 않는다). CLI(cli/lib.mjs SECRET_PATTERNS)도 같은
// 정규식을 써서 키가 허브로 올라가기 전에 잡는다. 규칙을 바꾸면 CLI 쪽도 함께 바꾼다.

/** 비밀값·개인정보를 검사하는 텍스트 파일 확장자 */
export const SITE_TEXT_EXT = ["html", "htm", "css", "js", "mjs", "json", "txt", "md", "svg", "xml", "csv"];

// dd_cli_/dd_sk_/dd_mat_ 토큰, Supabase service_role, PEM 개인 키.
export const SECRET_LITERAL_RE = /dd_(?:cli|sk|mat)_|service_role|-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/;
// sk-는 영숫자 20자 이상(계약)과, 하이픈·밑줄이 섞인 새 형식(sk-proj-…, sk-ant-…)을 함께 잡는다.
export const SK_CLASSIC_RE = /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}/;
// 새 형식은 CSS 클래스 이름(sk-folding-cube 등)과 구별하려고 대문자·소문자·숫자가 모두 있을 때만 인정한다.
export const SK_MODERN_RE = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g;

/** 비밀값 패턴이 있으면 true. 찾은 값은 돌려주지 않는다(응답·로그에 남기지 않으려고). */
export function hasSecret(text: string): boolean {
  if (SECRET_LITERAL_RE.test(text) || SK_CLASSIC_RE.test(text)) return true;
  // matchAll은 정규식을 복제하므로 전역 정규식의 lastIndex가 호출 사이에 남지 않는다.
  for (const m of text.matchAll(SK_MODERN_RE)) {
    const v = m[0];
    if (/[A-Z]/.test(v) && /[a-z]/.test(v.slice(3)) && /\d/.test(v)) return true;
  }
  return false;
}

function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** 비밀값을 검사하는 텍스트 파일인가(확장자 기준) */
export function isSiteTextPath(p: string): boolean {
  return SITE_TEXT_EXT.includes(extOf(p));
}

/** 오류 hint에 넣을 경로 목록(따옴표로 감싸고 너무 길면 줄인다). 서버 finalize와 같은 형식이다. */
export function listPathsHint(prefix: string, paths: string[], max = 10): string {
  const shown = paths
    .slice(0, max)
    .map((p) => JSON.stringify(p.length > 120 ? `${p.slice(0, 117)}...` : p))
    .join(", ");
  const more = paths.length > max ? ` 외 ${paths.length - max}개` : "";
  return `${prefix}${shown}${more}`;
}

export const SECRET_DETECTED_MESSAGE = "API 키·토큰 같은 비밀값으로 보이는 내용이 있어 올릴 수 없습니다.";

/**
 * 비밀값이 나왔을 때의 안내(QA R8). CLI·원격 MCP·웹 폴더 올리기·런북이 모두 같은 문장을 쓴다.
 * 허브 사이트는 정적 파일만 제공하므로 키를 둘 곳이 없다("서버 환경변수에 두라"는 안내는 쓰지 않는다).
 */
export function siteSecretGuidance(hub: string): string {
  const h = hub.replace(/\/+$/, "");
  return `Dandi 사이트 호스팅은 정적 파일만 제공하므로 키를 보관할 수 없습니다. AI 기능은 서버 프록시(${h}/downloads/ai-proxy-example.md)를 따로 배포해 publish --url로 등록하거나, AI 호출을 빼십시오. 키를 숨기거나 나눠서 검사를 피하지 마십시오.`;
}

/** secret_detected 오류의 hint 전체(경로 목록 + 공통 안내). 서버와 웹 사전 검사가 같은 문장을 만든다. */
export function secretDetectedHint(paths: string[], hub: string): string {
  return `${listPathsHint("비밀값을 지운 뒤 다시 올리십시오: ", paths)}. ${siteSecretGuidance(hub)}`;
}
