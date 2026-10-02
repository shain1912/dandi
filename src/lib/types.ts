// 공통 도메인 타입. 저장소를 Supabase로 옮길 때 테이블 스키마의 기준이 된다.

export type Role = "anon" | "teacher" | "admin";
export type SchoolLevel = "elem" | "middle" | "high" | "special";
/** 게시글·자료처럼 학교급 전체를 대상으로 할 수 있는 콘텐츠용 */
export type LevelOrAll = SchoolLevel | "all";

export interface User {
  id: string; // 공개 id. 로그인 계정은 무작위(u_...), 익명 방문자는 세션 값의 해시(session.ts userIdForSession).
  role: Role;
  name: string | null;
  schoolLevel: SchoolLevel | null;
  createdAt: string;
}

/* ---------- 미니앱 (F-04 ~ F-06, F-16) ---------- */

export type AppCategory = "class" | "work" | "guidance" | "etc";

export interface PrivacyCheck {
  collectsStudentData: boolean; // 학생 개인정보를 수집·처리하는가
  storageLocation: string; // 저장 위치 (예: "저장 안 함", "Supabase(서울 리전)")
  retention: string; // 보관 기간
  externalTransfer: boolean; // 외부(해외 AI API 등)로 전송하는가
  needsSchoolApproval: boolean; // 학교 내부 승인(운영위원회 등)이 필요한가
  checkedAt: string;
}

/**
 * 학교 내부 승인 상태(F-16). 셀프점검에서 "학교 내부 승인 필요"로 답한 앱은 "pending"으로 등록되어
 * 승인 완료 표시 전까지 허브 목록과 무로그인 실행에서 빠진다.
 */
export type ApprovalStatus = "not_required" | "pending" | "approved";

export interface MiniApp {
  id: string;
  /** 연결된 프로젝트(F-31). 없으면 교사의 기본 프로젝트로 본다 */
  projectId?: string | null;
  title: string;
  description: string;
  url: string;
  schoolLevels: SchoolLevel[];
  category: AppCategory;
  handlesPersonalData: boolean;
  privacyCheck: PrivacyCheck;
  approvalStatus: ApprovalStatus;
  approvedAt: string | null;
  approvedByName: string | null;
  authorId: string;
  authorName: string;
  runs: number;
  createdAt: string;
}

export interface NewAppInput {
  projectId?: string | null;
  title: string;
  description: string;
  url: string;
  schoolLevels: SchoolLevel[];
  category: AppCategory;
  privacyCheck: Omit<PrivacyCheck, "checkedAt">;
}

/* ---------- 커뮤니티 (F-07) ---------- */

export type PostCategory = "material" | "question" | "info" | "free";

export interface Post {
  id: string;
  title: string;
  body: string;
  category: PostCategory;
  schoolLevel: LevelOrAll;
  authorId: string;
  authorName: string;
  maskedCount: number; // 서버 마스킹으로 가려진 개인정보 개수
  createdAt: string;
}

