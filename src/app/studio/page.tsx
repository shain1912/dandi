import Link from "next/link";
import { levelLabel } from "@/lib/constants";
import { readDb } from "@/lib/db";
import { getCurrentUser, isTeacher } from "@/lib/session";

// 교사 전용 스튜디오(PRD 9장). 작성·배포 기능으로 가는 입구와 내 활동 수를 보여 준다.

const LINKS = [
  { href: "/connect", label: "AI로 연결하기", desc: "AI 코딩 도구에 링크 하나만 주고 \"내 사이트 올려줘\"라고 하면 허브에 올라갑니다." },
  { href: "/studio/sites", label: "내 사이트", desc: "허브에 올린 사이트의 미리보기·공개 주소를 보고, 폴더를 끌어다 놓아 새 사이트를 올립니다." },
  { href: "/studio/projects", label: "프로젝트·API 키", desc: "프로젝트별 API 키(여러 개·역할·만료)와 월 예산, 사용량, 허용 모델을 관리합니다." },
  { href: "/skills/new", label: "스킬 게시", desc: "AI 코딩 도구용 스킬(SKILL.md)을 올려 다른 교사가 명령 한 줄로 설치하게 합니다." },
  { href: "/books/new", label: "책 등록", desc: "웹북 주소나 PDF를 서가에 올려 브라우저에서 바로 읽게 합니다." },
  { href: "/studio/apps/new", label: "미니앱 등록(외부 URL)", desc: "다른 곳에 배포한 앱 주소와 배포 전 개인정보 셀프점검을 입력해 허브에 올립니다." },
  { href: "/studio/apps", label: "내 미니앱", desc: "내가 등록한 앱의 실행 수와 셀프점검 결과를 확인합니다." },
  { href: "/files/upload", label: "자료 업로드", desc: "교육용 파일(.exe, .apk, .zip, .pdf, .hwpx 등)을 자료실에 올립니다." },
  { href: "/templates/new", label: "템플릿 등록", desc: "작업 지시서와 예시 사이트를 묶어 다른 교사와 나눕니다." },
  { href: "/community/new", label: "글쓰기", desc: "강의 자료, 질문, 정보 공유 글을 학교급 태그와 함께 씁니다." },
  { href: "/studio/cli", label: "CLI 토큰", desc: "CI·자동화용 CLI 토큰을 발급하고, 로그인된 기기의 토큰을 폐기합니다." },
  { href: "/oauth/connections", label: "연결된 AI 도구", desc: "MCP로 연결된 AI 도구(Claude Code, Cursor 등)를 확인하고 연결을 끊습니다." },
  { href: "/studio/pii", label: "개인정보 검증", desc: "글이나 설명에 개인정보가 섞였는지 실시간으로 확인합니다." },
  { href: "/ai", label: "AI 게이트웨이", desc: "허용 모델 가이드를 보고 프로젝트 키로 게이트웨이를 시험 호출합니다." },
];

export default async function StudioPage() {
  const user = await getCurrentUser();

  if (!isTeacher(user)) {
    return (
      <>
        <h1>교사 스튜디오</h1>
        <p className="notice">
          스튜디오는 교사 로그인 후 사용할 수 있습니다. <Link href="/login">교사 로그인</Link>
        </p>
        <p className="muted">
          로그인 없이도 <Link href="/studio/pii">개인정보 필터링 검증</Link> 화면은 사용할 수 있습니다.
        </p>
      </>
    );
  }

  const db = await readDb();
  const mine = <T extends { authorId: string }>(rows: T[]) => rows.filter((r) => r.authorId === user.id).length;
  const counts = [
    { label: "미니앱", value: mine(db.apps), href: "/studio/apps" },
    { label: "게시글", value: mine(db.posts), href: "/community" },
    { label: "자료", value: mine(db.files), href: "/files" },
    { label: "템플릿", value: mine(db.templates), href: "/templates" },
  ];
  const activeTokens = db.cliTokens.filter((t) => t.userId === user.id && !t.revokedAt).length;

  return (
    <>
      <h1>교사 스튜디오</h1>
      <p className="muted">
        {user.name}
        {user.schoolLevel ? ` · ${levelLabel(user.schoolLevel)}` : ""} · {user.role === "admin" ? "관리자" : "교사"}
      </p>

      <h2>내 활동</h2>
      <p>
        {counts.map((c) => (
          <Link key={c.label} href={c.href} className="badge">
            {c.label} {c.value}
          </Link>
        ))}
        <Link href="/studio/cli" className="badge">
          사용 중인 CLI 토큰 {activeTokens}
        </Link>
      </p>

      <h2>작성·배포</h2>
      <ul className="list">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href}>{l.label}</Link>
            <div className="muted">{l.desc}</div>
          </li>
        ))}
      </ul>

      <h2>AI에게 맡기기</h2>
      <p className="muted">
        AI 코딩 도구(Claude Code, Codex, Cursor 등)에 <Link href="/connect">AI로 연결하기</Link>의 문장 한 줄을 붙여 넣으면,
        AI가 로그인(브라우저에서 코드 확인 후 승인)부터 사이트 올리기까지 직접 진행합니다. 셀프점검 5문항에는 선생님이
        직접 답하시면 됩니다.
      </p>
    </>
  );
}
