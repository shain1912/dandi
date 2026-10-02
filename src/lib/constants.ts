import type {
  AppCategory,
  LevelOrAll,
  ModelStatus,
  PostCategory,
  SchoolLevel,
} from "./types";

export const SCHOOL_LEVELS: { id: SchoolLevel; label: string }[] = [
  { id: "elem", label: "초" },
  { id: "middle", label: "중" },
  { id: "high", label: "고" },
  { id: "special", label: "특수" },
];

export function levelLabel(level: LevelOrAll | null | undefined): string {
  if (!level || level === "all") return "전체";
  return SCHOOL_LEVELS.find((l) => l.id === level)?.label ?? level;
}

export function isSchoolLevel(value: unknown): value is SchoolLevel {
  return SCHOOL_LEVELS.some((l) => l.id === value);
}

export function isLevelOrAll(value: unknown): value is LevelOrAll {
  return value === "all" || isSchoolLevel(value);
}

export const APP_CATEGORIES: { id: AppCategory; label: string }[] = [
  { id: "class", label: "수업" },
  { id: "work", label: "업무" },
  { id: "guidance", label: "학생지도" },
  { id: "etc", label: "기타" },
];

export function appCategoryLabel(id: AppCategory): string {
  return APP_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

export function isAppCategory(value: unknown): value is AppCategory {
  return APP_CATEGORIES.some((c) => c.id === value);
}

export const POST_CATEGORIES: { id: PostCategory; label: string }[] = [
  { id: "material", label: "강의 자료" },
  { id: "question", label: "질문" },
  { id: "info", label: "정보 공유" },
  { id: "free", label: "자유" },
];

export function postCategoryLabel(id: PostCategory): string {
  return POST_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

export function isPostCategory(value: unknown): value is PostCategory {
  return POST_CATEGORIES.some((c) => c.id === value);
}

export const MODEL_STATUS_LABEL: Record<ModelStatus, string> = {
  allowed: "허용",
  pending: "보류",
  blocked: "차단",
};

/** 자료실 업로드 허용 확장자와 최대 크기 (F-08) */
export const UPLOAD_ALLOWED_EXT = [
  "exe",
  "apk",
  "zip",
  "pdf",
  "hwp",
  "hwpx",
  "pptx",
  "xlsx",
  "docx",
  "txt",
  "md",
];
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

/** 교사 1인당 월 무상 토큰 한도 (PRD Q3: 프로토타입 가정값) */
export const DEFAULT_MONTHLY_QUOTA = 100_000;

export const SESSION_COOKIE = "dd_sid";
