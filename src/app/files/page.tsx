import Link from "next/link";

// F-08: 실행 파일은 다운로드 전에 경고한다.
const EXECUTABLE_EXT = new Set(["exe", "apk"]);
import { LevelFilter } from "@/components/level-filter";
import { isSchoolLevel, levelLabel, UPLOAD_ALLOWED_EXT, UPLOAD_MAX_BYTES } from "@/lib/constants";
import { formatBytes, listFiles } from "@/lib/files";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { DeleteFileButton } from "./delete-button";

// 자료실(F-08). 누구나 로그인 없이 내려받을 수 있고, 업로드와 삭제는 교사만 한다.

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });
}

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ level?: string | string[] }>;
}) {
  const sp = await searchParams;
  const level = typeof sp.level === "string" && isSchoolLevel(sp.level) ? sp.level : undefined;
  const user = await getCurrentUser();
  const files = await listFiles({ level, viewerIsTeacher: isTeacher(user) });
  const teacher = isTeacher(user);

  return (
    <>
      <h1>자료실</h1>
      <p className="muted">
        교사들이 공유한 교육용 프로그램과 자료입니다. 다운로드는 로그인 없이 할 수 있습니다. 허용 형식:{" "}
        {UPLOAD_ALLOWED_EXT.join(", ")} · 파일당 최대 {formatBytes(UPLOAD_MAX_BYTES)}
      </p>

      {teacher ? (
        <p>
          <Link href="/files/upload" className="button primary">
            업로드
          </Link>
        </p>
      ) : (
        <p className="notice">
          자료 업로드는 교사 로그인이 필요합니다. <Link href="/login">교사 로그인</Link>
        </p>
      )}

      <LevelFilter basePath="/files" current={level} />
      {level && <p className="muted">{levelLabel(level)} 자료와 학교급 전체 대상 자료를 함께 보여 줍니다.</p>}

      {files.length === 0 ? (
        <p className="muted">등록된 자료가 없습니다.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>자료</th>
                <th>형식</th>
                <th>크기</th>
                <th>학교급</th>
                <th>다운로드 수</th>
                <th>올린 사람</th>
                <th>등록일</th>
                <th>받기</th>
                {teacher && <th>관리</th>}
              </tr>
            </thead>
            <tbody>
              {files.map((f) => {
                const canDelete = teacher && (f.authorId === user.id || user.role === "admin");
                return (
                  <tr key={f.id}>
                    <td>
                      <strong>{f.title}</strong>
                      {f.description && (
                        <div className="muted" style={{ whiteSpace: "pre-wrap" }}>
                          {f.description}
                        </div>
                      )}
                      <div className="muted">{f.originalName}</div>
                    </td>
                    <td>
                      <span className="badge">.{f.ext}</span>
                    </td>
                    <td>{formatBytes(f.size)}</td>
                    <td>{levelLabel(f.schoolLevel)}</td>
                    <td>{f.downloads}</td>
                    <td>{f.authorName}</td>
                    <td>{formatDate(f.createdAt)}</td>
                    <td>
                      <a href={`/api/files/${f.id}/download`} download>
                        다운로드
                      </a>
                      {EXECUTABLE_EXT.has(f.ext) && (
                        <div className="pii-warning">
                          실행 파일입니다. 올린 교사와 출처를 확인한 뒤 실행하십시오.
                        </div>
                      )}
                    </td>
                    {teacher && <td>{canDelete && <DeleteFileButton id={f.id} title={f.title} />}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
