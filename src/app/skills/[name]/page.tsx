import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatKstDate } from "@/components/app-card";
import { CopyButton } from "@/components/copy-button";
import { levelLabel } from "@/lib/constants";
import { hubOrigin } from "@/lib/origin";
import { getCurrentUser } from "@/lib/session";
import {
  canManageSkill,
  compareSemver,
  currentVersion,
  describeSkillVersion,
  getSkillRecord,
  readSkillMd,
  SKILL_STATUS_LABEL,
  skillArchivePath,
  skillInstallVariants,
  skillToolLabel,
} from "@/lib/skills";
import { SkillMarkdown } from "./skill-markdown";

// F-37 스킬 상세: 도구별 설치 명령 복사, SKILL.md, 파일 목록, 버전, 배지.
// 공개 버전이 없는(검토 대기·반려만 있는) 스킬은 게시자와 관리자에게만 보인다.

type Params = Promise<{ name: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { name } = await params;
  const skill = await getSkillRecord(name);
  if (!skill) return {};
  if (!currentVersion(skill) && !canManageSkill(skill, await getCurrentUser())) return {};
  return { title: `${skill.title} · 스킬 · Dandi` };
}

export default async function SkillPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { name } = await params;
  const sp = await searchParams;
  const [skill, user, hub] = await Promise.all([getSkillRecord(name), getCurrentUser(), hubOrigin()]);
  if (!skill) notFound();
  const manage = canManageSkill(skill, user);
  const current = currentVersion(skill);
  if (!current && !manage) notFound();

  // 게시자·관리자는 ?v= 로 검토 대기·반려 버전도 볼 수 있다.
  const versions = [...skill.versions].sort((a, b) => compareSemver(b.version, a.version));
  const visible = manage ? versions : versions.filter((v) => v.status === "approved");
  const requested = one(sp.v);
  const shown = (requested && visible.find((v) => v.version === requested)) || current || versions[0];
  const skillMd = await readSkillMd(shown, hub);
  // 허브 주소를 넣어 내보내는 템플릿 스킬은 설치되는 내용(렌더링 결과)의 digest·크기를 보여 준다.
  const shownInfo = await describeSkillVersion(shown, hub);
  const digests = new Map(await Promise.all(visible.map(async (v) => [v.version, (await describeSkillVersion(v, hub)).digest] as const)));

  const variants = skillInstallVariants(hub, skill.name);
  const tabParam = one(sp.tab);
  const tab = variants.find((v) => v.id === tabParam) ?? variants[0];
  const published = one(sp.published);
  const publishedVersion = published ? skill.versions.find((v) => v.version === published) : undefined;

  return (
    <>
      <p className="muted">
        <Link href="/skills">스킬 목록</Link> / {skill.name}
      </p>
      <h1>{skill.title}</h1>
      <p>
        <code>{skill.name}</code>{" "}
        {current ? <span className="badge">검토 완료</span> : <span className="badge warn">검토 대기</span>}
        {(current ?? shown).hasScripts && <span className="badge warn">스크립트 포함</span>}
        {(skill.schoolLevels.length > 0 ? skill.schoolLevels : ["all" as const]).map((l) => (
          <span key={l} className="badge">
            {levelLabel(l)}
          </span>
        ))}
        {skill.compatibility.map((t) => (
          <span key={t} className="badge">
            {skillToolLabel(t)}
          </span>
        ))}
      </p>
      <p>{skill.description}</p>
      <p className="muted">
        게시 {skill.authorName} · 설치 {skill.installs.toLocaleString("ko-KR")}회 · 라이선스 {skill.license}
        {current && (
          <>
            {" "}
            · 공개 버전 v{current.version} · 검토 {current.reviewedByName ?? "-"}
          </>
        )}{" "}
        · 갱신 {formatKstDate(skill.updatedAt)}
      </p>

      {publishedVersion && manage && (
        <p className="notice" role="status">
          v{publishedVersion.version}을(를) 게시했습니다.{" "}
          {publishedVersion.status === "approved"
            ? "자동 검토를 통과해 바로 공개되었습니다."
            : "스크립트나 검토가 필요한 내용이 있어 관리자 검토 후 공개됩니다. 아래 검토 결과를 확인하십시오."}
        </p>
      )}
      {!current && (
        <p className="notice">
          아직 공개되지 않은 스킬입니다. 관리자 검토가 끝나면 스킬 목록과 설치 주소에 나타납니다. 지금은 게시자와 관리자만
          이 화면을 볼 수 있습니다.
        </p>
      )}

      {current && (
        <>
          <h2>설치</h2>
          <nav className="filter" aria-label="설치 도구 선택">
            {variants.map((v) => (
              <Link
                key={v.id}
                href={`/skills/${skill.name}?tab=${v.id}`}
                aria-current={v.id === tab.id ? "page" : undefined}
                scroll={false}
              >
                {v.label}
              </Link>
            ))}
          </nav>
          <pre>{tab.command}</pre>
          <p>
            <CopyButton text={tab.command} label="설치 명령 복사" />
          </p>
          <p className="muted">
            {tab.note} 터미널에서 실행하거나 AI 코딩 도구에게 &quot;이 명령을 실행해 스킬을 설치해 줘&quot;라고 붙여 넣으십시오.
            Node.js가 필요합니다.
          </p>
          <p className="muted">
            claude.ai에서 쓰려면 <a href={skillArchivePath(skill.name, current.version)}>zip 파일을 내려받아</a> 설정의 스킬
            화면에서 업로드하십시오. 설치하기 전에 아래 SKILL.md와 파일 목록을 확인하십시오. 스킬은 AI 도구의 권한으로
            실행됩니다.
          </p>
        </>
      )}

      <h2>
        SKILL.md <span className="muted">v{shown.version}</span>
      </h2>
      {skillMd ? <SkillMarkdown text={skillMd} /> : <p className="muted">SKILL.md를 읽을 수 없습니다.</p>}

      <h2>파일</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>경로</th>
              <th>크기</th>
            </tr>
          </thead>
          <tbody>
            {shownInfo.files.map((f) => (
              <tr key={f.path}>
                <td>
                  <code>{f.path}</code>
                </td>
                <td>{formatBytes(f.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>버전</h2>
      <p className="muted">
        게시한 버전은 바꿀 수 없습니다. 새 내용은 새 버전으로 올라가고, 버전마다 고정된 zip 주소와 sha256 digest가
        있습니다.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>버전</th>
              <th>상태</th>
              <th>게시일</th>
              <th>digest</th>
              <th>내려받기</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((v) => (
              <tr key={v.version}>
                <td>
                  {v.version === shown.version ? (
                    <strong>v{v.version}</strong>
                  ) : (
                    <Link href={`/skills/${skill.name}?v=${v.version}`}>v{v.version}</Link>
                  )}
                  {v.hasScripts && (
                    <>
                      {" "}
                      <span className="badge warn">스크립트 포함</span>
                    </>
                  )}
                </td>
                <td>
                  <span className={v.status === "approved" ? "badge" : "badge warn"}>{SKILL_STATUS_LABEL[v.status]}</span>
                  {v.reviewedByName && <span className="muted"> {v.reviewedByName}</span>}
                </td>
                <td>{formatKstDate(v.createdAt)}</td>
                <td>
                  <code title={digests.get(v.version) ?? v.digest}>{(digests.get(v.version) ?? v.digest).slice(0, 19)}…</code>
                </td>
                <td>{v.status === "approved" ? <a href={skillArchivePath(skill.name, v.version)}>zip</a> : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {manage && (
        <>
          <h2>검토 결과 (v{shown.version})</h2>
          <p className="muted">게시자와 관리자에게만 보입니다.</p>
          {shown.findings.length === 0 ? (
            <p className="muted">지적 사항이 없습니다.</p>
          ) : (
            <ul>
              {shown.findings.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
          {user.role === "admin" && shown.status === "pending_review" && (
            <p>
              <Link href="/admin/skills" className="button">
                관리자 검토 화면으로
              </Link>
            </p>
          )}
        </>
      )}

      <h2>신고</h2>
      <p className="muted">
        개인정보가 들어 있거나 위험해 보이는 스킬은 <Link href="/community">커뮤니티</Link>에 알리거나 관리자에게
        연락하십시오. 스킬 신고 기능은 준비 중입니다.
      </p>
    </>
  );
}
