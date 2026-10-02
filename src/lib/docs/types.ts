// 사람이 읽는 문서(/docs/<slug>)와 AI(LLM)가 읽는 원문(/docs/<slug>.md)의 한 페이지.
// 본문은 마크다운 하나로 쓰고, 사람용 화면은 src/lib/docs/markdown.ts로 그리고, AI용 원문은 그대로 내려 준다.

export interface DocPage {
  /** 주소 이름: /docs/<slug>, /docs/<slug>.md */
  slug: string;
  title: string;
  /** 목록과 AI용 문서 목록(/docs/index.md)에 쓰는 한 줄 요약 */
  summary: string;
  audience: "human";
  /**
   * 본문 마크다운(제목 # 줄 없이 ## 부터). hub는 normalizeHubOrigin을 거친 허브 주소,
   * cli는 cliPrefix(hub, readCliVersion())의 실행 접두어. 모든 링크는 절대 주소로 쓴다.
   */
  body(hub: string, cli: string): string;
}
