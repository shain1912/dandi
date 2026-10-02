import { APPROVAL_RULE, PRIVACY_QUESTIONS, secretGuidance } from "../../runbook.ts";
import type { DocPage } from "../types.ts";
import { code, docLink } from "../shared.ts";

export const doc: DocPage = {
  slug: "privacy",
  title: "개인정보 셀프점검",
  summary: "허브에 공개하기 전에 답하는 셀프점검 5문항, 승인 대기 규칙, 비밀값(API 키) 안내를 정리합니다.",
  audience: "human",
  body: (hub) => `사이트나 미니앱을 허브에 공개하기 전에 아래 5문항에 답합니다. AI로 올리든, 웹에서 올리든, CLI로 올리든 같은 문항입니다. 교육청 가이드라인이 확정되기 전까지 쓰는 임시 기준이며, 확정되면 이 문서를 고칩니다.

## 5문항

허브 등록 화면의 문항과 같은 원문입니다.

${PRIVACY_QUESTIONS.map((q) => `- ${q.mark} ${q.question} (${q.answer})`).join("\n")}

- ②와 ③은 비울 수 없습니다. 저장하지 않으면 "저장 안 함"이라고 적습니다.
- AI가 코드를 보고 답을 제안해도 선생님이 하나씩 확인해야 합니다. AI는 답을 대신 정하지 않습니다.
- CLI로 올릴 때는 dandi.json의 ${code("privacyCheck")} 에 같은 5항목을 적습니다.

## 승인 대기 규칙

- ${APPROVAL_RULE}.
- ⑤가 "예"인 앱은 승인 대기로 등록되어 허브 목록과 로그인 없는 실행에서 빠집니다.
- 학교 내부 승인을 받은 뒤 ${hub}/studio/apps 에서 승인 완료를 표시하면 공개됩니다. AI는 승인 완료를 대신 표시하지 않습니다.
- 승인받은 앱을 같은 답으로 다시 올리면 승인이 유지됩니다. 답이 바뀌면 다시 승인을 기다리고, 그동안 공개 주소는 이전 버전을 보여 줍니다.

## 개인정보를 줄이는 설계

- 학생 이름 대신 좌석 번호나 가명을 쓰는 설계를 먼저 검토하십시오. 템플릿의 학급 출석 체크가 예시입니다.
- 예시 데이터, 파일 이름, 제목, 설명에 실제 학생 정보를 넣지 마십시오.
- 올릴 때 전화번호, 주민등록번호, 이메일, 카드번호로 보이는 값이 있으면 경고가 나옵니다. 올리는 것은 막지 않으므로 실제 정보라면 지운 뒤 다시 올리십시오.
- 문구에 개인정보가 섞였는지는 ${hub}/studio/pii 에 붙여 넣어 확인할 수 있습니다.
- 점검표 파일: ${hub}/downloads/privacy-checklist.md

## 비밀값(API 키·토큰)

사이트 파일에 API 키나 토큰으로 보이는 값이 있으면 업로드가 거부됩니다. 허브, CLI, AI 도구가 모두 같은 안내를 합니다.

> ${secretGuidance(hub)}

- 토큰, 비밀번호, API 키를 AI 대화창에 붙여 넣지 마십시오. 로그인은 브라우저에서만 합니다.
- 키가 노출되었다면 ${hub}/studio/projects 에서 그 키를 폐기하고 새로 발급하십시오.
- AI 기능을 안전하게 붙이는 방법은 ${docLink(hub, "projects", "프로젝트와 API 키")}에 있습니다.
`,
};
