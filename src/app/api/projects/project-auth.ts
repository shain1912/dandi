import "server-only";
import { agentAuthError, apiError, authenticateAgent } from "@/lib/agent-auth";
import {
  apiKeyFromRequest,
  authenticateProjectKey,
  getProjectForUser,
  keyHint,
  PROJECT_ERROR_STATUS,
  type ProjectDetail,
  type ProjectErrorCode,
  type ProjectKeyView,
  type ProjectSummary,
} from "@/lib/projects";
import type { Project, ProjectApiKey, User } from "@/lib/types";

// 프로젝트 JSON API 공통(F-31, F-32). 이 폴더의 route.ts만 쓴다.
// 인증 두 가지:
//  1) 교사 에이전트 토큰(dd_cli_ CLI 토큰, dd_mat_ OAuth 접근 토큰) → 자기 프로젝트 전체
//  2) 프로젝트 키(dd_sk_, Edge Impulse 방식) → 그 키의 프로젝트만. admin: 조회·키 발급, readonly: 조회만, inference: 불가

export type ProjectApiActor =
  | { ok: true; via: "agent"; user: User; project: Project }
  | { ok: true; via: "key"; user: User; project: Project; key: ProjectApiKey }
  | { ok: false; response: Response };

export function projectError(code: ProjectErrorCode, message: string, hint?: string): Response {
  return apiError(PROJECT_ERROR_STATUS[code], code, message, hint);
}

/** 프로젝트 하나에 대한 권한 확인. need가 "manage"면 교사 토큰이나 admin 키만 통과한다. */
export async function authorizeProjectApi(
  req: Request,
  projectId: string,
  need: "read" | "manage",
): Promise<ProjectApiActor> {
  const presented = apiKeyFromRequest(req);
  if (presented?.startsWith("dd_sk_")) {
    const auth = await authenticateProjectKey(req);
    if (!auth.ok) {
      const headers: HeadersInit = auth.status === 401 ? { "WWW-Authenticate": "Bearer" } : {};
      return { ok: false, response: apiError(auth.status, auth.code, auth.message, auth.hint, headers) };
    }
    if (auth.project.id !== projectId) {
      return { ok: false, response: apiError(403, "forbidden", "이 키는 다른 프로젝트의 키입니다.") };
    }
    const allowed = need === "manage" ? auth.key.role === "admin" : auth.key.role !== "inference";
    if (!allowed) {
      const what = need === "manage" ? "키 관리는 admin 역할 키로만 할 수 있습니다." : "inference 키는 게이트웨이 호출만 할 수 있습니다.";
      return {
        ok: false,
        response: apiError(403, "insufficient_role", what, "교사 로그인 토큰(dandi login)이나 알맞은 역할의 키를 쓰십시오."),
      };
    }
    return { ok: true, via: "key", user: auth.owner, project: auth.project, key: auth.key };
  }

  const auth = await authenticateAgent(req);
  if (!auth.ok) return { ok: false, response: agentAuthError(auth) };
  const project = await getProjectForUser(auth.user, projectId);
  if (!project) return { ok: false, response: apiError(404, "not_found", "프로젝트를 찾을 수 없습니다.") };
  return { ok: true, via: "agent", user: auth.user, project };
}

export function projectJson(p: ProjectSummary, hub: string) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    monthlyTokenBudget: p.monthlyTokenBudget,
    modelIds: p.modelIds,
    effectiveModels: p.effectiveModelIds,
    usage: { tokens: p.monthTokens, budgetPct: p.budgetPct, budgetAlert: p.budgetAlert },
    activeKeys: p.activeKeys,
    createdAt: p.createdAt,
    url: `${hub}/studio/projects/${p.id}`,
  };
}

export function keyJson(k: ProjectKeyView) {
  return {
    id: k.id,
    name: k.name,
    role: k.role,
    hint: k.hint,
    status: k.status,
    createdBy: k.createdByName,
    createdAt: k.createdAt,
    expiresAt: k.expiresAt,
    expiryWarning: k.expiryWarning,
    lastUsedAt: k.lastUsedAt,
    lastUsedIp: k.lastUsedIp,
    usage: { tokens: k.monthTokens, calls: k.monthCalls },
  };
}

export function detailJson(d: ProjectDetail, hub: string) {
  return {
    project: {
      id: d.project.id,
      name: d.project.name,
      description: d.project.description,
      status: d.project.status,
      owner: d.owner.name,
      monthlyTokenBudget: d.project.monthlyTokenBudget,
      modelIds: d.project.modelIds,
      effectiveModels: d.effective.map((m) => m.id),
      createdAt: d.project.createdAt,
      url: `${hub}/studio/projects/${d.project.id}`,
    },
    usage: {
      month: d.usage.month,
      tokens: d.usage.projectTokens,
      calls: d.usage.projectCalls,
      budget: d.usage.budget,
      budgetPct: d.usage.budgetPct,
      budgetAlert: d.usage.budgetAlert,
      teacherTokens: d.usage.teacherTokens,
      teacherCap: d.usage.teacherCap,
      byKey: d.usage.byKey.map((k) => ({ keyId: k.keyId, name: k.name, hint: k.hint, tokens: k.tokens, calls: k.calls })),
      byModel: d.usage.byModel.map((m) => ({ model: m.modelId || null, name: m.modelName, tokens: m.tokens, calls: m.calls })),
    },
    keys: d.keys.map(keyJson),
    sites: d.sites,
    // F-31: 이 프로젝트에 연결된 미니앱(외부 주소 앱 포함). link가 "default"면 projectId 없이 등록해 기본 프로젝트로 본 앱.
    apps: d.apps.map((a) => ({
      id: a.id,
      title: a.title,
      url: a.url,
      siteSlug: a.siteSlug,
      approvalStatus: a.approvalStatus,
      link: a.link,
      createdAt: a.createdAt,
      appUrl: `${hub}/apps/${a.id}`,
    })),
  };
}

/** 감사 로그용: API에서 admin 키로 발급한 경우 그 키의 힌트 */
export function viaKey(actor: Extract<ProjectApiActor, { ok: true }>): { keyHint: string } | undefined {
  return actor.via === "key" ? { keyHint: keyHint(actor.key) } : undefined;
}

/** JSON 본문 읽기. 객체가 아니면 null. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
