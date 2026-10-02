import "server-only";
import { MODEL_STATUS_LABEL } from "./constants";
import { mutate, newId, nowIso, readDb } from "./db";
import { hasPII, maskFields, maskPII } from "./pii";
import {
  BUDGET_ALERT_PCT,
  checkKeyIn,
  effectiveModels,
  migrateLegacyKeys,
  sumUsage,
  TEACHER_MONTHLY_CAP,
  touchKeyIn,
} from "./projects";
import { normalizeNewlines } from "./text";
import { AuthError, ensureUser, writeAudit } from "./session";
import type { AiModel, DB, ModelDeployment, ModelStatus, Project, ProjectApiKey, User } from "./types";

// AI 모델 게이트웨이 도메인 로직(F-21 ~ F-24, F-32 ~ F-35).
// 호출은 프로젝트 API 키(dd_sk_)로 인증하고, 한도·모델 정책은 키가 속한 프로젝트를 따른다.
// 웹 화면(/ai 테스트 폼)과 외부 호출(POST /api/ai/chat)이 모두 gatewayCall 하나를 거친다.
// v0.2도 실제 모델 대신 모의 응답을 돌려준다(PRD 13. 로드맵).

// 날짜·사용량 도우미는 projects.ts에 있다. 관리자 화면 등 기존 import 경로를 위해 다시 내보낸다.
export { formatKst, monthKey, sumUsage } from "./projects";

export const PROMPT_MAX_CHARS = 8000;

export const DEPLOYMENT_LABEL: Record<ModelDeployment, string> = {
  api: "온라인 API",
  local: "로컬·온프레미스",
};

export const MODEL_STATUSES: ModelStatus[] = ["allowed", "pending", "blocked"];

export function isModelStatus(value: unknown): value is ModelStatus {
  return MODEL_STATUSES.includes(value as ModelStatus);
}

