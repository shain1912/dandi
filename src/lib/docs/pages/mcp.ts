import { MCP_CHAT_PROMPT, mcpInstall } from "../../runbook.ts";
import type { DocPage } from "../types.ts";
import { code, docLink, fence, versionFromCli } from "../shared.ts";

export const doc: DocPage = {
  slug: "mcp",
  title: "AI 도구 연결(MCP)",
  summary:
    "Claude Code, Codex, Cursor, VS Code, Antigravity, Grok, Claude 데스크톱, claude.ai에 Dandi를 MCP로 연결하는 방법입니다.",
  audience: "human",
  body: (hub, cli) => {
    const m = mcpInstall(hub, versionFromCli(cli));
    const desktopConnector = m.claudeAiConnector
      ? `커넥터로 연결하려면 [Claude에 Dandi 커넥터 추가](${m.claudeAiConnector})를 누르고 브라우저에서 [허용]을 누르십시오. claude.ai에도 같은 커넥터가 적용됩니다.`
      : "이 허브는 공개 HTTPS 주소가 아니어서 커넥터로 연결할 수 없습니다. 아래 로컬 MCP를 쓰십시오.";
    const chat = m.claudeAiConnector
      ? `- claude.ai: [claude.ai에 Dandi 커넥터 추가](${m.claudeAiConnector}). 학교 Team·Enterprise 요금제는 관리자가 조직 설정의 커넥터 메뉴에서 같은 주소로 추가합니다.
- ChatGPT: 설정에서 개발자 모드를 켠 뒤 사용자 지정 커넥터에 ${code(m.mcpUrl)} 를 추가합니다. 요금제나 학교 정책에 따라 막혀 있을 수 있습니다.`
      : `- 채팅형 AI의 커넥터는 공개 HTTPS 주소에만 연결됩니다. 이 허브(${hub})는 해당하지 않으므로 ${docLink(hub, "web-upload", "웹에서 폴더 올리기")}를 쓰십시오.`;
    return `MCP로 연결하면 AI 도구가 Dandi 도구(사이트 올리기, 셀프점검 문항, 허브 등록, 스킬 검색)를 직접 부릅니다. 터미널 명령을 실행하는 AI 코딩 도구는 연결하지 않아도 ${docLink(hub, "ai-publish", "AI에게 URL 하나 주고 사이트 올리기")}로 충분합니다. 연결은 선택입니다.

연결 방식은 두 가지입니다.

- 원격 MCP: ${code(m.mcpUrl)} 주소를 등록하고, 브라우저에서 교사 로그인 후 [허용]을 누릅니다.
- 로컬 MCP: 이 컴퓨터에서 CLI를 MCP 서버로 실행합니다. CLI 로그인(브라우저 승인)을 그대로 쓰고 로컬 폴더를 바로 올릴 수 있습니다. Node.js 18 이상이 필요합니다.

## Claude Code

${fence(m.claudeCode)}

등록한 뒤 Claude Code에서 ${code("/mcp")} 를 입력하고 dandi를 골라 브라우저에서 승인합니다. 로컬 MCP는 아래 한 줄입니다.

${fence(m.claudeCodeStdio)}

## Codex

${fence(m.codex)}

브라우저 승인 화면이 바로 열리고 [허용]을 누를 때까지 기다립니다. 멈춘 것처럼 보여도 끄지 마십시오. 브라우저가 열리지 않는 이전 버전의 Codex라면 이어서 ${code(m.codexLogin)} 명령을 실행합니다. 로컬 MCP는 아래 한 줄입니다.

${fence(m.codexStdio)}

## Cursor

[Cursor에 Dandi MCP 추가](${m.cursorDeeplink})

링크가 열리지 않으면 아래 주소를 복사해 브라우저 주소창에 붙여 넣으십시오.

${fence(m.cursorDeeplink)}

## VS Code

[VS Code에 Dandi MCP 추가](${m.vscodeDeeplink})

## Antigravity (agy)

${fence(m.antigravity)}

원격 연결에서 브라우저 승인 화면이 뜨지 않으면 아래 로컬 MCP를 쓰십시오.

${fence(m.antigravityStdio)}

## Grok

${fence(m.grok)}

등록한 뒤 Grok에서 ${code("/mcps")} 를 열고 dandi를 골라 i를 누르면 브라우저 승인 화면이 열립니다. 로컬 MCP는 아래 한 줄입니다.

${fence(m.grokStdio)}

기본은 사용자 전체 설정(${code("~/.grok/config.toml")})에 저장됩니다. ${code("--scope project")} 를 붙이면 이 폴더에만 저장되고, Grok은 신뢰한 폴더에서만 그 서버를 시작합니다.

## Claude 데스크톱

${desktopConnector}

로컬 MCP는 설정 > 개발자 > 설정 편집(Edit Config)에서 claude_desktop_config.json을 열고 아래 내용을 넣은 뒤 Claude 데스크톱을 다시 시작합니다. 이미 다른 mcpServers 항목이 있으면 dandi 항목만 추가합니다.

${fence(m.claudeDesktopConfig, "json")}

## claude.ai와 ChatGPT

${chat}

연결한 뒤 보낼 문장입니다.

${fence(MCP_CHAT_PROMPT)}

## 연결 관리

- 원격 MCP로 연결한 AI 도구: ${hub}/oauth/connections
- CLI와 로컬 MCP로 로그인한 기기: ${hub}/studio/cli
- 쓰지 않는 기기나 기억나지 않는 연결은 바로 폐기하십시오.
- 허브를 업데이트한 뒤 로컬 MCP가 시작되지 않거나 예전 CLI로 돌면, 이 페이지나 ${hub}/connect 에서 로컬 MCP 줄을 다시 복사해 등록하고 AI 도구를 다시 시작하십시오.
`;
  },
};
