import { APPROVAL_RULE, connectPrompt, connectPromptWithAnswers, isLocalHub, PRIVACY_QUESTIONS } from "../../runbook.ts";
import type { DocPage } from "../types.ts";
import { code, docLink, fence, versionFromCli } from "../shared.ts";

export const doc: DocPage = {
  slug: "ai-publish",
  title: "AI에게 URL 하나 주고 사이트 올리기",
  summary:
    "AI 코딩 도구에 허브 주소 하나를 주면 AI가 로그인 확인, 업로드, 비공개 미리보기, 셀프점검, 허브 등록까지 진행합니다.",
  audience: "human",
  body: (hub, cli) => {
    const version = versionFromCli(cli);
    const prompt = connectPrompt(hub, version);
    const local = isLocalHub(hub);
    const addressNote = local
      ? `이 허브는 로컬·내부망(http) 주소라 AI 도구의 웹 읽기 기능이 열지 못합니다. 그래서 링크 대신 안내 명령(${code("guide")})을 실행하게 하는 문장입니다. 허브를 공개 HTTPS 주소로 운영하면 허브의 llms.txt 주소 하나를 주는 문장으로 바뀝니다.`
      : `핵심은 ${hub}/llms.txt 주소 하나입니다. AI는 이 런북을 읽고 필요한 명령을 스스로 실행합니다. AI가 요약본만 읽은 것 같으면 ${code(`${cli} guide`)} 를 실행하게 하십시오.`;
    return `Claude Code, Codex, Cursor, Antigravity, Grok처럼 터미널 명령을 실행하는 AI 코딩 도구에서 쓰는 방법입니다. 사이트 폴더를 AI 도구로 열고 시작하십시오. 터미널이 없는 채팅형 AI는 ${docLink(hub, "mcp", "AI 도구 연결(MCP)")}이나 ${docLink(hub, "web-upload", "웹에서 폴더 올리기")}를 쓰십시오.

## 한눈에 보기

1. AI에게 주소 하나를 줍니다.
2. 로그인이 필요하면 브라우저에서 코드를 확인하고 승인합니다.
3. AI가 바로 올리고 비공개 미리보기 주소를 보여 줍니다.
4. 셀프점검 5문항에 답합니다. 첫 요청에 답을 적어 보냈다면 다시 묻지 않습니다.
5. 허브에 등록되고 앱 주소가 나옵니다.

## 1. AI에게 주소 주기

아래 문장을 그대로 붙여 넣으십시오.

${fence(prompt)}

${addressNote}

## 2. 로그인 확인과 승인

AI는 먼저 로그인 상태를 확인합니다. 이미 로그인되어 있으면 이 단계를 건너뜁니다.

- 로그인이 필요하면 AI가 승인 링크와 8자리 코드(예: ${code("WDJB-MJHT")})를 보여 줍니다.
- 링크를 열고, 화면의 코드가 AI 대화창의 코드와 같을 때만 [승인]을 누르십시오. 그 브라우저에 교사 로그인이 되어 있어야 합니다.
- 직접 AI에게 시킨 로그인이 아니면 [거부]를 누르십시오. 웹사이트나 다른 사람이 보낸 링크와 코드는 승인하지 마십시오.
- 코드는 10분 동안 한 번만 쓸 수 있습니다. 시간이 지나면 AI가 새 링크를 띄웁니다.
- 토큰, 비밀번호, API 키를 대화창에 붙여 넣을 일은 없습니다.

## 3. 업로드와 비공개 미리보기

승인이 끝나면 AI가 사이트를 바로 올리고 미리보기 주소를 보여 줍니다.

- 미리보기는 링크를 아는 사람만 열 수 있고 검색에 나오지 않습니다. 아직 허브에 공개되지 않은 상태입니다.
- 빌드가 필요한 프로젝트는 AI가 먼저 빌드한 뒤 완성본 폴더(dist, build, out)를 올립니다.
- 개인정보로 보이는 값이나 올릴 수 없는 파일(hwp, docx 등)이 있으면 AI가 파일 이름을 알려 줍니다.
- API 키 같은 비밀값이 들어 있으면 업로드가 거부됩니다. ${docLink(hub, "privacy", "개인정보 셀프점검")}의 비밀값 안내를 보십시오.

## 4. 셀프점검 5문항

허브에 공개하기 전에 AI가 등록 정보(제목, 한 줄 설명, 학교급, 분류)와 아래 5문항을 한 번에 묻습니다. AI가 코드를 보고 답을 제안해도 선생님이 하나씩 확인해야 합니다.

${PRIVACY_QUESTIONS.map((q) => `- ${q.mark} ${q.question} (${q.answer})`).join("\n")}

첫 요청에 답을 함께 적으면 AI가 다시 묻지 않고 그 답으로 등록한 뒤, 등록에 쓴 답을 보여 줍니다. 아래 문장의 괄호를 모두 채워 보내십시오. AI는 빠진 답을 지어내지 않고 물어봅니다.

${fence(connectPromptWithAnswers(hub, version))}

## 5. 등록 완료

AI가 허브의 안내 문장과 앱 주소를 그대로 전합니다. 등록한 앱은 ${hub}/studio/apps 에서 확인합니다.

## 승인 대기 규칙

- ${APPROVAL_RULE}.
- 승인 대기인 앱은 허브 목록과 로그인 없는 실행에서 빠집니다. 학교 내부 승인을 받은 뒤 ${hub}/studio/apps 에서 승인 완료를 표시하면 공개됩니다.
- AI는 승인 완료를 대신 표시하지 않습니다.

## 사이트 고치기

같은 폴더에서 같은 문장을 다시 주면 됩니다.

- AI가 새 버전을 비공개 미리보기로 올리고, 지난번 답을 보여 주며 그대로 둘지 확인합니다.
- 다시 등록하기 전까지는 지금 공개된 버전이 그대로 보입니다.
- 승인받은 앱은 답이 같으면 승인이 유지되어 바로 새 버전으로 바뀝니다. 답이 바뀌면 새 버전이 다시 승인을 기다리고, 그동안 공개 주소는 이전 버전을 보여 주며 앱은 허브 목록에서 빠집니다.
- 폴더의 dandi.json에 사이트 정보(siteId)가 기록됩니다. 이 파일을 지우면 새 사이트로 올라가므로 지우지 마십시오.

## 서버나 DB가 필요한 앱

허브 호스팅은 정적 파일(HTML, CSS, JavaScript)만 제공합니다. 서버나 데이터베이스가 필요한 앱은 다른 곳(예: Vercel)에 배포한 뒤 주소만 등록합니다. AI에게 주소를 알려 주거나 ${code(`${cli} publish --url <주소>`)} 를 쓰거나 ${hub}/studio/apps/new 에서 등록하십시오.

## Codex, Antigravity, Grok에서

- 세 도구 모두 같은 문장과 같은 순서로 진행합니다.
- 도구가 Dandi 명령을 실행해도 되는지 물으면 허락하십시오. Codex는 샌드박스가 네트워크나 프로젝트 밖 쓰기(npx 임시 폴더, 로그인 정보)를 막을 수 있어 허락이 필요합니다.
- 한 번에 실행하는 방식(${code("codex exec")}, ${code("agy -p")}, ${code("grok -p")})은 중간에 대답할 수 없습니다. 먼저 터미널에서 ${code(`${cli} login`)} 으로 로그인해 두고, 괄호를 채운 답 문장을 보내십시오. 답이 빠지면 AI는 미리보기까지만 만들고 필요한 항목을 알려 줍니다.
- Grok은 신뢰한 폴더에서만 프로젝트 폴더에 설치한 스킬을 읽습니다. 처음 여는 폴더라면 ${code("/hooks-trust")} 를 실행하거나 ${code("grok -p")} 에 ${code("--trust")} 를 붙이십시오. 주소를 문장에 넣어 보내는 방식은 신뢰와 관계없이 동작합니다.
- 도구의 웹 읽기가 허브 주소를 열지 못하면 ${docLink(hub, "troubleshooting", "문제 해결")}을 보십시오.

## 스킬로 더 짧게

배포 스킬(dandi-deploy)을 설치해 두면 문장 없이 "Dandi에 올려 줘"라고만 해도 같은 순서를 따릅니다. ${docLink(hub, "skills", "스킬 설치와 게시")}를 보십시오.
`;
  },
};