export function isDeployment(value: unknown): value is ModelDeployment {
  return value === "api" || value === "local";
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/* ---------- 모델 조회 (F-22) ---------- */

export async function listModels(): Promise<AiModel[]> {
  const db = await readDb();
  return db.models;
}

/** 교사 화면용 상태 이름(F-23): 보류는 "정책 검토 중"으로 보여 준다. */
export function teacherStatusLabel(model: Pick<AiModel, "status">): string {
  return model.status === "pending" ? "정책 검토 중" : MODEL_STATUS_LABEL[model.status];
}

/* ---------- 게이트웨이 호출 (F-21) ---------- */

export type GatewayErrorCode =
  | "invalid_key"
  | "key_disabled"
  | "key_expired"
  | "project_archived"
  | "insufficient_role"
  | "invalid_request"
  | "model_not_found"
  | "model_not_allowed"
  | "project_quota_exceeded"
  | "teacher_quota_exceeded";

/** HTTP 상태(POST /api/ai/chat). 인증 오류(401)에는 WWW-Authenticate를 붙인다. */
export const GATEWAY_STATUS: Record<GatewayErrorCode, number> = {
  invalid_key: 401,
  key_disabled: 401,
  key_expired: 401,
  project_archived: 403,
  insufficient_role: 403,
  invalid_request: 400,
  model_not_found: 400,
  model_not_allowed: 403,
  project_quota_exceeded: 429,
  teacher_quota_exceeded: 429,
};

export type GatewaySuccess = {
  ok: true;
  output: string;
  model: string; // 모델 id
  modelName: string;
  projectId: string;
  projectName: string;
  keyId: string;
  tokens: number;
  piiMasked: number;
  piiLabels: string[];
  /** 프로젝트 월 예산 기준 남은 토큰 */
  remaining: number;
  /** 프로젝트 월 예산 */
  quota: number;
  teacherRemaining: number;
  teacherCap: number;
  /** 80% 알림(F-33) 등 */
  warnings: string[];
  mock: true;
};

export type GatewayFailure = {
  ok: false;
  code: GatewayErrorCode;
  error: string;
  hint?: string;
  /** 키가 가리키는 프로젝트(응답 헤더 x-dandi-project-id용). 키가 유효하지 않으면 없다. */
  projectId?: string;
};

export type GatewayResult = GatewaySuccess | GatewayFailure;

export type GatewayInput = {
  /** 인증된 프로젝트 키 id (HTTP: authenticateProjectKey, 화면: 교사가 고른 자기 프로젝트의 키) */
  keyId: string;
  modelId: string;
  prompt: string;
  /** 주면 성공한 호출에서 키의 마지막 사용 시각·IP를 기록한다(교사 화면 테스트 호출용). */
  touchIp?: string | null;
};

function fail(code: GatewayErrorCode, error: string, hint?: string, projectId?: string): GatewayFailure {
  return { ok: false, code, error, ...(hint ? { hint } : {}), ...(projectId ? { projectId } : {}) };
}

const n = (v: number) => v.toLocaleString("ko-KR");

/** 한국어 기준 대략 2자당 1토큰으로 추정한다(프로토타입 가정). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

function modelNotFound(modelId: string, projectId: string): GatewayFailure {
  return fail(
    "model_not_found",
    `'${modelId.slice(0, 60)}' 모델을 찾을 수 없습니다. GET /api/ai/models 목록을 확인하십시오.`,
    undefined,
    projectId,
  );
}

/**
 * 교육청 정책 오류(F-23). 교사에게는 보류를 "정책 검토 중"으로 보여 주고,
 * 차단 모델은 교사 화면에서 숨기므로 없는 모델과 같은 응답을 돌려준다.
 */
function policyError(model: AiModel, projectId: string): GatewayFailure {
  if (model.status === "blocked") return modelNotFound(model.id, projectId);
  return fail(
    "model_not_allowed",
    `${model.name}(${model.id}) 모델은 현재 정책 검토 중이라 호출할 수 없습니다. ` +
      "모델 허용 여부는 교육청 정책 판단에 따르며, 교육청 관리자가 허용하면 바로 사용할 수 있습니다.",
    undefined,
    projectId,
  );
}

function projectModelError(model: AiModel, project: Project): GatewayFailure {
  return fail(
    "model_not_allowed",
    `${model.name}(${model.id}) 모델은 '${project.name}' 프로젝트에서 허용하지 않은 모델입니다.`,
    `프로젝트 모델 탭(/studio/projects/${project.id}?tab=models)에서 허용 모델을 바꾸거나, 허용된 모델을 쓰십시오.`,
    project.id,
  );
}

function projectQuotaError(project: Project, used: number, tokens: number): GatewayFailure {
  return fail(
    "project_quota_exceeded",
    `이번 달 프로젝트 예산을 넘습니다. '${project.name}' 사용량 ${n(used)} / 월 예산 ${n(project.monthlyTokenBudget)}토큰, ` +
      `이번 요청 예상 ${n(tokens)}토큰. 한도는 매월 1일(한국 시각)에 초기화됩니다.`,
    `프로젝트 설정 탭(/studio/projects/${project.id}?tab=settings)에서 월 예산을 늘릴 수 있습니다(교사 전체 상한 ${n(TEACHER_MONTHLY_CAP)}토큰 이내).`,
    project.id,
  );
}

function teacherQuotaError(project: Project, used: number, tokens: number): GatewayFailure {
  return fail(
    "teacher_quota_exceeded",
    `이번 달 교사 전체 상한을 넘습니다. 모든 프로젝트 합계 ${n(used)} / 상한 ${n(TEACHER_MONTHLY_CAP)}토큰, ` +
      `이번 요청 예상 ${n(tokens)}토큰. 한도는 매월 1일(한국 시각)에 초기화됩니다.`,
    "교사 전체 상한은 프로젝트를 늘려도 올라가지 않습니다. 쓰지 않는 미니앱의 키를 비활성화하십시오.",
    project.id,
  );
}

type Access = { ok: true; key: ProjectApiKey; project: Project; owner: User; model: AiModel };

/**
 * 키·프로젝트·모델 정책 확인. 순서(PRD F-32~F-34):
 * 키 없음·삭제·비활성화·만료 401 → 프로젝트 보관 403 → readonly 역할 403
 * → 모델 없음·차단(model_not_found) → 교육청 보류(model_not_allowed) → 프로젝트 목록 밖(model_not_allowed).
 * 스냅샷과 잠금 안에서 두 번 사용한다.
 */
function checkAccess(db: DB, input: GatewayInput): Access | GatewayFailure {
  const auth = checkKeyIn(
    db,
    db.projectKeys.find((k) => k.id === input.keyId),
  );
  if (!auth.ok) {
    const code = (auth.code in GATEWAY_STATUS ? auth.code : "invalid_key") as GatewayErrorCode;
    return fail(code, auth.message, auth.hint, auth.projectId);
  }
  const { key, project, owner } = auth;
  if (key.role === "readonly") {
    return fail(
      "insufficient_role",
      "읽기 전용(readonly) 키로는 게이트웨이를 호출할 수 없습니다.",
      `프로젝트 키 탭(/studio/projects/${project.id}?tab=keys)에서 inference 역할의 키를 만드십시오.`,
      project.id,
    );
  }
  const model = db.models.find((m) => m.id === input.modelId);
  if (!model) return modelNotFound(input.modelId, project.id);
  if (model.status !== "allowed") return policyError(model, project.id);
  if (!effectiveModels(project, [model]).length) return projectModelError(model, project);
  return { ok: true, key, project, owner, model };
}

/** 예산 확인(F-33): 프로젝트 월 예산 → 교사 전체 상한 순서. */
function checkBudget(db: DB, access: Access, tokens: number): { projectUsed: number; teacherUsed: number } | GatewayFailure {
  const projectUsed = sumUsage(db.usage, { projectId: access.project.id });
  if (projectUsed + tokens > access.project.monthlyTokenBudget) {
    return projectQuotaError(access.project, projectUsed, tokens);
  }
  const teacherUsed = sumUsage(db.usage, { userId: access.owner.id });
  if (teacherUsed + tokens > TEACHER_MONTHLY_CAP) return teacherQuotaError(access.project, teacherUsed, tokens);
  return { projectUsed, teacherUsed };
}

/*
 * ===================== 확장 지점: 실제 모델 제공사 어댑터 (v1.0, F-25) =====================
 * v0.2는 모든 모델이 mockProvider로 응답한다. v1.0에서는 모델 id별 어댑터를 등록한다.
 *
 *   const ADAPTERS: Record<string, ProviderAdapter> = {
 *     claude: anthropicAdapter,        // 온라인 API (서버 환경 변수의 플랫폼 키 사용, 교사에게 노출하지 않음)
 *     gpt: openaiAdapter,
 *     "exaone-local": onPremAdapter,   // 교육청 자체 서버의 로컬 모델(F-25)
 *   };
 *   function providerFor(model) { return ADAPTERS[model.id] ?? mockProvider; }
 *
 * 규칙
 * 1) 어댑터는 반드시 maskPII를 거친 텍스트(maskedPrompt)만 받는다. 원문 프롬프트를 넘기지 않는다.
 * 2) 실제 호출은 네트워크를 타므로 mutate 잠금 밖에서 실행한다(현재 구조와 같음).
 * 3) 호출 전 한도 확인에는 "입력 토큰 + 최대 출력 토큰"을 쓰고, 호출 후 제공사가 알려 준 실제 사용량을 기록한다.
 * ==========================================================================================
 */
type ProviderRequest = { model: AiModel; maskedPrompt: string; piiMasked: number };
type ProviderAdapter = (req: ProviderRequest) => Promise<string>;

/** 결정적(deterministic) 모의 응답. 같은 모델·같은 프롬프트면 항상 같은 결과를 낸다. */
const mockProvider: ProviderAdapter = async ({ model, maskedPrompt, piiMasked }) => {
  const flat = maskedPrompt.replace(/\s+/g, " ").trim();
  const excerpt = flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
  return [
    "[모의 응답] Dandi 프로토타입은 실제 AI 모델을 호출하지 않습니다.",
    `요청 모델: ${model.name} (${model.provider}) · 실행 방식: ${DEPLOYMENT_LABEL[model.deployment]} · 데이터 처리 위치: ${model.dataLocation}`,
    `게이트웨이 처리: 프로젝트 키 확인 → 모델 정책 확인(교육청 허용 ∩ 프로젝트 허용) → 개인정보 마스킹 ${piiMasked}건 → 프로젝트 예산·교사 상한 확인 → 모델로 전달`,
    `모델에 전달된 프롬프트(마스킹 후, 앞 200자): "${excerpt}"`,
    "실제 모델을 연결하면(v1.0) 이 자리에 모델의 응답이 표시됩니다.",
  ].join("\n");
};

function providerFor(model: AiModel): ProviderAdapter {
  void model; // v1.0: 모델별 어댑터 선택 (위 확장 지점 참고)
  return mockProvider;
}

function budgetWarnings(project: Project, projectUsed: number, teacherUsed: number): string[] {
  const out: string[] = [];
  const pp = Math.floor((projectUsed / project.monthlyTokenBudget) * 100);
  if (pp >= BUDGET_ALERT_PCT) out.push(`프로젝트 월 예산의 ${pp}%를 썼습니다(${n(projectUsed)} / ${n(project.monthlyTokenBudget)}토큰).`);
  const tp = Math.floor((teacherUsed / TEACHER_MONTHLY_CAP) * 100);
  if (tp >= BUDGET_ALERT_PCT) out.push(`교사 전체 상한의 ${tp}%를 썼습니다(${n(teacherUsed)} / ${n(TEACHER_MONTHLY_CAP)}토큰).`);
  return out;
}

/**
 * 게이트웨이 호출. 순서: (a) 키·프로젝트·모델 정책 → (b) 프롬프트 검증 → (c) 개인정보 마스킹(전달 전)
 * → (d) 프로젝트 예산·교사 전체 상한 → (e) 모델 호출(모의) → (f) 잠금 안에서 다시 확인 후 사용 기록(projectId·keyId).
 */
export async function gatewayCall(input: GatewayInput): Promise<GatewayResult> {
  // (a) 스냅샷으로 먼저 확인해 실패 요청은 저장소에 쓰지 않는다.
  const snapshot = await readDb();
  const pre = checkAccess(snapshot, input);
  if (!pre.ok) return pre;

  // (b)
  const prompt = typeof input.prompt === "string" ? normalizeNewlines(input.prompt) : "";
  if (!prompt.trim()) return fail("invalid_request", "프롬프트를 입력하십시오.", undefined, pre.project.id);
  if (prompt.length > PROMPT_MAX_CHARS) {
    return fail("invalid_request", `프롬프트는 ${n(PROMPT_MAX_CHARS)}자 이하로 입력하십시오.`, undefined, pre.project.id);
  }

  // (c) PRD 2-⑤: 프롬프트의 개인정보는 모델로 보내기 전에 가린다.
  const masked = maskPII(prompt);

  // (d) 입력 토큰만으로도 넘으면 호출하지 않는다.
  const inputTokens = estimateTokens(masked.text);
  const preBudget = checkBudget(snapshot, pre, inputTokens);
  if ("ok" in preBudget) return preBudget;

  // (e) 모델 호출(잠금 밖). 프로토타입은 모의 응답.
  const output = await providerFor(pre.model)({
    model: pre.model,
    maskedPrompt: masked.text,
    piiMasked: masked.count,
  });
  const tokens = inputTokens + estimateTokens(output);

  // (f) 잠금 안에서 키·정책·한도를 다시 확인하고 기록한다(호출 중 정책이 바뀌었거나 동시 호출이 있었을 수 있다).
  return mutate((db): GatewayResult => {
    migrateLegacyKeys(db);
    const again = checkAccess(db, input);
    if (!again.ok) return again;
    const budget = checkBudget(db, again, tokens);
    if ("ok" in budget) return budget;
    db.usage.push({
      id: newId("use"),
      projectId: again.project.id,
      keyId: again.key.id,
      userId: again.owner.id,
      modelId: again.model.id,
      tokens,
      piiMasked: masked.count,
      createdAt: nowIso(),
    });
    if (input.touchIp !== undefined) touchKeyIn(again.key, input.touchIp);
    const projectUsed = budget.projectUsed + tokens;
    const teacherUsed = budget.teacherUsed + tokens;
    return {
      ok: true,
      output,
      model: again.model.id,
      modelName: again.model.name,
      projectId: again.project.id,
      projectName: again.project.name,
      keyId: again.key.id,
      tokens,
      piiMasked: masked.count,
      piiLabels: masked.labels,
      remaining: Math.max(0, again.project.monthlyTokenBudget - projectUsed),
      quota: again.project.monthlyTokenBudget,
      teacherRemaining: Math.max(0, TEACHER_MONTHLY_CAP - teacherUsed),
      teacherCap: TEACHER_MONTHLY_CAP,
      warnings: budgetWarnings(again.project, projectUsed, teacherUsed),
      mock: true,
    };
  });
}

/* ---------- 모델 허용 정책 (F-23, F-24) ---------- */

function assertAdmin(user: User): void {
  if (user.role !== "admin") throw new AuthError("교육청 관리자만 사용할 수 있습니다.");
}

/**
 * 모델 상태를 바꾸고 감사 로그에 "<이전> -> <새 상태>: 사유"를 남긴다(F-24).
 * 교사 화면과 게이트웨이는 매 요청마다 저장소를 읽으므로 즉시 반영된다.
 */
export async function setModelStatus(
  admin: User,
  modelId: string,
  status: ModelStatus,
  reason: string,
): Promise<Result<AiModel>> {
  assertAdmin(admin);
  if (!isModelStatus(status)) return { ok: false, error: "상태는 허용·보류·차단 중 하나여야 합니다." };
  const trimmed = (reason ?? "").trim();
  if (trimmed.length > 200) return { ok: false, error: "사유는 200자 이하로 입력하십시오." };
  const safeReason = maskPII(trimmed).text || "사유 미기재";

  return mutate((db): Result<AiModel> => {
    const model = db.models.find((m) => m.id === modelId);
    if (!model) return { ok: false, error: "모델을 찾을 수 없습니다." };
    if (model.status === status) {
      return { ok: false, error: `이미 '${MODEL_STATUS_LABEL[status]}' 상태입니다.` };
    }
    const before = model.status;
    model.status = status;
    model.updatedAt = nowIso();
    ensureUser(db, admin);
    writeAudit(
      db,
      admin,
      "model.status",
      model.id,
      `${MODEL_STATUS_LABEL[before]} -> ${MODEL_STATUS_LABEL[status]}: ${safeReason}`,
    );
    return { ok: true, value: { ...model } };
  });
}

export type NewModelInput = {
  id: string;
  name: string;
  provider: string;
  origin: string;
  deployment: ModelDeployment;
  dataLocation: string;
  recommendedUse: string;
};

const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/;

type ModelGuideFields = Omit<NewModelInput, "id">;

/** 모델 가이드 항목 검증·마스킹(F-22). 길이를 먼저 확인한 뒤 마스킹한다. */
function cleanGuideFields(
  fields: ModelGuideFields,
): { ok: true; value: ModelGuideFields } | { ok: false; error: string } {
  if (!isDeployment(fields.deployment)) return { ok: false, error: "실행 방식을 선택하십시오." };
  const raw = {
    name: fields.name.trim(),
    provider: fields.provider.trim(),
    origin: fields.origin.trim(),
    dataLocation: fields.dataLocation.trim(),
    recommendedUse: fields.recommendedUse.trim(),
  };
  if (!raw.name || !raw.provider || !raw.origin || !raw.dataLocation || !raw.recommendedUse) {
    return { ok: false, error: "모든 항목을 입력하십시오." };
  }
  if ([raw.name, raw.provider, raw.origin, raw.dataLocation].some((s) => s.length > 60)) {
    return { ok: false, error: "모델 이름·제공사·개발 국가·데이터 처리 위치는 60자 이하로 입력하십시오." };
  }
  if (raw.recommendedUse.length > 200) return { ok: false, error: "권장 용도는 200자 이하로 입력하십시오." };
  const v = maskFields(raw).values;
  return { ok: true, value: { ...v, deployment: fields.deployment } };
}

/** 모델을 추가한다. 신규 모델의 기본 상태는 항상 '보류'다(F-23). */
export async function addModel(admin: User, fields: NewModelInput): Promise<Result<AiModel>> {
  assertAdmin(admin);
  const id = fields.id.trim();
  if (!MODEL_ID_RE.test(id)) {
    return {
      ok: false,
      error: "모델 id는 영문 소문자·숫자·점·밑줄·하이픈으로 2~40자로 입력하십시오(예: solar-pro).",
    };
  }
  // 모델 id는 교사 화면과 API에 그대로 보이므로 가리지 않고 거절한다.
  if (hasPII(id)) return { ok: false, error: "모델 id에 전화번호 등 개인정보로 보이는 값이 있습니다." };
  const cleaned = cleanGuideFields(fields);
  if (!cleaned.ok) return cleaned;
  const v = cleaned.value;

  return mutate((db): Result<AiModel> => {
    if (db.models.some((m) => m.id === id)) {
      return { ok: false, error: `'${id}' 모델 id가 이미 있습니다.` };
    }
    const model: AiModel = {
      id,
      name: v.name,
      provider: v.provider,
      origin: v.origin,
      deployment: v.deployment,
      dataLocation: v.dataLocation,
      recommendedUse: v.recommendedUse,
      status: "pending",
      updatedAt: nowIso(),
    };
    db.models.push(model);
    ensureUser(db, admin);
    writeAudit(db, admin, "model.add", model.id, `${model.name} 추가(기본 상태 보류)`);
    return { ok: true, value: { ...model } };
  });
}

/** 모델 가이드 내용 수정(F-22: 가이드 내용은 교육청 관리자가 입력·승인한다). 상태는 바꾸지 않는다. */
export async function updateModelGuide(
  admin: User,
  modelId: string,
  fields: ModelGuideFields,
): Promise<Result<AiModel>> {
  assertAdmin(admin);
  const cleaned = cleanGuideFields(fields);
  if (!cleaned.ok) return cleaned;
  const v = cleaned.value;
  return mutate((db): Result<AiModel> => {
    const model = db.models.find((m) => m.id === modelId);
    if (!model) return { ok: false, error: "모델을 찾을 수 없습니다." };
    const changed = (Object.keys(v) as (keyof ModelGuideFields)[]).filter((k) => model[k] !== v[k]);
    if (changed.length === 0) return { ok: false, error: "바뀐 내용이 없습니다." };
    Object.assign(model, v, { updatedAt: nowIso() });
    ensureUser(db, admin);
    writeAudit(db, admin, "model.guide", model.id, `가이드 수정: ${changed.join(", ")}`);
    return { ok: true, value: { ...model } };
  });
}
