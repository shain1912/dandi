import Link from "next/link";
import { hubOrigin } from "@/lib/origin";
import { listMyProjects } from "@/lib/projects";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { SITE_ALLOWED_EXT, SITE_LIMITS, siteSecretGuidance, siteUrl } from "@/lib/sites";
import { FolderUpload } from "../folder-upload";
import { emptyPublishValues } from "../format";

// 웹 폴더 올리기(F-52): 새 사이트. 셸이 없는 교사도 폴더를 끌어다 놓아 CLI와 같은 흐름으로 올린다.

export default async function NewSitePage() {
  const user = await getCurrentUser();
  if (!isTeacher(user)) {
    return (
      <>
        <h1>폴더 올리기</h1>
        <p className="notice">
          사이트 올리기는 교사 로그인이 필요합니다. <Link href="/login?next=/studio/sites/new">교사 로그인</Link> 후 다시
          시도하십시오.
        </p>
      </>
    );
  }

  // F-31: 새 사이트를 연결할 프로젝트. 활성 프로젝트 중 가장 오래된 것이 기본 프로젝트다(서버 ensureDefaultProjectIn과 같은 순서).
  const projects = (await listMyProjects(user))
    .filter((p) => p.status === "active")
    .map((p) => ({ id: p.id, name: p.name }));

  // QA R8: 비밀값 안내는 CLI·MCP·서버 finalize와 같은 문장을 쓰고, 서버 프록시 예시 주소만 링크로 보여 준다.
  const hub = await hubOrigin();
  const proxyUrl = `${hub.replace(/\/+$/, "")}/downloads/ai-proxy-example.md`;
  const guidance = siteSecretGuidance(hub);
  const at = guidance.indexOf(proxyUrl);

  return (
    <>
      <p className="muted">
        <Link href="/studio">스튜디오</Link> / <Link href="/studio/sites">내 사이트</Link> / 폴더 올리기
      </p>
      <h1>폴더 올리기</h1>
      <p className="muted">
        AI 코딩 도구로 만든 사이트의 빌드 결과 폴더(index.html이 들어 있는 폴더)를 올립니다. 올린 뒤 미리보기로 확인하고,
        셀프점검 5문항에 답하면 허브 미니앱으로 등록됩니다. API 키나 토큰이 들어 있는 파일은 올라가지 않습니다.{" "}
        {at < 0 ? (
          guidance
        ) : (
          <>
            {guidance.slice(0, at)}
            <a href="/downloads/ai-proxy-example.md">{proxyUrl}</a>
            {guidance.slice(at + proxyUrl.length)}
          </>
        )}
      </p>
      <FolderUpload
        limits={SITE_LIMITS}
        allowedExt={SITE_ALLOWED_EXT}
        publishDefaults={emptyPublishValues("", user.schoolLevel)}
        urlExample={siteUrl(hub, "science-quiz")}
        projects={projects}
        hub={hub}
      />
    </>
  );
}