export interface Comment {
  id: string;
  postId: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

export interface Like {
  postId: string;
  userId: string;
}

/* ---------- 자료실 (F-08) ---------- */

export interface FileItem {
  id: string;
  title: string;
  description: string;
  originalName: string;
  storedName: string; // data/uploads 안의 파일 이름
  size: number;
  mime: string;
  ext: string;
  schoolLevel: LevelOrAll;
  downloads: number;
  authorId: string;
  authorName: string;
  createdAt: string;
}

/* ---------- 템플릿 (F-09, F-10) ---------- */

export interface Template {
  id: string;
  title: string;
  summary: string;
  category: AppCategory;
  schoolLevels: SchoolLevel[];
  workOrder: string; // 작업 지시서 본문(마크다운)
  exampleUrl: string; // 예시 사이트
  authorId: string;
  authorName: string;
  copies: number;
  createdAt: string;
}

/* ---------- AI 게이트웨이 (F-20 ~ F-24) ---------- */

export type ModelStatus = "allowed" | "pending" | "blocked";
export type ModelDeployment = "api" | "local";

export interface AiModel {
  id: string; // 게이트웨이 호출 시 사용하는 모델 id
  name: string;
  provider: string;
  origin: string; // 개발 주체 국가
  deployment: ModelDeployment;
  dataLocation: string; // 프롬프트가 처리되는 위치
  recommendedUse: string;
  status: ModelStatus;
  updatedAt: string;
}

/* ---------- 프로젝트와 프로젝트 API 키 (F-31 ~ F-35, Edge Impulse 방식) ---------- */

export interface Project {
  id: string;
  name: string;
  description: string;
  ownerUserId: string;
  /** 프로젝트 허용 모델(F-34). null이면 교육청 허용 모델 전체. 실제 호출 가능 = 교육청 허용 ∩ 이 목록 */
  modelIds: string[] | null;
  monthlyTokenBudget: number; // 월 예산(필수, F-33)
  status: "active" | "archived";
  createdAt: string;
}

/** admin: 키·설정 관리까지 / inference: 게이트웨이 호출만 / readonly: 사용량·설정 조회만 */
export type ProjectKeyRole = "admin" | "inference" | "readonly";

export interface ProjectApiKey {
  id: string;
  projectId: string;
  name: string;
  role: ProjectKeyRole;
  keyHash: string; // 원문은 저장하지 않는다
  prefix: string; // 화면 힌트 앞부분 (예: "dd_sk_ab12")
  last4: string; // 화면 힌트 뒷부분
  createdByUserId: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  disabledAt: string | null; // 비활성화(복구 가능)
  deletedAt: string | null; // 삭제(영구)
}

export interface UsageRecord {
  id: string;
  projectId: string;
  keyId: string;
  userId: string; // 프로젝트 소유 교사(교사 전체 상한 집계용)
  modelId: string;
  tokens: number;
  piiMasked: number;
  createdAt: string;
}

/* ---------- 허브 정적 호스팅 (F-51, F-52) ---------- */

export interface SiteFile {
  path: string; // 사이트 루트 기준 상대 경로 (예: "index.html", "assets/app.js")
  size: number;
  sha256: string; // 내용 해시. 파일 본문은 data/blobs/<sha256>에 한 번만 저장한다
  contentType: string;
}

export interface Site {
  id: string;
  slug: string; // 사이트 주소의 이름 부분 (소문자·숫자·하이픈)
  projectId: string;
  ownerUserId: string;
  title: string;
  /** 공개(live) 주소가 가리키는 배포. publish 전에는 null */
  liveDeployId: string | null;
  /**
   * 승인된 앱의 새 버전이 학교 내부 승인을 다시 기다리는 동안의 배포. 승인되면 liveDeployId로 옮긴다.
   * 그동안 공개 주소는 이전에 승인된 liveDeployId를 계속 보여 준다(수업 중 앱이 멈추지 않게).
   */
  pendingDeployId?: string | null;
  /** 허브에 등록된 미니앱(F-04). publish 전에는 null */
  appId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SiteDeploy {
  id: string;
  siteId: string;
  /** 미리보기 주소용 무작위 토큰. 추측할 수 없어 링크를 아는 사람만 본다 */
  previewToken: string;
  status: "uploading" | "ready";
  files: SiteFile[];
  totalBytes: number;
  createdByUserId: string;
  createdAt: string;
  finalizedAt: string | null;
}

/* ---------- CLI 브라우저 승인 로그인 (F-53, device code) ---------- */

export interface DeviceAuth {
  id: string;
  deviceCodeHash: string;
  userCode: string; // "WDJB-MJHT" 형식, 대문자로 저장
  client: string; // 요청한 에이전트·도구 (예: "claude-code", "terminal")
  hostname: string;
  os: string;
  ip: string;
  status: "pending" | "approved" | "denied" | "consumed";
  userId: string | null; // 승인한 교사
  createdAt: string;
  expiresAt: string;
  lastPolledAt: string | null;
}

/* ---------- 원격 MCP용 OAuth (F-57) ---------- */

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
}

export interface OAuthCode {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string; // PKCE S256
  scope: string;
  resource: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface OAuthToken {
  id: string;
  kind: "access" | "refresh";
  tokenHash: string;
  clientId: string;
  userId: string;
  scope: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** 갱신 토큰을 교체한 시각. 교체 직후 같은 토큰이 다시 오면(동시 요청·응답 유실) 잠시 후속 토큰을 돌려준다 */
  rotatedAt?: string | null;
  /** 교체로 새로 발급한 토큰 id */
  successorIds?: { access: string; refresh: string } | null;
}

/* ---------- 스킬 레지스트리 (F-37 ~ F-41, skills.sh 방식) ---------- */

export type SkillReviewStatus = "approved" | "pending_review" | "rejected" | "hidden";

export interface SkillVersion {
  version: string; // semver (예: "1.0.0")
  files: SiteFile[]; // 스킬 폴더 안의 파일(본문은 data/blobs)
  digest: string; // 설치용 압축 파일의 "sha256:<hex>"
  hasScripts: boolean; // scripts/·훅·셸 실행 포함 여부(F-40)
  findings: string[]; // 정적 검토에서 찾은 문제
  status: SkillReviewStatus;
  reviewedByName: string | null;
  createdAt: string;
}

export interface Skill {
  name: string; // SKILL.md name: 소문자·숫자·하이픈 64자 이하, 고유
  title: string; // 한국어 제목(metadata.title 또는 입력값)
  description: string;
  license: string;
  schoolLevels: SchoolLevel[];
  compatibility: string[]; // "claude-code" | "cursor" | "codex" | ...
  authorId: string;
  authorName: string;
  installs: number;
  latestVersion: string;
  versions: SkillVersion[];
  createdAt: string;
  updatedAt: string;
}

/* ---------- 전자책 서가 (F-43 ~ F-45) ---------- */

export interface BookTocItem {
  title: string;
  href: string; // 웹북: 책 주소 기준 절대 URL / PDF: "#page=N"
  depth: number;
}

export interface Book {
  id: string;
  title: string;
  summary: string;
  authorName: string;
  ownerUserId: string;
  kind: "webbook" | "pdf";
  baseUrl: string | null; // 웹북 주소
  fileId: string | null; // PDF: 자료실 파일(F-08)
  coverUrl: string | null;
  schoolLevel: LevelOrAll;
  license: string;
  visibility: "public" | "teachers";
  containsThirdPartyWorks: boolean; // F-45 저작권 게이트
  toc: BookTocItem[];
  viewCount: number;
  createdAt: string;
  updatedAt: string;
}

/* ---------- CLI (F-17, F-18) ---------- */

export interface CliToken {
  id: string;
  userId: string;
  tokenHash: string;
  tokenPrefix: string;
  /** 교사가 기기를 구분하는 이름(예: "Claude Code · 김교사-노트북 · Windows"). 브라우저 승인 로그인 때 채운다 */
  label?: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/* ---------- 로그인 세션 (F-01, F-02 대체) ---------- */

/** 로그인 세션. 쿠키(dd_sid)의 해시만 저장하며, 로그아웃하면 revokedAt을 채워 더 이상 쓰지 못하게 한다. */
export interface LoginSession {
  sidHash: string;
  userId: string;
  createdAt: string;
  revokedAt: string | null;
}

/* ---------- 감사 로그 (F-24, 비기능 요구사항) ---------- */

export interface AuditEntry {
  id: string;
  actorId: string;
  actorName: string;
  action: string; // 예: "model.status", "apikey.issue", "file.upload"
  target: string;
  detail: string;
  createdAt: string;
}

export interface DB {
  users: User[];
  apps: MiniApp[];
  posts: Post[];
  comments: Comment[];
  likes: Like[];
  files: FileItem[];
  templates: Template[];
  models: AiModel[];
  projects: Project[];
  projectKeys: ProjectApiKey[];
  usage: UsageRecord[];
  cliTokens: CliToken[];
  sessions: LoginSession[];
  sites: Site[];
  siteDeploys: SiteDeploy[];
  deviceAuths: DeviceAuth[];
  oauthClients: OAuthClient[];
  oauthCodes: OAuthCode[];
  oauthTokens: OAuthToken[];
  skills: Skill[];
  books: Book[];
  audit: AuditEntry[];
}
