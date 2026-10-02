import type { Metadata } from "next";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { hubOrigin } from "@/lib/origin";
import {
  APPROVAL_RULE,
  cliPrefix,
  connectPrompt,
  connectPromptWithAnswers,
  cursorPromptDeeplink,
  DEPLOY_SKILL,
  isLocalHub,
  isLoopbackHub,
  MCP_CHAT_PROMPT,
  mcpInstall,
  normalizeHubOrigin,
  POWERSHELL_UTF8,
  PRIVACY_QUESTIONS,
  readCliVersion,
  secretGuidance,
  skillsAddCommand,
  windowsCli,
} from "@/lib/runbook";

export const metadata: Metadata = { title: "AI로 연결하기 · Dandi" };

// F-56 AI로 연결하기. 탭 내용이 클라이언트에서만 그려지면 fetch하는 에이전트가 볼 수 없으므로
// 모든 도구의 안내를 서버에서 렌더링한다. ?tab=으로 고른 도구만 펼쳐 둔다(나머지도 HTML에 있다).
// 명령 문자열은 src/lib/runbook.ts에서 만들어 /llms-full.txt와 같게 유지한다.

type SearchParams = Record<string, string | string[] | undefined>;

const TABS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "antigravity", label: "Antigravity" },
  { id: "grok", label: "Grok" },
  { id: "claude-desktop", label: "Claude 데스크톱" },
  { id: "chat", label: "채팅형 (claude.ai·ChatGPT)" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function isTabId(value: unknown): value is TabId {
  return TABS.some((t) => t.id === value);
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** 허브를 업데이트하면 로컬 MCP 설정 줄(CLI 파일 이름)이 바뀐다(QA R3). */
function RecopyNote() {
  return (
    <p className="muted">
      허브를 업데이트한 뒤 로컬 MCP가 시작되지 않거나 예전 CLI로 돌면, 이 페이지에서 로컬 MCP 줄을 다시 복사해 바꾸고
      AI 도구를 다시 시작하십시오.
    </p>
  );
}

/** 비밀 키 안내(허브 서버·CLI·문서가 같은 문장을 쓴다). 서버 프록시 주소는 링크로 보여 준다. */
function SecretGuidance({ hub }: { hub: string }) {
  const text = secretGuidance(hub);
  const url = `${hub}/downloads/ai-proxy-example.md`;
  const [before, after] = text.split(url);
  if (after === undefined) return <>{text}</>;
  return (
    <>
      {before}
      <a href="/downloads/ai-proxy-example.md">{url}</a>
      {after}
    </>
  );
}

/** 명령·문장 한 덩어리와 복사 버튼 */
function Copyable({ text, label = "복사" }: { text: string; label?: string }) {
  return (
    <>
      <pre>{text}</pre>
      <p style={{ margin: "4px 0 12px" }}>
        <CopyButton text={text} label={label} />
      </p>
    </>
  );
}

/** 배포 스킬 설치(선택). 설치하면 "Dandi에 올려줘"만으로 AI가 같은 절차를 따른다. */
function SkillInstall({ command, folder }: { command: string; folder: string }) {
  return (
    <>
      <h3>배포 스킬 설치 (선택)</h3>
      <p>
        프로젝트 폴더의 터미널에서 아래 명령을 실행하면 {folder}에 {DEPLOY_SKILL} 스킬이 설치됩니다. 그다음에는
        &quot;Dandi에 올려줘&quot;라고만 해도 AI가 같은 절차를 따릅니다.
      </p>
      <Copyable text={command} />
    </>
  );
}

export default async function ConnectPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const rawTab = first(sp.tab);
  const tab: TabId = isTabId(rawTab) ? rawTab : "claude-code";

  const hub = normalizeHubOrigin(await hubOrigin());
  const version = readCliVersion();
  const cli = cliPrefix(hub, version);
  const local = isLocalHub(hub);
  // 로컬·내부망 허브의 복사 문장은 터미널 명령이다. 브라우저가 Windows여도 npx.cmd로 바꾸지 않는다(Windows의
  // Claude Code는 Git Bash를 쓰고, Git Bash에서는 npx.cmd가 인자를 깨뜨린다). PowerShell 안내는 문장 안 괄호에 있다.
  const prompt = connectPrompt(hub, version);
  const promptWithAnswers = connectPromptWithAnswers(hub, version);
  const m = mcpInstall(hub, version);
  const skillCommand = (agents: string[]) => skillsAddCommand(hub, DEPLOY_SKILL, agents);

  const content: Record<TabId, React.ReactNode> = {
    "claude-code": (
      <>
        <p>프로젝트 폴더에서 Claude Code를 열고 아래 문장을 붙여 넣으십시오.</p>
        <Copyable text={prompt} label="문장 복사" />
        <h3>MCP로 연결하기 (선택)</h3>
        <p>
          터미널에서 아래 한 줄을 실행한 뒤, Claude Code에서 <code>/mcp</code>를 입력하고 dandi를 골라 브라우저에서
          [허용]을 누르십시오.
        </p>
        <Copyable text={m.claudeCode} />
        <p className="muted">로컬 MCP(브라우저 승인으로 로그인한 CLI를 그대로 사용):</p>
        <Copyable text={m.claudeCodeStdio} />
        <RecopyNote />
        <SkillInstall command={skillCommand(["claude-code"])} folder=".claude/skills" />
      </>
    ),
    codex: (
      <>
        <p>프로젝트 폴더에서 Codex를 열고 아래 문장을 붙여 넣으십시오.</p>
        <Copyable text={prompt} label="문장 복사" />
        <h3>MCP로 연결하기 (선택)</h3>
        <p>
          터미널에서 아래 한 줄을 실행하면 브라우저 승인 화면이 바로 열립니다. 명령은 브라우저에서 [허용]을 누를 때까지
          기다리므로 멈춘 것처럼 보여도 끄지 마십시오.
        </p>
        <Copyable text={m.codex} />
        <p className="muted">브라우저가 열리지 않는 이전 버전의 Codex라면 이어서 아래 명령을 실행하십시오.</p>
        <Copyable text={m.codexLogin} />
        <p className="muted">로컬 MCP(브라우저 승인으로 로그인한 CLI를 그대로 사용):</p>
        <Copyable text={m.codexStdio} />
        <RecopyNote />
        <SkillInstall command={skillCommand(["codex"])} folder=".agents/skills" />
        <h3>한 번에 실행할 때 (codex exec)</h3>
        <p className="muted">
          codex exec는 중간에 답을 받을 수 없습니다. 먼저 터미널에서 <code>{cli} login</code>으로 로그인해 두고, 위의
          답을 함께 적는 문장을 쓰십시오. Codex의 보호 환경(샌드박스)이 인터넷 연결이나 프로젝트 밖 파일 쓰기를 막으면
          Dandi 명령이 실패할 수 있으므로, 대화형 Codex에서 실행 허용을 물을 때 동의하는 방식이 더 확실합니다.
        </p>
      </>
    ),
    antigravity: (
      <>
        <p>
          프로젝트 폴더를 Antigravity 편집기로 열거나 그 폴더의 터미널에서 <code>agy</code>를 실행하고, 에이전트 창에
          아래 문장을 붙여 넣으십시오.
        </p>
        <Copyable text={prompt} label="문장 복사" />
        <SkillInstall command={skillCommand(["antigravity-cli", "antigravity"])} folder=".agents/skills" />
        <h3>MCP로 연결하기 (선택)</h3>
        <p>터미널에서 아래 한 줄을 실행하십시오.</p>
        <Copyable text={m.antigravity} />
        <p className="muted">
          연결할 때 브라우저 승인 화면이 열리지 않거나 도구가 보이지 않으면, 아래 로컬 MCP(브라우저 승인으로 로그인한
          CLI를 그대로 사용)를 쓰십시오.
        </p>
        <Copyable text={m.antigravityStdio} />
        <RecopyNote />
        <h3>한 번에 실행할 때 (agy -p)</h3>
        <p className="muted">
          <code>agy -p</code>는 중간에 답을 받을 수 없습니다. 먼저 터미널에서 <code>{cli} login</code>으로 로그인해 두고,
          위의 답을 함께 적는 문장을 쓰십시오. <code>agy -p</code>는 실행이 끝난 뒤에 결과를 한꺼번에 보여 주므로 승인
          링크도 늦게 보입니다.
        </p>
      </>
    ),
    grok: (
      <>
        <p>프로젝트 폴더의 터미널에서 <code>grok</code>을 실행하고 아래 문장을 붙여 넣으십시오.</p>
        <Copyable text={prompt} label="문장 복사" />
        <SkillInstall command={skillCommand(["grok"])} folder=".grok/skills" />
        <p className="muted">
          Grok은 신뢰한 폴더에서만 프로젝트 폴더의 스킬을 읽습니다. 처음 여는 폴더라면 Grok에서 <code>/hooks-trust</code>를
          실행하십시오. 위 문장처럼 주소를 넣어 보내는 방식은 신뢰와 관계없이 동작합니다.
        </p>
        <h3>MCP로 연결하기 (선택)</h3>
        <p>
          터미널에서 아래 한 줄을 실행한 뒤 Grok에서 <code>/mcps</code>를 열고 dandi를 골라 <code>i</code>를 누르면
          브라우저 승인 화면이 열립니다. [허용]을 누르십시오.
        </p>
        <Copyable text={m.grok} />
        <p className="muted">로컬 MCP(브라우저 승인으로 로그인한 CLI를 그대로 사용):</p>
        <Copyable text={m.grokStdio} />
        <RecopyNote />
        <h3>한 번에 실행할 때 (grok -p)</h3>
        <p className="muted">
          <code>grok -p</code>는 중간에 답을 받을 수 없습니다. 먼저 터미널에서 <code>{cli} login</code>으로 로그인해
          두고, 위의 답을 함께 적는 문장을 쓰십시오. 설치한 스킬을 쓰려면 <code>--trust</code>를 붙입니다.
          {local && " Grok의 웹 읽기는 이 컴퓨터·내부망 주소를 열지 않으므로, 위 문장처럼 안내 명령을 실행하게 합니다."}
        </p>
      </>
    ),
    cursor: (
      <>
        <p>프로젝트 폴더를 Cursor로 열고 에이전트 창에 아래 문장을 붙여 넣으십시오.</p>
        <Copyable text={prompt} label="문장 복사" />
        <p>
          <a className="button" href={cursorPromptDeeplink(prompt)}>
            Cursor에서 문장 열기
          </a>{" "}
          <span className="muted">문장만 채워지고 자동으로 실행되지 않습니다. 내용을 확인한 뒤 보내십시오.</span>
        </p>
        <h3>MCP로 연결하기 (선택)</h3>
        <p>
          <a className="button" href={m.cursorDeeplink}>
            Cursor에 Dandi MCP 추가
          </a>
        </p>
        <p className="muted">버튼이 열리지 않으면 아래 주소를 복사해 브라우저 주소창에 붙여 넣으십시오.</p>
        <Copyable text={m.cursorDeeplink} />
        <SkillInstall command={skillCommand(["cursor"])} folder=".agents/skills" />
        <h3>VS Code를 쓴다면</h3>
        <p>
          <a className="button" href={m.vscodeDeeplink}>
            VS Code에 Dandi MCP 추가
          </a>
        </p>
        <Copyable text={m.vscodeDeeplink} />
      </>
    ),
    "claude-desktop": (
      <>
        <p>Claude 데스크톱은 터미널 명령을 직접 실행하지 않으므로 MCP로 연결합니다.</p>
        {m.claudeAiConnector ? (
          <>
            <h3>커넥터로 연결</h3>
            <p>
              <a className="button primary" href={m.claudeAiConnector}>
                Claude에 Dandi 커넥터 추가
              </a>
            </p>
            <p className="muted">
              연결한 뒤 브라우저에서 [허용]을 누르십시오. claude.ai에도 같은 커넥터가 적용됩니다.
            </p>
          </>
        ) : (
          <p className="notice">
            이 허브는 공개 HTTPS 주소가 아니어서 커넥터로 연결할 수 없습니다. 아래 로컬 MCP 설정을 쓰십시오.
          </p>
        )}
        <h3>로컬 MCP로 연결</h3>
        <p>
          1. Claude 데스크톱의 설정 &gt; 개발자 &gt; 설정 편집(Edit Config)에서 claude_desktop_config.json을 열고, 아래
          내용을 넣은 뒤 Claude 데스크톱을 다시 시작하십시오. 이미 다른 mcpServers 항목이 있으면 dandi 항목만
          추가하십시오.
        </p>
        <Copyable text={m.claudeDesktopConfig} label="설정 복사" />
        <p>
          2. Claude에게 아래 문장과 함께 올릴 폴더 경로를 알려 주십시오. 로그인이 필요하면 Claude가 승인 링크를 보여
          줍니다.
        </p>
        <Copyable text={MCP_CHAT_PROMPT} label="문장 복사" />
        <p className="muted">로컬 MCP는 이 컴퓨터에 Node.js 18 이상이 있어야 합니다.</p>
        <RecopyNote />
      </>
    ),
    chat: (
      <>
        <p>
          claude.ai와 ChatGPT 같은 채팅형 AI는 터미널이 없어 MCP 커넥터로 연결합니다. 커넥터는 공개 HTTPS 주소의
          허브에만 연결됩니다.
        </p>
        {m.claudeAiConnector ? (
          <>
            <p>
              <a className="button primary" href={m.claudeAiConnector}>
                claude.ai에 Dandi 커넥터 추가
              </a>
            </p>
            <p className="muted">
              연결할 때 브라우저에서 교사 로그인 후 [허용]을 누르십시오. 학교 Team·Enterprise 요금제는 관리자가 조직
              설정의 커넥터 메뉴에서 같은 주소로 추가합니다.
            </p>
            <p>
              ChatGPT는 설정에서 개발자 모드를 켠 뒤 사용자 지정 커넥터에 아래 주소를 추가하십시오. 요금제나 학교 정책에
              따라 막혀 있을 수 있습니다.
            </p>
            <Copyable text={m.mcpUrl} label="주소 복사" />
            <p>연결한 뒤 아래 문장을 보내십시오.</p>
            <Copyable text={MCP_CHAT_PROMPT} label="문장 복사" />
          </>
        ) : (
          <p className="notice">
            이 허브는 공개 HTTPS 주소가 아니어서 채팅형 AI를 연결할 수 없습니다. 허브를 공개 주소로 배포한 뒤에 쓸 수
            있습니다.
          </p>
        )}
        <p>
          커넥터를 쓸 수 없으면 <Link href="/studio/sites">사이트 폴더 올리기</Link>에서 폴더를 끌어다 놓아
          올리십시오. 같은 셀프점검을 거쳐 허브에 등록됩니다.
        </p>
      </>
    ),
  };

  return (
    <>
      <h1>AI로 연결하기</h1>
      <p>
        AI 코딩 도구에 주소 하나만 주면 AI가 로그인 상태를 확인하고, 필요하면 승인 링크를 띄운 뒤, 사이트를 바로
        비공개 미리보기로 올리고 개인정보 셀프점검을 거쳐 허브에 등록합니다. 토큰을 복사하거나 붙여 넣을 일은 없습니다.
      </p>

      <section
        aria-labelledby="give-url"
        style={{ border: "1px solid var(--line)", borderRadius: 4, padding: "4px 12px", margin: "12px 0" }}
      >
        <h2 id="give-url">AI에게 이 주소를 주십시오</h2>
        {local ? (
          <p>
            이 허브는 로컬·내부망 주소라 AI가 링크를 직접 읽지 못합니다. 아래 문장은 안내 명령(
            <code>{cli} guide</code>)을 실행해 같은 절차를 읽게 합니다.
          </p>
        ) : (
          <p>
            AI가 읽을 주소: <a href="/llms.txt">{hub}/llms.txt</a>
          </p>
        )}
        <p className="muted">
          사이트 폴더를 연 AI 코딩 도구(Claude Code, Codex, Cursor, Antigravity, Grok 등)에 아래 문장을 붙여 넣으십시오.
        </p>
        <Copyable text={prompt} label="문장 복사" />
        <p className="muted">
          제목, 한 줄 설명, 학교급, 분류와 셀프점검 ①~⑤ 답을 문장에 함께 적으면 AI가 다시 묻지 않고 바로 등록합니다.
          괄호 안을 채워 보내십시오.
        </p>
        <Copyable text={promptWithAnswers} label="답을 함께 적는 문장 복사" />
      </section>
      {local && (
        <p className="notice">
          이 허브는 로컬 주소나 학교 내부망 주소(http)에서 실행 중입니다. AI 도구의 웹 읽기 기능은 이런 주소를 열지
          못하므로, 링크 대신 안내 명령을 실행하게 하는 문장을 드립니다. 허브를 공개 HTTPS 주소로 배포하면 링크 문장으로
          바뀝니다. 명령 앞부분은 셸에 따라 다릅니다. Git Bash·macOS·Linux에서는 npx, Windows PowerShell·cmd에서는 npx.cmd로
          실행합니다. AI가 다음에 실행할 명령(next_step)에는 알맞은 쪽이 이미 들어 있습니다.
        </p>
      )}
      {local && !isLoopbackHub(hub) && (
        <p className="notice">
          내부망 IP나 내부 이름으로 여는 허브입니다. 허브 관리자는 HUB_ORIGIN에 교사가 여는 허브 주소(예:
          http://192.168.0.5:3100)를 설정하십시오. 설정하지 않으면 로그인 승인 링크와 CLI 주소가 요청마다 들어온
          주소를 따라가서, 다른 이름이나 프록시로 연 컴퓨터에서는 로그인이 되지 않을 수 있습니다. 미리보기·공개
          주소(사이트 이름.허브 주소)는 다른 컴퓨터에서 열리지 않으므로 SITES_DOMAIN(허브 서버를 가리키는 와일드카드
          DNS 이름, 예: *.sites.school.kr)도 설정해야 합니다.
        </p>
      )}

      <h2>진행 순서</h2>
      <ol>
        <li>AI 코딩 도구에 위 문장을 붙여 넣습니다.</li>
        <li>
          AI가 로그인 상태를 확인합니다. 로그인이 필요하면 AI가 보여 주는 승인 링크를 열고, 화면의 코드가 AI 대화창의
          코드와 같으면 [승인]을 누릅니다. 승인하려면 이 브라우저에서 <Link href="/login">교사 로그인</Link>이 되어
          있어야 합니다.
        </li>
        <li>
          AI가 묻지 않고 바로 사이트를 올려 비공개 미리보기 주소를 알려 줍니다. 이때는 아직 허브에 공개되지 않습니다.
        </li>
        <li>
          문장에 적은 답으로, 답을 적지 않았다면 AI가 한 번에 묻는 셀프점검 5문항에 직접 답한 뒤 허브에 등록되고 앱
          주소가 나옵니다.
        </li>
      </ol>

      <h2 id="tools">도구별 연결</h2>
      <nav className="filter" aria-label="도구 선택">
        {TABS.map((t) => (
          <Link key={t.id} href={`/connect?tab=${t.id}#tools`} aria-current={t.id === tab ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      <p className="muted">모든 도구의 안내가 이 페이지에 있습니다. 도구를 고르면 해당 안내가 펼쳐집니다.</p>
      {TABS.map((t) => (
        <details key={t.id} id={`tab-${t.id}`} open={t.id === tab} style={{ margin: "8px 0" }}>
          <summary>
            <strong>{t.label}</strong>
          </summary>
          {content[t.id]}
        </details>
      ))}

      <h2>배포 스킬 한 번에 설치 (선택)</h2>
      <p>
        프로젝트 폴더의 터미널에서 아래 명령을 실행하면 Claude Code, Cursor, Codex, Antigravity, Grok용 {DEPLOY_SKILL}{" "}
        스킬이 한 번에 설치되고 AI에게 보낼 문장이 나옵니다. Windows PowerShell에서는 앞의 npx를 npx.cmd로 바꾸십시오.
      </p>
      <Copyable text={`${cli} setup`} />

      <h2>AI가 묻는 셀프점검 5문항</h2>
      <p className="muted">
        허브 등록 화면과 같은 문항입니다. AI가 코드를 보고 답을 제안하더라도 교사가 직접 확인하고 답해야 합니다.
      </p>
      <ul className="list">
        {PRIVACY_QUESTIONS.map((q) => (
          <li key={q.key}>
            {q.mark} {q.question} <span className="muted">({q.answer})</span>
          </li>
        ))}
      </ul>
      <p className="muted">
        {APPROVAL_RULE}. 승인 대기인 앱은 학교 내부 승인을 받은 뒤 <Link href="/studio/apps">내 미니앱</Link>에서 승인
        완료를 표시하면 공개됩니다.
      </p>

      <h2>안전 안내</h2>
      <ul>
        <li>[승인]을 누르기 전에 AI 대화창이나 터미널에 보이는 코드와 승인 화면의 코드가 같은지 확인하십시오.</li>
        <li>
          직접 AI에게 Dandi 로그인을 시킨 경우에만 승인하십시오. 웹사이트나 다른 사람이 보낸 승인 링크와 코드는
          거부하십시오.
        </li>
        <li>토큰, 비밀번호, API 키를 AI 대화창에 붙여 넣지 마십시오. 로그인은 브라우저에서만 합니다.</li>
        <li>
          올린 사이트는 먼저 비공개 미리보기로 만들어지고, 허브 공개는 셀프점검 5문항에 직접 답한 뒤에 됩니다. AI가
          대신 답했다면 하나씩 확인하고 고치십시오.
        </li>
        <li>예시 데이터, 파일 이름, 설명에 실제 학생 정보를 넣지 마십시오.</li>
        <li>
          사이트 파일에 API 키 같은 비밀값이 있으면 업로드가 거부됩니다. <SecretGuidance hub={hub} />
        </li>
      </ul>

      <h2>연결된 기기 관리</h2>
      <ul>
        <li>
          <Link href="/studio/cli">CLI 로그인 기기</Link>: 브라우저 승인으로 로그인한 컴퓨터를 확인하고 폐기합니다.
        </li>
        <li>
          <Link href="/oauth/connections">연결된 AI 도구</Link>: MCP 연결을 허용한 AI 도구를 확인하고 연결을 끊습니다.
        </li>
      </ul>
      <p className="muted">쓰지 않는 기기나 기억나지 않는 연결은 바로 폐기하십시오.</p>

      <h2>자주 묻는 질문</h2>
      <ul>
        <li>
          <strong>Windows에서도 됩니까?</strong> Node.js 18 이상만 설치되어 있으면 따로 설치할 것 없이 npx로
          실행됩니다. 셸에 따라 명령 앞부분이 다릅니다. Git Bash(Windows의 Claude Code가 쓰는 셸)에서는{" "}
          <code>npx</code> 그대로 쓰고, Windows PowerShell·cmd에서는 기본 실행 정책이 npx.ps1을 막으므로{" "}
          <code>npx.cmd</code>로 씁니다. 예: <code>{windowsCli(cli)} guide</code>. Git Bash에서 npx.cmd를 쓰면 공백이
          든 폴더 이름 같은 인자가 깨집니다. PowerShell에서 한국어가 깨지면 먼저 <code>{POWERSHELL_UTF8}</code>를
          실행하십시오.
        </li>
        <li>
          <strong>학교망에서 브라우저가 열리지 않으면 어떻게 합니까?</strong>{" "}
          {local
            ? "이 허브는 이 컴퓨터나 학교 내부망에서 실행 중이어서 휴대전화로는 승인 링크를 열 수 없습니다. 승인 링크를 복사해 이 컴퓨터의 브라우저 주소창에 붙여 넣으십시오."
            : "승인 링크를 휴대전화로 열어 승인해도 됩니다."}
        </li>
        <li>
          <strong>이미 올린 사이트를 고치면 어떻게 됩니까?</strong> AI가 새 버전을 비공개 미리보기로 올리고, 지난번
          셀프점검 답이 그대로인지 확인을 받은 뒤 다시 등록합니다. 다시 등록하기 전까지는 지금 공개된 버전이 그대로
          보입니다. 학교 내부 승인을 받은 앱은 답이 같으면 승인이 유지되어 바로 새 버전으로 바뀌고, 답이 바뀌면 새
          버전이 다시 승인을 기다립니다. 그동안 공개 주소는 이전에 공개한 버전을 그대로 보여 주고, 앱은 허브 목록에서
          빠집니다.
        </li>
        <li>
          <strong>터미널을 쓸 수 없는 AI는 어떻게 합니까?</strong>{" "}
          {m.claudeAiConnector
            ? "위의 MCP 커넥터로 연결하거나 "
            : "이 허브는 공개 HTTPS 주소가 아니어서 채팅형 AI를 연결할 수 없습니다. "}
          <Link href="/studio/sites">사이트 폴더 올리기</Link>에서 폴더를 끌어다 놓아 올리십시오.
        </li>
      </ul>

      <h2>AI 에이전트용 안내</h2>
      <p>
        AI 에이전트라면 <a href="/llms.txt">{hub}/llms.txt</a>를 읽고 그대로 따르십시오. 명령, JSON, 종료 코드, MCP
        설정 전체는 <a href="/llms-full.txt">{hub}/llms-full.txt</a>에 있습니다.
      </p>
      <p className="muted">
        사람이 읽는 사용 안내는 <Link href="/docs">문서</Link>에, AI가 읽는 같은 내용의 Markdown 목록은{" "}
        <a href="/docs/index.md">{hub}/docs/index.md</a>에 있습니다.
      </p>
      {local && (
        <p className="muted">
          이 허브는 로컬·내부망(http) 주소이므로 웹 읽기 도구 대신 셸에서 <code>{cli} guide</code>를 실행해 원문을
          읽으십시오. Windows PowerShell에서는 먼저 <code>{POWERSHELL_UTF8}</code>를 실행한 뒤{" "}
          <code>{windowsCli(cli)} guide</code>를 쓰십시오.
        </p>
      )}
    </>
  );
}
