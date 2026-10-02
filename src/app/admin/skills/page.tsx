import type { Metadata } from "next";
import Link from "next/link";
import { formatKstDate } from "@/components/app-card";
import { getCurrentUser } from "@/lib/session";
import {
  currentVersion,
  listPendingSkillVersions,
  listReviewedSkillVersions,
  readSkillVersionFiles,
  SKILL_STATUS_LABEL,
} from "@/lib/skills";
import { SkillReviewForm } from "./review-form";

export const metadata: Metadata = { title: "스킬 검토 · 관리자 · Dandi" };

// F-40 관리자 스킬 검토: 스크립트·훅·지적 사항이 있어 자동 공개되지 않은 버전을 파일 내용과 함께 보고 승인·반려한다.

const PREVIEW_BYTES = 32 * 1024;

export default async function AdminSkillsPage() {
  const user = await getCurrentUser();
  if (user.role !== "admin") {
    return (
      <>
        <h1>스킬 검토</h1>
        <p className="notice">
          교육청 관리자만 사용할 수 있는 화면입니다. <Link href="/login?next=/admin/skills">데모 로그인</Link>에서
          &apos;교육청 관리자(데모)&apos; 역할로 로그인하십시오.
        </p>
      </>
    );
  }

  const [pending, reviewed] = await Promise.all([listPendingSkillVersions(), listReviewedSkillVersions(20)]);
  const withFiles = await Promise.all(
    pending.map(async (p) => ({ ...p, files: await readSkillVersionFiles(p.version, PREVIEW_BYTES) })),
  );

  return (
    <>
      <p className="muted">
        <Link href="/admin">관리자</Link> / 스킬 검토
      </p>
      <h1>스킬 검토</h1>
      <p className="muted">
        프롬프트만 있고 지적 사항이 없는 스킬은 자동으로 공개됩니다. 아래는 스크립트(scripts/), 훅, 셸 실행 문법, 넓은 셸
        권한, 외부 전송 명령, 바이너리 파일 등이 있어 사람 검토가 필요한 버전입니다. 파일 내용을 끝까지 읽고, 학생 개인정보를
        다루거나 바깥으로 데이터를 보내는 동작이 없는지 확인한 뒤 승인하십시오. 승인하면 설치 주소(index.json)에 바로
        반영됩니다.
      </p>

      <h2>검토 대기 ({pending.length})</h2>
      {withFiles.length === 0 ? (
        <p className="muted">검토를 기다리는 스킬 버전이 없습니다.</p>
      ) : (
        <ul className="list">
          {withFiles.map(({ skill, version, files }) => {
            const live = currentVersion(skill);
            return (
              <li key={`${skill.name}@${version.version}`}>
                <h3 style={{ margin: "0 0 4px" }}>
                  <Link href={`/skills/${skill.name}?v=${version.version}`}>{skill.title}</Link> <code>{skill.name}</code> v
                  {version.version}
                </h3>
                <p className="muted" style={{ margin: 0 }}>
                  {version.hasScripts && <span className="badge warn">스크립트 포함</span>}
                  <span className="badge warn">{SKILL_STATUS_LABEL[version.status]}</span> 게시 {skill.authorName} ·{" "}
                  {formatKstDate(version.createdAt)} · 현재 공개 버전 {live ? `v${live.version}` : "없음"} · 파일{" "}
                  {version.files.length}개
                </p>
                <p style={{ margin: "8px 0 4px" }}>
                  <strong>자동 검토 결과</strong>
                </p>
                {version.findings.length === 0 ? (
                  <p className="muted">지적 사항이 없습니다.</p>
                ) : (
                  <ul>
                    {version.findings.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                )}
                {files.map((f) => (
                  <details key={f.path}>
                    <summary>
                      <code>{f.path}</code> <span className="muted">({f.size.toLocaleString("ko-KR")} 바이트)</span>
                    </summary>
                    {f.text === null ? (
                      <p className="muted">바이너리 파일이라 내용을 표시하지 않습니다.</p>
                    ) : (
                      <>
                        <pre>{f.text}</pre>
                        {f.truncated && <p className="muted">앞부분 32KB만 표시했습니다.</p>}
                      </>
                    )}
                  </details>
                ))}
                <SkillReviewForm name={skill.name} version={version.version} />
              </li>
            );
          })}
        </ul>
      )}

      <h2>최근 검토 이력</h2>
      {reviewed.length === 0 ? (
        <p className="muted">아직 관리자가 검토한 버전이 없습니다.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>스킬</th>
                <th>버전</th>
                <th>결과</th>
                <th>검토자</th>
                <th>게시일</th>
              </tr>
            </thead>
            <tbody>
              {reviewed.map(({ skill, version }) => (
                <tr key={`${skill.name}@${version.version}`}>
                  <td>
                    <Link href={`/skills/${skill.name}?v=${version.version}`}>{skill.name}</Link>
                  </td>
                  <td>v{version.version}</td>
                  <td>{SKILL_STATUS_LABEL[version.status]}</td>
                  <td>{version.reviewedByName}</td>
                  <td>{formatKstDate(version.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
