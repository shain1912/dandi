import { POWERSHELL_UTF8, windowsCli } from "../../runbook.ts";
import type { DocPage } from "../types.ts";
import { code, docLink, fence } from "../shared.ts";

const COMMANDS: readonly [string, string][] = [
  ["login", "브라우저 승인 로그인. 다른 계정으로 바꿀 때는 `--force`를 붙입니다."],
  ["logout", "저장된 로그인을 지웁니다."],
  ["whoami", "로그인한 교사의 이름, 역할, 학교급을 보여 줍니다."],
  ["init", "dandi.json(등록 정보·셀프점검)과 프로젝트 llms.txt 뼈대를 만듭니다. 있는 파일은 덮어쓰지 않습니다."],
  ["deploy [폴더]", "비공개 미리보기로 올립니다. `--project <id>`는 사이트를 다른 프로젝트로 옮깁니다."],
  ["publish", "셀프점검 후 허브에 등록합니다. `--url <주소>`는 다른 곳에 배포한 앱의 주소만 등록합니다."],
  ["guide", "허브의 AI 실행 런북(/llms.txt)을 그대로 출력합니다."],
  ["mcp", "로컬 MCP 서버를 실행합니다."],
  ["skill add <이름>", "허브 스킬을 설치합니다."],
  ["skill publish [폴더]", "스킬 폴더를 게시합니다."],
  ["skill list [검색어]", "공개 스킬을 찾습니다."],
  ["help", "전체 명령과 옵션을 보여 줍니다."],
];

const EXIT_CODES: readonly [string, string][] = [
  ["0", "성공"],
  ["1", "기타 오류. 안내 문구를 확인합니다."],
  ["2", "사용법 오류, 폴더나 index.html 없음, dandi.json 인코딩 오류"],
  ["4", "로그인 필요"],
  ["5", "브라우저 승인 대기"],
  ["6", "승인 거부"],
  ["7", "승인 시간 만료(10분)"],
  ["20", "업로드 거부(비밀값, 빌드 전 원본 폴더, 한도 초과, 다른 계정의 사이트)"],
  ["21", "셀프점검·등록 정보 누락"],
];

export const doc: DocPage = {
  slug: "cli",
  title: "터미널에서 직접 쓰기(CLI)",
  summary: "설치 없이 npx로 dandi CLI를 실행하는 방법, 명령 표, 종료 코드, CI용 토큰 로그인을 정리합니다.",
  audience: "human",
  body: (hub, cli) => `dandi CLI는 Node.js 18 이상만 있으면 설치 없이 실행됩니다. 보통은 AI가 대신 실행하므로 ${docLink(hub, "ai-publish", "AI에게 URL 하나 주고 사이트 올리기")}로 충분합니다. 이 문서는 직접 실행하거나 자동화할 때 봅니다.

## 실행 접두어

모든 명령은 아래 접두어 뒤에 붙여 실행합니다.

- Git Bash, macOS, Linux: ${code(cli)}
- Windows PowerShell, cmd: ${code(windowsCli(cli))}

PowerShell은 npx를 npx.ps1로 찾는데 기본 실행 정책이 이를 막으므로 npx.cmd를 씁니다. Git Bash에서는 npx.cmd를 쓰지 마십시오. 공백이 든 폴더 이름 같은 인자가 깨집니다. PowerShell에서 한국어가 깨지면 먼저 ${code(POWERSHELL_UTF8)} 를 실행하십시오.

접두어의 파일 이름에는 버전과 내용 해시가 들어 있어 CLI가 바뀌면 주소도 바뀝니다. 예전에 적어 둔 명령 대신 이 페이지나 ${hub}/connect 에서 다시 복사하십시오.

## 처음 올리기

${fence(`${cli} login\n${cli} init\n${cli} deploy\n${cli} publish`)}

1. login: 브라우저가 열리면 화면의 코드가 터미널의 코드와 같은지 확인하고 [승인]을 누릅니다.
2. init: dandi.json과 프로젝트 llms.txt 뼈대를 만듭니다.
3. deploy: 사이트를 올리고 비공개 미리보기 주소를 받습니다.
4. publish: dandi.json의 제목, 설명, 학교급, 분류와 셀프점검 5문항(privacyCheck)을 채운 뒤 허브에 등록합니다. 하나라도 비어 있으면 등록되지 않습니다.

dandi.json은 UTF-8로 저장하십시오. Windows PowerShell에서는 ${code("Set-Content -Encoding UTF8")} 를 씁니다. siteId가 기록되므로 지우지 마십시오.

## 명령

| 명령 | 하는 일 |
|---|---|
${COMMANDS.map(([c, d]) => `| ${code(c)} | ${d} |`).join("\n")}

모든 명령에 ${code("--json")} 을 붙이면 AI가 읽기 쉬운 JSON으로 결과를 냅니다. 오류가 나면 다음에 실행할 명령을 함께 알려 줍니다.

## 종료 코드

| 코드 | 뜻 |
|---|---|
${EXIT_CODES.map(([c, d]) => `| ${c} | ${d} |`).join("\n")}

## CI와 자동화

브라우저 승인을 쓸 수 없는 CI에서는 ${hub}/studio/cli 에서 CI용 토큰을 발급해 CI의 비밀 저장소에 둡니다.

- 환경변수 ${code("DANDI_TOKEN")} 에 토큰을 넣으면 저장된 로그인 대신 그 토큰으로 deploy와 publish를 실행합니다.
- 로그인 정보로 저장하려면 표준입력으로 넘깁니다.

${fence(`printf '%s' "$DANDI_TOKEN" | ${cli} login --token-stdin`)}

- 토큰을 명령 인자로 주면 셸 기록에 남으므로 거부됩니다.
- 쓰지 않는 토큰과 기기는 ${hub}/studio/cli 에서 폐기하십시오.

## 설정 파일과 환경변수

- 로그인 정보는 ${code("~/.dandi/config.json")} 에 저장됩니다. 이 파일은 화면에 출력하거나 올리거나 커밋하지 마십시오.
- ${code("DANDI_HUB")}: 허브 주소, ${code("DANDI_TOKEN")}: CI 토큰, ${code("DANDI_CONFIG_DIR")}: 설정 폴더
- 명령, JSON 형식, 오류 코드 전체는 ${hub}/llms-full.txt 에 있습니다.
`,
};
