import type { Metadata } from "next";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { DOC_PAGES, LEGACY_GUIDE_ANCHORS, llmResources } from "@/lib/docs";
import { hubOrigin } from "@/lib/origin";
import { connectPrompt, isLocalHub, normalizeHubOrigin, readCliVersion } from "@/lib/runbook";

export const metadata: Metadata = { title: "문서 · Dandi" };

// 사용 문서 목록. "사람이 읽는 문서"(/docs/<slug>)와 "AI(LLM)가 읽는 페이지"(/llms.txt, /docs/<slug>.md 등)를 나눈다.
// 내용의 원본은 src/lib/docs. 예전 /guide는 여기로 영구 이동하며, 예전 앵커(#connect, #step-1~8, #downloads)는
// 아래 같은 id로 이어진다(LEGACY_GUIDE_ANCHORS).

export default async function DocsIndexPage() {
  const hub = normalizeHubOrigin(await hubOrigin());
  const prompt = connectPrompt(hub, readCliVersion());
  const local = isLocalHub(hub);
  const resources = llmResources(hub);

  return (
    <>
      <h1>Dandi 문서</h1>
      <p className="muted">
        사람이 읽는 사용 문서와 AI(LLM)가 읽는 페이지를 나누어 둡니다. 사이트를 올릴 때는 아래 문장 하나를 AI에게
        주면 됩니다.
      </p>

      <section id="connect" aria-labelledby="ai-address">
        <h2 id="ai-address">AI에게 줄 주소</h2>
        <p className="muted">
          사이트 폴더를 연 AI 코딩 도구(Claude Code, Codex, Cursor, Antigravity, Grok 등)에 붙여 넣으십시오. 로그인이
          필요하면 AI가 승인 링크를 보여 주고, 승인하면 바로 올린 뒤 비공개 미리보기 주소를 알려 줍니다.
        </p>
        <pre>{prompt}</pre>
        <p>
          <CopyButton text={prompt} label="문장 복사" /> <Link href="/docs/ai-publish">진행 순서 보기</Link> ·{" "}
          <Link href="/connect">도구별 연결</Link>
        </p>
        <p className="muted">
          등록 정보와 셀프점검 답까지 한 번에 보내는 문장은 <Link href="/docs/ai-publish">진행 순서 보기</Link>의 4단계에
          있습니다.
        </p>
        {local && (
          <p className="notice">
            이 허브는 로컬·내부망(http) 주소라 AI 도구가 링크를 읽지 못하므로, 안내 명령을 실행하게 하는 문장을
            드립니다. 허브를 공개 HTTPS 주소로 운영하면 llms.txt 주소 하나를 주는 문장으로 바뀝니다.
          </p>
        )}
      </section>

      <h2 id="human-docs">사람이 읽는 문서</h2>
      <p className="muted">선생님이 읽는 사용 안내입니다. 처음이라면 시작하기부터 읽으십시오.</p>
      <ul className="list">
        {DOC_PAGES.map((p) => (
          <li key={p.slug}>
            {(LEGACY_GUIDE_ANCHORS[p.slug] ?? []).map((id) => (
              <span key={id} id={id} />
            ))}
            <Link href={`/docs/${p.slug}`}>
              <strong>{p.title}</strong>
            </Link>
            <div className="muted">{p.summary}</div>
          </li>
        ))}
      </ul>

      <h2 id="llm-pages">AI(LLM)가 읽는 페이지</h2>
      <p className="muted">
        사람이 열어 볼 필요는 없습니다. 사이트를 올리게 할 때는 AI에게 /llms.txt 하나만 주면 되고, 나머지는 AI와 설치
        도구가 필요할 때 읽습니다.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>주소</th>
              <th>내용</th>
              <th>누가 언제 씁니까</th>
            </tr>
          </thead>
          <tbody>
            {resources.map((r) => (
              <tr key={r.url}>
                <td>
                  {r.kind === "link" ? (
                    <a href={r.url.slice(hub.length)}>
                      <code>{r.url}</code>
                    </a>
                  ) : (
                    <code>{r.url}</code>
                  )}
                </td>
                <td>{r.title}</td>
                <td>{r.who}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
