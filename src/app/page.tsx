import Link from "next/link";
import { AppCard, formatKstDate } from "@/components/app-card";
import { isPublicApp } from "@/lib/apps";
import { isTeachersOnlyBookFile } from "@/lib/files";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { LevelFilter } from "@/components/level-filter";
import { isSchoolLevel, levelLabel, postCategoryLabel } from "@/lib/constants";
import { readDb } from "@/lib/db";
import type { LevelOrAll, SchoolLevel } from "@/lib/types";

// 메인 허브 대시보드(PRD 9장). 상단 인기 미니앱, 중단 커뮤니티 피드, 하단 자료실.
// 전역 학교급 필터(?level=)가 세 구역에 모두 적용된다. 로그인 없이 사용할 수 있다.

const POPULAR_APPS = 6;
const LATEST_POSTS = 5;
const LATEST_FILES = 5;

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function matchesLevel(target: LevelOrAll, level: SchoolLevel | undefined): boolean {
  return !level || target === "all" || target === level;
}

function withLevel(path: string, level: SchoolLevel | undefined): string {
  return level ? `${path}?level=${level}` : path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export default async function HubPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const rawLevel = first(sp.level);
  const level = isSchoolLevel(rawLevel) ? rawLevel : undefined;

  const db = await readDb();

  const apps = db.apps
    .filter(isPublicApp)
    .filter((a) => !level || a.schoolLevels.includes(level))
    .sort((a, b) => b.runs - a.runs || b.createdAt.localeCompare(a.createdAt))
    .slice(0, POPULAR_APPS);

  const posts = db.posts
    .filter((p) => matchesLevel(p.schoolLevel, level))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, LATEST_POSTS);

  const commentCount = new Map<string, number>();
  for (const c of db.comments) commentCount.set(c.postId, (commentCount.get(c.postId) ?? 0) + 1);
  const likeCount = new Map<string, number>();
  for (const l of db.likes) likeCount.set(l.postId, (likeCount.get(l.postId) ?? 0) + 1);

  const viewerIsTeacher = isTeacher(await getCurrentUser());
  const files = db.files
    .filter((f) => viewerIsTeacher || !isTeachersOnlyBookFile(db, f.id))
    .filter((f) => matchesLevel(f.schoolLevel, level))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, LATEST_FILES);

  return (
    <>
      <h1>Dandi</h1>
      <p className="muted">
        로그인 없이 미니앱을 바로 실행하고 자료를 내려받을 수 있습니다. 앱 등록과 글쓰기는{" "}
        <Link href="/login">교사 로그인</Link> 후 사용할 수 있습니다.
      </p>

      <LevelFilter basePath="/" current={level} />

      <section aria-labelledby="hub-apps">
        <h2 id="hub-apps">인기 미니앱</h2>
        {apps.length === 0 ? (
          <p className="muted">해당 학교급의 미니앱이 아직 없습니다.</p>
        ) : (
          <ul className="list">
            {apps.map((app) => (
              <AppCard key={app.id} app={app} />
            ))}
          </ul>
        )}
        <p>
          <Link href={withLevel("/apps", level)}>미니앱 전체 보기</Link> ·{" "}
          <Link href="/studio/apps/new">미니앱 등록(교사)</Link>
        </p>
      </section>

      <section aria-labelledby="hub-posts">
        <h2 id="hub-posts">커뮤니티 최근 글</h2>
        {posts.length === 0 ? (
          <p className="muted">해당 학교급의 글이 아직 없습니다.</p>
        ) : (
          <ul className="list">
            {posts.map((p) => (
              <li key={p.id}>
                <div>
                  <Link href={`/community/${p.id}`}>{p.title}</Link>{" "}
                  <span className="badge">{postCategoryLabel(p.category)}</span>
                  <span className="badge">{levelLabel(p.schoolLevel)}</span>
                </div>
                <div className="muted">
                  {p.authorName} · {formatKstDate(p.createdAt)} · 댓글 {commentCount.get(p.id) ?? 0} · 좋아요{" "}
                  {likeCount.get(p.id) ?? 0}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p>
          <Link href={withLevel("/community", level)}>커뮤니티 전체 보기</Link>
        </p>
      </section>

      <section aria-labelledby="hub-files">
        <h2 id="hub-files">자료실 최근 파일</h2>
        {files.length === 0 ? (
          <p className="muted">해당 학교급의 자료가 아직 없습니다.</p>
        ) : (
          <ul className="list">
            {files.map((f) => (
              <li key={f.id}>
                <div>
                  <strong>{f.title}</strong> <span className="badge">.{f.ext}</span>
                  <span className="badge">{levelLabel(f.schoolLevel)}</span>
                </div>
                <div className="muted">
                  {f.originalName} · {formatBytes(f.size)} · 다운로드 {f.downloads.toLocaleString("ko-KR")}회 ·{" "}
                  {f.authorName}
                </div>
                <p style={{ margin: "6px 0 0" }}>
                  <a href={`/api/files/${f.id}/download`} className="button">
                    다운로드
                  </a>
                  {(f.ext === "exe" || f.ext === "apk") && (
                    <span className="muted"> 실행 파일입니다. 올린 교사와 출처를 확인한 뒤 실행하십시오.</span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p>
          <Link href={withLevel("/files", level)}>자료실 전체 보기</Link>
        </p>
      </section>
    </>
  );
}
