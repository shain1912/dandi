import { SEED_BOOKS } from "./seed-books";
import { SEED_SKILLS } from "./seed-skills";
import { SEED_TEMPLATES } from "./seed-templates";
import type { AiModel, DB, MiniApp, Post, User } from "./types";

// 처음 실행할 때 data/db.json에 넣는 시연용 데이터.
// 모델 허용 상태는 시연용 값이며 교육청 정책이 아니다(PRD Q1).

const T0 = "2026-09-28T00:00:00.000Z";

const SEED_USERS: User[] = [
  { id: "seed_teacher", role: "teacher", name: "데모 교사", schoolLevel: "middle", createdAt: T0 },
  { id: "seed_admin", role: "admin", name: "교육청 관리자(데모)", schoolLevel: null, createdAt: T0 },
];

const noPersonalData = {
  collectsStudentData: false,
  storageLocation: "저장 안 함(브라우저 안에서만 동작)",
  retention: "해당 없음",
  externalTransfer: false,
  needsSchoolApproval: false,
  checkedAt: T0,
};

const SEED_APPS: MiniApp[] = [
  {
    id: "app_seed_quiz",
    title: "OX 퀴즈 미니앱",
    description: "문항을 넣으면 바로 풀 수 있는 OX 퀴즈. 로그인 없이 실행됩니다.",
    url: "/examples/quiz.html",
    schoolLevels: ["elem", "middle"],
    category: "class",
    handlesPersonalData: false,
    privacyCheck: noPersonalData,
    approvalStatus: "not_required",
    approvedAt: null,
    approvedByName: null,
    authorId: "seed_teacher",
    authorName: "데모 교사",
    runs: 12,
    createdAt: T0,
  },
  {
    id: "app_seed_timetable",
    title: "시간표 변동 알림판",
    description: "일과계가 바꾼 시간표 변동을 전체 교사가 한 화면에서 확인하는 업무 앱 예시.",
    url: "/examples/timetable.html",
    schoolLevels: ["middle", "high"],
    category: "work",
    handlesPersonalData: false,
    privacyCheck: noPersonalData,
    approvalStatus: "not_required",
    approvedAt: null,
    approvedByName: null,
    authorId: "seed_teacher",
    authorName: "데모 교사",
    runs: 7,
    createdAt: T0,
  },
  {
    id: "app_seed_docgen",
    title: "업무 문서 초안 생성기",
    description: "교과서 선정 등 반복 업무 문서의 초안을 양식에 맞춰 만들어 주는 예시.",
    url: "/examples/doc-generator.html",
    schoolLevels: ["high"],
    category: "work",
    handlesPersonalData: false,
    privacyCheck: noPersonalData,
    approvalStatus: "not_required",
    approvedAt: null,
    approvedByName: null,
    authorId: "seed_teacher",
    authorName: "데모 교사",
    runs: 4,
    createdAt: T0,
  },
];

const SEED_POSTS: Post[] = [
  {
    id: "post_seed_welcome",
    title: "Dandi 프로토타입에 오신 것을 환영합니다",
    body: "미니앱을 등록하고, 작업 지시서를 복사해 직접 만들어 보시기 바랍니다. 글에 전화번호나 주민등록번호를 적으면 자동으로 가려집니다.",
    category: "info",
    schoolLevel: "all",
    authorId: "seed_admin",
    authorName: "교육청 관리자(데모)",
    maskedCount: 0,
    createdAt: T0,
  },
  {
    id: "post_seed_question",
    title: "학생 정보를 다루는 앱은 어떻게 공개하나요?",
    body: "학생지도 앱을 만들었는데 공개 전에 무엇을 확인해야 할지 궁금합니다.",
    category: "question",
    schoolLevel: "high",
    authorId: "seed_teacher",
    authorName: "데모 교사",
    maskedCount: 0,
    createdAt: T0,
  },
];

const m = (
  id: string,
  name: string,
  provider: string,
  origin: string,
  deployment: AiModel["deployment"],
  dataLocation: string,
  recommendedUse: string,
  status: AiModel["status"],
): AiModel => ({ id, name, provider, origin, deployment, dataLocation, recommendedUse, status, updatedAt: T0 });

const SEED_MODELS: AiModel[] = [
  m("claude", "Claude", "Anthropic", "미국", "api", "미국(해외 API)", "데이터 이해·분석, 긴 문서 요약, 코드 작성", "allowed"),
  m("gpt", "GPT", "OpenAI", "미국", "api", "미국(해외 API)", "데이터 이해·분석, 범용 대화", "allowed"),
  m("gemini", "Gemini", "Google", "미국", "api", "미국(해외 API)", "데이터 이해·분석, 이미지 이해", "allowed"),
  m("hyperclova-x", "HyperCLOVA X", "NAVER", "대한민국", "api", "국내", "한국어 문서 작성, 업무 자동화", "pending"),
  m("deepseek", "DeepSeek", "DeepSeek", "중국", "api", "중국(해외 API)", "단순 자동화", "pending"),
  m("exaone-local", "EXAONE (로컬)", "LG AI연구원", "대한민국", "local", "교내·교육청 서버", "온프레미스 한국어 처리", "pending"),
  m("qwen-local", "Qwen (로컬)", "Alibaba", "중국", "local", "교내·교육청 서버", "온프레미스 단순 자동화", "pending"),
];

export function buildSeed(): DB {
  return {
    users: structuredClone(SEED_USERS),
    apps: structuredClone(SEED_APPS),
    posts: structuredClone(SEED_POSTS),
    comments: [],
    likes: [],
    files: [],
    templates: structuredClone(SEED_TEMPLATES),
    models: structuredClone(SEED_MODELS),
    projects: [],
    projectKeys: [],
    usage: [],
    cliTokens: [],
    sessions: [],
    sites: [],
    siteDeploys: [],
    deviceAuths: [],
    oauthClients: [],
    oauthCodes: [],
    oauthTokens: [],
    skills: structuredClone(SEED_SKILLS),
    books: structuredClone(SEED_BOOKS),
    audit: [],
  };
}
