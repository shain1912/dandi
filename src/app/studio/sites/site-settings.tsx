"use client";

import { useActionState } from "react";
import { deleteSiteAction, moveSiteProjectAction, type SiteSettingsState } from "./actions";

// 사이트 관리 화면의 설정: 연결 프로젝트 바꾸기(F-31), 허브에 등록하지 않은 사이트 지우기(QA UX-15).

export type ProjectOption = { id: string; name: string };

export function SiteProjectForm({
  siteId,
  projectId,
  projects,
}: {
  siteId: string;
  projectId: string;
  /** 내 활성 프로젝트 */
  projects: ProjectOption[];
}) {
  const [state, action, pending] = useActionState<SiteSettingsState, FormData>(moveSiteProjectAction, {});
  const current = projects.find((p) => p.id === projectId);
  return (
    <form action={action} className="stack">
      <input type="hidden" name="siteId" value={siteId} />
      <label className="field">
        <span>연결 프로젝트</span>
        <select name="projectId" defaultValue={current ? projectId : projects[0]?.id}>
          {!current && <option value={projectId}>{projectId} (보관했거나 찾을 수 없는 프로젝트)</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.id})
            </option>
          ))}
        </select>
        <span className="muted">
          프로젝트는 AI 키·사용량을 묶는 단위입니다. 옮기면 허브에 등록한 미니앱도 같은 프로젝트로 옮겨집니다.
        </span>
      </label>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.message && (
        <p className="notice" role="status">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending || projects.length === 0}>
        {pending ? "옮기는 중…" : "프로젝트 바꾸기"}
      </button>
    </form>
  );
}

export function DeleteSiteForm({ siteId, slug }: { siteId: string; slug: string }) {
  const [state, action, pending] = useActionState<SiteSettingsState, FormData>(deleteSiteAction, {});
  return (
    <form action={action} className="stack">
      <input type="hidden" name="siteId" value={siteId} />
      <label>
        <input type="checkbox" name="confirm" value="yes" required /> 사이트 <code>{slug}</code>와 모든 미리보기 주소를
        지웁니다. 되돌릴 수 없습니다.
      </label>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "지우는 중…" : "사이트 삭제"}
      </button>
    </form>
  );
}
