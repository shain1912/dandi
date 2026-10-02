import { isLocalHub, isLoopbackHub, POWERSHELL_UTF8, secretGuidance, windowsCli } from "../../runbook.ts";
import type { DocPage } from "../types.ts";
import { code, docLink, fence } from "../shared.ts";

export const doc: DocPage = {
  slug: "troubleshooting",
  title: "문제 해결",
  summary: "Windows PowerShell, 로컬 허브 주소, 승인 코드, 업로드 거부처럼 자주 겪는 문제와 해결 방법입니다.",
  audience: "human",
  body: (hub, cli) => {
    const local = isLocalHub(hub);
    const approvalBrowser = local
      ? "이 허브는 이 컴퓨터나 학교 내부망에서 실행 중이어서 휴대전화로는 승인 링크를 열 수 없습니다. 승인 링크를 복사해 이 컴퓨터의 브라우저 주소창에 붙여 넣으십시오."
      : "학교망에서 브라우저가 열리지 않으면 승인 링크를 휴대전화로 열어 승인해도 됩니다.";
    const loopback = isLoopbackHub(hub)
      ? `\n## 미리보기 주소가 PowerShell에서 열리지 않음

${code("*.localhost")} 주소는 PowerShell의 Invoke-WebRequest가 찾지 못합니다. 브라우저로 열거나 ${code("curl.exe")} 를 쓰십시오. AI에게는 배포 결과를 그대로 믿게 하면 됩니다.
`
      : "";
    return `## PowerShell에서 npx가 실행되지 않음

"스크립트를 실행할 수 없으므로"가 나오면 실행 정책이 npx.ps1을 막은 것입니다. npx.cmd로 실행하십시오.

${fence(`${windowsCli(cli)} guide`)}

Git Bash에서는 npx.cmd를 쓰지 마십시오. ${code("'C:\\Program' is not recognized")} 같은 오류가 나며 인자가 깨집니다.

## PowerShell에서 한국어가 깨짐

${code("援먯궗")} 처럼 보이면 아래 명령을 먼저 실행한 뒤 다시 실행하십시오.

${fence(POWERSHELL_UTF8)}

dandi.json의 한글이 깨졌거나 manifest_encoding 오류가 나면 파일이 ANSI로 저장된 것입니다. ${code("Set-Content -Encoding UTF8")} 로 다시 저장하십시오. siteId가 들어 있으므로 파일을 지우지 마십시오.

## AI가 허브 링크를 읽지 못함

AI 도구의 웹 읽기 기능은 localhost, http, 내부망 주소를 열지 못하고, 공개 주소도 요약본만 읽을 때가 있습니다. 링크 대신 아래 명령을 실행하게 하면 런북 원문을 그대로 읽습니다.

${fence(`${cli} guide`)}

${local ? "이 허브는 로컬·내부망 주소이므로 " : "로컬·내부망 허브에서는 "}${docLink(hub, "ai-publish", "AI에게 URL 하나 주고 사이트 올리기")}의 문장이 자동으로 이 명령을 쓰는 형태가 됩니다.

## 승인 코드가 만료되었거나 거부됨

- 만료: 코드는 10분 동안 유효합니다. AI에게 다시 로그인하라고 하면 새 링크를 띄웁니다.
- 거부: 직접 요청한 로그인이 맞다면 AI에게 다시 시도하라고 하십시오. 모르는 요청이었다면 그대로 두십시오.
- 승인 화면이 열리지 않음: ${approvalBrowser}
- 승인하려면 그 브라우저에서 교사 로그인이 되어 있어야 합니다.

## site_not_found

폴더의 dandi.json에 기록된 사이트가 지금 로그인한 계정에 없다는 뜻입니다. 데모 로그인에서 이름을 조금 다르게 입력한 경우가 많습니다.

- 사이트를 올린 계정이 따로 있다면: AI에게 그 계정으로 다시 로그인하라고 하십시오(${code("login --force")}).
- 새 사이트로 올리려면: AI에게 새 사이트로 올려 달라고 하십시오(${code("deploy --new-site")}). 예전 사이트 정보는 previousSiteId로 남습니다.

## source_folder

package.json이 있고 빌드가 필요한 폴더를 그대로 올리면 빈 화면이 나오므로 거부됩니다. 빌드한 뒤 dist, build, out 폴더를 올리십시오. 그 폴더가 그대로 완성본이 맞다면 AI에게 그렇게 알려 주십시오(${code("--allow-source")}).

## secret_detected

${secretGuidance(hub)}

## 빠진 파일

hwp, docx, pptx, xlsx, zip 같은 파일은 사이트에 올릴 수 없어 빠집니다. 자료실(${hub}/files)에 올리거나 PDF로 바꾸어 연결하십시오.
${loopback}
## 내부망 허브에서 미리보기 주소가 열리지 않음

${code("<사이트>.192.168.0.5")} 같은 주소는 다른 컴퓨터에서 열리지 않습니다. 허브 관리자가 HUB_ORIGIN(교사가 여는 허브 주소)과 SITES_DOMAIN(허브를 가리키는 와일드카드 DNS 이름)을 설정해야 합니다.

## 로컬 MCP가 시작되지 않음

- 허브를 업데이트한 뒤라면 ${docLink(hub, "mcp", "AI 도구 연결(MCP)")}이나 ${hub}/connect 에서 로컬 MCP 줄을 다시 복사해 등록하고 AI 도구를 다시 시작하십시오.
- Node.js 18 이상이 필요합니다.
- Windows에서 도구가 npx를 찾지 못한다는 오류를 내면 등록한 명령의 npx를 npx.cmd로 바꿔 다시 등록해 보십시오.

## Node.js가 없음

Node.js LTS를 설치하십시오. 설치할 수 없다면 ${docLink(hub, "web-upload", "웹에서 폴더 올리기")}를 쓰십시오.

## 다른 허브에 로그인되어 있음

${fence(`${cli} logout\n${cli} login --hub ${hub}`)}
`;
  },
};
