import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatKstDate } from "@/components/app-card";
import { CopyButton } from "@/components/copy-button";
import { appCategoryLabel, levelLabel } from "@/lib/constants";
import { getTemplate } from "@/lib/templates";
import { recordTemplateCopy } from "../actions";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const template = await getTemplate(id);
  return { title: template ? `${template.title} · 템플릿 · Dandi` : "템플릿 · Dandi" };
}

// F-10 작업 지시서 보기·원클릭 복사 + 예시 사이트 임베드 실행.
export default async function TemplateDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const template = await getTemplate(id);
  if (!template) notFound();

  const masked = typeof sp.masked === "string" ? Number.parseInt(sp.masked, 10) : 0;
  const isHubExample = template.exampleUrl.startsWith("/examples/");

  return (
    <>
      <p className="muted">
        <Link href="/templates">템플릿 갤러리</Link> / 작업 지시서
      </p>
      <h1>{template.title}</h1>
      <p>{template.summary}</p>
      <p className="muted">
        <span className="badge">{appCategoryLabel(template.category)}</span>
        {template.schoolLevels.map((l) => (
          <span key={l} className="badge">
            {levelLabel(l)}
          </span>
        ))}
        복사 {template.copies.toLocaleString("ko-KR")}회 · {template.authorName} ·{" "}
        {formatKstDate(template.createdAt)}
      </p>

      {masked > 0 && (
        <p className="notice" role="status">
          등록한 내용에서 개인정보로 보이는 부분 {masked}건을 ***로 가려 저장했습니다.
        </p>
      )}

      <h2>사용 순서</h2>
      <ol>
        <li>아래 예시 사이트를 실행해 보고, 만들고 싶은 모습과 다른 점을 적어 두십시오.</li>
        <li>
          작업 지시서를 복사해 AI 코딩 도구에 붙여 넣으십시오. 학교 사정에 맞게 기능 목록을 고쳐도 됩니다.
        </li>
        <li>
          프로젝트 폴더 맨 위에 <a href="/downloads/llms.txt">llms.txt</a>와{" "}
          <a href="/downloads/DESIGN.md">DESIGN.md</a>를 두면 AI가 규칙과 디자인을 먼저 읽습니다.
        </li>
        <li>
          완성하면 <a href="/downloads/privacy-checklist.md">개인정보 셀프점검</a>을 거쳐 배포하고 허브에
          등록하십시오. 자세한 단계는 <Link href="/docs/ai-publish">AI로 사이트 올리기 문서</Link>에 있습니다.
        </li>
      </ol>

      <h2>작업 지시서</h2>
      <p>
        <CopyButton
          text={template.workOrder}
          label="작업 지시서 복사"
          copiedMessage="복사했습니다. AI 코딩 도구의 입력창에 붙여 넣으십시오."
          onCopyAction={recordTemplateCopy.bind(null, template.id)}
        />
      </p>
      <pre>{template.workOrder}</pre>

      <h2>예시 사이트</h2>
      <p className="muted">
        <a href={template.exampleUrl} target="_blank" rel="noopener noreferrer">
          새 창에서 열기
        </a>
        {isHubExample
          ? " · 허브에 포함된 예시입니다. 입력한 내용은 서버로 전송되지 않습니다."
          : " · 외부 사이트가 허브 안에서 열리지 않으면 새 창에서 여십시오."}
      </p>
      {/* 예시 주소는 /examples/*.html(허브 정적 파일) 또는 외부 http(s)만 허용된다(lib/templates).
          sandbox로 상위 창 이동을 막고, 예시 앱의 브라우저 저장·복사 기능은 쓸 수 있게 둔다. */}
      <iframe
        className="app-frame"
        src={template.exampleUrl}
        title={`${template.title} 예시`}
        sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-same-origin"
        allow="clipboard-write"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </>
  );
}
