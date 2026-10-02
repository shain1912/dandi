import type { Metadata } from "next";
import Link from "next/link";
import { formatKstDate } from "@/components/app-card";
import { LevelFilter } from "@/components/level-filter";
import { isSchoolLevel, levelLabel } from "@/lib/constants";
import { getCurrentUser, isTeacher } from "@/lib/session";
import {
  compareSemver,
  isSkillTool,
  listMySkills,
  listPublicSkills,
  SKILL_STATUS_LABEL,
  SKILL_TOOLS,
  skillToolLabel,
  type SkillSort,
} from "@/lib/skills";

export const metadata: Metadata = { title: "스킬 · Dandi" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const SORTS: { id: SkillSort; label: string }[] = [
  { id: "installs", label: "설치 많은 순" },
  { id: "recent", label: "최근 갱신 순" },
];

// F-37 스킬 목록: 검색, 학교급·호환 도구 필터, 설치 수 순위. 공개(승인된 버전이 있는) 스킬만 보인다.
export default async function SkillsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const q = one(sp.q)?.trim().slice(0, 100) || undefined;
  const levelParam = one(sp.level);
  const level = isSchoolLevel(levelParam) ? levelParam : undefined;
  const toolParam = one(sp.tool);
  const tool = isSkillTool(toolParam) ? toolParam : undefined;
  const sort: SkillSort = one(sp.sort) === "recent" ? "recent" : "installs";

  const user = await getCurrentUser();
  const [skills, mine] = await Promise.all([
    listPublicSkills(q, { level, tool, sort }),
    isTeacher(user) ? listMySkills(user) : Promise.resolve([]),
  ]);

  const href = (patch: Record<string, string | undefined>) => {
    const next: Record<string, string | undefined> = { q, level, tool, sort: sort === "installs" ? undefined : sort, ...patch };
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) query.set(k, v);
    const s = query.toString();
    return s ? `/skills?${s}` : "/skills";
  };

  return (
    <>
      <h1>스킬</h1>
      <p className="muted">
        스킬은 AI 코딩 도구(Claude Code, Cursor, Codex)가 읽고 따라 하는 작업 설명서입니다. 스킬 화면의 설치 명령 한 줄을
        터미널이나 AI에게 주면 지금 프로젝트에 설치됩니다. 프롬프트만 있는 스킬은 자동 검토 후 바로 공개되고, 스크립트가
        들어 있는 스킬은 관리자 검토를 거친 뒤 공개됩니다.
      </p>
      <p>
        {isTeacher(user) ? (
          <Link href="/skills/new" className="button">
            스킬 게시
          </Link>
        ) : (
          <span className="muted">
            스킬 게시는 <Link href="/login?next=/skills/new">교사 로그인</Link> 후 사용할 수 있습니다. 찾아보기와 설치는
            로그인 없이 사용할 수 있습니다.
          </span>
        )}
      </p>

      <form method="get" action="/skills" role="search" className="stack">
        <label className="field">
          <span>검색</span>
          <input name="q" defaultValue={q ?? ""} maxLength={100} placeholder="예: 가정통신문, rubric, deploy" />
        </label>
        {level && <input type="hidden" name="level" value={level} />}
        {tool && <input type="hidden" name="tool" value={tool} />}
        {sort !== "installs" && <input type="hidden" name="sort" value={sort} />}
        <div>
          <button type="submit">검색</button> {q && <Link href={href({ q: undefined })}>검색어 지우기</Link>}
        </div>
      </form>

      <LevelFilter basePath="/skills" current={level} extraQuery={{ q, tool, sort: sort === "installs" ? undefined : sort }} />
      <nav className="filter" aria-label="호환 도구 필터">
        <Link href={href({ tool: undefined })} aria-current={!tool ? "page" : undefined}>
          모든 도구
        </Link>
        {SKILL_TOOLS.map((t) => (
          <Link key={t.id} href={href({ tool: t.id })} aria-current={tool === t.id ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      <nav className="filter" aria-label="정렬">
        {SORTS.map((s) => (
          <Link
            key={s.id}
            href={href({ sort: s.id === "installs" ? undefined : s.id })}
            aria-current={sort === s.id ? "page" : undefined}
          >
            {s.label}
          </Link>
        ))}
      </nav>

      {skills.length === 0 ? (
        <p className="muted">조건에 맞는 스킬이 없습니다. 검색어나 필터를 바꾸어 보십시오.</p>
      ) : (
        <ol className="list">
          {skills.map((s) => (
            <li key={s.name}>
              <strong>
                <Link href={`/skills/${s.name}`}>{s.title}</Link>
              </strong>{" "}
              <code>{s.name}</code>
              <div>{s.description.length > 220 ? `${s.description.slice(0, 220)}…` : s.description}</div>
              <div className="muted">
                <span className="badge">검토 완료</span>
                {s.hasScripts && <span className="badge warn">스크립트 포함</span>}
                {(s.schoolLevels.length > 0 ? s.schoolLevels : ["all" as const]).map((l) => (
                  <span key={l} className="badge">
                    {levelLabel(l)}
                  </span>
                ))}
                {s.compatibility.map((t) => (
                  <span key={t} className="badge">
                    {skillToolLabel(t)}
                  </span>
                ))}{" "}
                설치 {s.installs.toLocaleString("ko-KR")}회 · v{s.latestVersion} · {s.authorName} · 갱신{" "}
                {formatKstDate(s.updatedAt)}
              </div>
            </li>
          ))}
        </ol>
      )}

      {mine.length > 0 && (
        <>
          <h2>내가 게시한 스킬</h2>
          <p className="muted">검토 대기·반려 버전은 나와 관리자에게만 보입니다.</p>
          <ul className="list">
            {mine.map((s) => {
              const newest = [...s.versions].sort((a, b) => compareSemver(b.version, a.version))[0];
              return (
                <li key={s.name}>
                  <Link href={`/skills/${s.name}`}>{s.title}</Link> <code>{s.name}</code>{" "}
                  <span className="muted">
                    최신 v{newest.version}{" "}
                    <span className={newest.status === "approved" ? "badge" : "badge warn"}>
                      {SKILL_STATUS_LABEL[newest.status]}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
