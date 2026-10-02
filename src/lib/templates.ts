import "server-only";
import type { Result } from "./apps";
import { isAppCategory, isSchoolLevel } from "./constants";
import { mutate, newId, nowIso, readDb } from "./db";
import { maskFields } from "./pii";
import { normalizeNewlines, urlHasPII } from "./text";
import { displayName, ensureUser, isTeacher, writeAudit } from "./session";
import type { AppCategory, SchoolLevel, Template, User } from "./types";

// 작업 지시서·예시 템플릿 도메인 로직(F-09, F-10).
// 저장소를 Supabase로 옮길 때는 이 파일의 함수만 바꾸면 된다.

export interface NewTemplateInput {
  title: string;
  summary: string;
  category: AppCategory;
  schoolLevels: SchoolLevel[];
  workOrder: string;
  exampleUrl: string;
}

export const TEMPLATE_LIMITS = {
  title: 80,
  summary: 300,
  workOrder: 20_000,
  exampleUrl: 500,
} as const;

export async function listTemplates(
  filter: { level?: SchoolLevel; category?: AppCategory } = {},
): Promise<Template[]> {
  const db = await readDb();
  return db.templates
    .filter((t) => !filter.level || t.schoolLevels.includes(filter.level))
    .filter((t) => !filter.category || t.category === filter.category)
    .sort((a, b) => b.copies - a.copies || b.createdAt.localeCompare(a.createdAt));
}

export async function getTemplate(id: string): Promise<Template | null> {
  const db = await readDb();
  return db.templates.find((t) => t.id === id) ?? null;
}

/** 예시 사이트 주소는 http(s) 주소이거나 허브에 포함된 /examples/*.html 이어야 한다. */
export function isAllowedExampleUrl(url: string): boolean {
  if (url.startsWith("/")) return /^\/examples\/[A-Za-z0-9._-]+\.html$/.test(url) && !url.includes("..");
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function validateNewTemplate(input: NewTemplateInput): string | null {
  const title = input.title.trim();
  if (!title) return "템플릿 이름을 입력하십시오.";
  if (title.length > TEMPLATE_LIMITS.title) return `템플릿 이름은 ${TEMPLATE_LIMITS.title}자 이하로 입력하십시오.`;
  const summary = input.summary.trim();
  if (!summary) return "한 줄 소개를 입력하십시오.";
  if (summary.length > TEMPLATE_LIMITS.summary) return `한 줄 소개는 ${TEMPLATE_LIMITS.summary}자 이하로 입력하십시오.`;
  if (!isAppCategory(input.category)) return "분류를 선택하십시오.";
  if (input.schoolLevels.length === 0) return "학교급을 하나 이상 선택하십시오.";
  if (!input.schoolLevels.every(isSchoolLevel)) return "알 수 없는 학교급이 있습니다.";
  const workOrder = normalizeNewlines(input.workOrder).trim();
  if (workOrder.length < 20) return "작업 지시서를 20자 이상 입력하십시오.";
  if (workOrder.length > TEMPLATE_LIMITS.workOrder) {
    return `작업 지시서는 ${TEMPLATE_LIMITS.workOrder.toLocaleString("ko-KR")}자 이하로 입력하십시오.`;
  }
  const exampleUrl = input.exampleUrl.trim();
  if (exampleUrl.length > TEMPLATE_LIMITS.exampleUrl) return "예시 사이트 주소가 너무 깁니다.";
  if (!isAllowedExampleUrl(exampleUrl)) {
    return "예시 사이트 주소는 http(s)로 시작하거나 /examples/파일이름.html 형식이어야 합니다.";
  }
  if (urlHasPII(exampleUrl)) {
    return "예시 사이트 주소에 개인정보(전화번호·이메일 등)로 보이는 값이 있습니다. 개인정보가 없는 주소를 입력하십시오.";
  }
  return null;
}

/** 새 템플릿 등록(F-10). 교사만 등록할 수 있고, 자유 입력은 저장 전에 서버 마스킹(F-14)을 거친다. */
export async function createTemplate(
  input: NewTemplateInput,
  author: User,
): Promise<Result<Template> & { masked?: number }> {
  if (!isTeacher(author)) return { ok: false, error: "교사 로그인이 필요합니다." };
  const error = validateNewTemplate(input);
  if (error) return { ok: false, error };

  const masked = maskFields({
    title: input.title.trim(),
    summary: input.summary.trim(),
    workOrder: normalizeNewlines(input.workOrder).trim(),
  });

  const template: Template = {
    id: newId("tpl"),
    title: masked.values.title,
    summary: masked.values.summary,
    category: input.category,
    schoolLevels: [...new Set(input.schoolLevels)],
    workOrder: masked.values.workOrder,
    exampleUrl: input.exampleUrl.trim(),
    authorId: author.id,
    authorName: displayName(author),
    copies: 0,
    createdAt: nowIso(),
  };

  await mutate((db) => {
    ensureUser(db, author);
    db.templates.push(template);
    writeAudit(
      db,
      author,
      "template.create",
      template.id,
      masked.count ? `개인정보 ${masked.count}건 마스킹(${masked.labels.join(", ")})` : "",
    );
  });
  return { ok: true, value: template, masked: masked.count };
}

/** 작업 지시서 복사 수 집계(성공 지표: 템플릿 복사 수 대비 신규 앱 등록 수). */
export async function incrementCopies(id: string): Promise<number | null> {
  return mutate((db) => {
    const t = db.templates.find((x) => x.id === id);
    if (!t) return null;
    t.copies += 1;
    return t.copies;
  });
}
