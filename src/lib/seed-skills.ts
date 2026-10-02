import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import type { SchoolLevel, SiteFile, Skill } from "./types";

// 스킬 레지스트리 시드(F-37). 모두 프롬프트만 있는 스킬이라 자동 검토를 통과한 상태로 넣는다.
// 파일 본문과 설치용 압축 파일은 여기서 만들어 SEED_SKILL_BLOBS에 두고, skills.ts가 처음 읽을 때
// data/blobs/<sha256>에 기록한다(저장소 파일을 새로 만들 때 blob 폴더를 따로 준비하지 않아도 된다).
// 이 파일은 db.ts → seed.ts에서 불리므로 db.ts·skills.ts를 import하지 않는다(순환 방지).

const T0 = "2026-09-28T00:00:00.000Z";
/** dandi-deploy 1.1.0(허브 주소·CLI 명령을 내보낼 때 넣는 템플릿)을 만든 시각 */
const T1 = "2026-09-28T12:00:00.000Z";
/** dandi-deploy 1.2.0(셸별 npx, 통일된 비밀값 안내, 게시 결과·계정 확인)을 만든 시각 */
const T2 = "2026-09-29T00:00:00.000Z";
/** dandi-deploy 1.3.0(묻지 않고 바로 올리기, 요청에 적은 답 사용, Codex·Antigravity·Grok 안내)을 만든 시각 */
const T3 = "2026-09-29T09:00:00.000Z";
/** dandi-deploy 1.3.1(로그인 승인을 같은 차례에서 기다리기)을 만든 시각 */
const T4 = "2026-09-29T12:00:00.000Z";

/**
 * 내보낼 때 바꾸는 자리표시. {{HUB}} → 요청한 허브 주소(예: http://localhost:3100),
 * {{CLI}} → 그 허브의 CLI 실행 접두어(예: npx -y http://localhost:3100/dandi-0.2.0-1a2b3c4d.tgz).
 * 저장소에는 자리표시가 든 템플릿을 두고, skills.ts가 설치 index·압축 파일·SKILL.md를 내보낼 때 허브별로 렌더링한다.
 */
const TEMPLATE_RE = /\{\{(?:HUB|CLI)\}\}/;

export function renderSkillTemplate(text: string, ctx: { hub: string; cli: string }): string {
  return text.replace(/\{\{HUB\}\}/g, ctx.hub).replace(/\{\{CLI\}\}/g, ctx.cli);
}

/**
 * 스킬 폴더를 설치용 zip으로 묶는다(Agent Skills Discovery v0.2.0의 archive).
 * 같은 파일이면 언제나 같은 바이트가 나오도록 경로를 정렬하고 수정 시각을 고정한다.
 * fflate는 수정 시각을 서버의 지역 시각으로 기록하므로, 지역 시각 기준 날짜를 넘겨 시간대와 무관하게 만든다.
 * SKILL.md는 압축 파일의 최상위에 둔다(skills CLI가 루트 SKILL.md를 찾는다).
 */
export function buildSkillArchive(files: { path: string; bytes: Uint8Array }[]): Uint8Array {
  const mtime = new Date(2026, 0, 1, 0, 0, 0);
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    entries[f.path] = [f.bytes, { mtime }];
  }
  return zipSync(entries, { level: 6, mtime });
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface SeedDef {
  name: string;
  title: string;
  description: string;
  schoolLevels: SchoolLevel[];
  /** SKILL.md 본문(앞부분 제외) */
  body: string;
  /** SKILL.md 외 파일 */
  extra?: Record<string, string>;
  /** 시드 버전(기본 1.0.0). 내용을 고치면 올린다. 이미 만들어진 저장소에는 skills.ts가 새 버전으로 덧붙인다 */
  version?: string;
  createdAt?: string;
  /** 새 버전을 덧붙일 때 숨길 이전 시드 버전("버전@createdAt") */
  retire?: string[];
  /**
   * SKILL.md 앞부분의 compatibility 문장(기본 COMPAT_TEXT). 기본값을 바꾸면 이미 저장된 다른 시드의 파일 해시가
   * 달라지므로, 새 도구를 적을 때는 버전을 올리는 스킬에만 이 값을 준다.
   */
  compatibility?: string;
}

const COMPAT_TEXT = "Claude Code, Cursor, Codex 등 Agent Skills를 지원하는 AI 코딩 도구";
const ALL_LEVELS: SchoolLevel[] = ["elem", "middle", "high", "special"];

function skillMd(def: SeedDef): string {
  // 앞부분은 YAML이다. 값에 ": " 나 " #"이 들어가지 않게 쓴다(skills CLI가 yaml 패키지로 읽는다).
  return [
    "---",
    `name: ${def.name}`,
    `description: ${def.description}`,
    "license: CC-BY-4.0",
    `compatibility: ${def.compatibility ?? COMPAT_TEXT}`,
    "metadata:",
    `  title: ${def.title}`,
    `  version: "${def.version ?? "1.0.0"}"`,
    `  school-levels: ${def.schoolLevels.join(", ")}`,
    "  author: Dandi",
    "---",
    "",
    def.body.trim(),
    "",
  ].join("\n");
}

const DANDI_DEPLOY: SeedDef = {
  name: "dandi-deploy",
  title: "Dandi에 내 사이트 올리기",
  description:
    "교사가 만든 정적 웹사이트(미니앱) 폴더를 Dandi 허브에 올리고 등록합니다. 로그인 상태를 확인하고 필요하면 브라우저 승인으로 로그인한 뒤, 빌드 결과 폴더를 바로 비공개 미리보기로 올리고, 교사가 답한 등록 정보와 셀프점검 5문항으로 허브에 등록합니다. Use when the user asks to publish, deploy or upload a site, web app or mini app to Dandi or the Dandi hub, or pastes a Dandi llms.txt link. Triggers include Dandi에 올려줘, 단디에 올려줘, 내 사이트 올려줘, 이 폴더 허브에 올려줘, 허브에 등록해줘, 미니앱 공유해줘, publish to Dandi, deploy my site to the hub, upload this folder to Dandi, share my mini app.",
  schoolLevels: ALL_LEVELS,
  compatibility: "Claude Code, Cursor, Codex, Antigravity, Grok 등 Agent Skills를 지원하는 AI 코딩 도구",
  version: "1.3.1",
  createdAt: T4,
  // 1.0.0은 고정 허브 주소·옛 셀프점검 문구, 1.1.0은 셸 구분·비밀값 안내, 1.2.0은 바로 올리기 흐름(요청에 적은 답 사용),
  // 1.3.0은 로그인 대기를 같은 차례에서 이어 가라는 안내가 없어 숨긴다(Grok 시험에서 승인 링크만 보여 주고 끝남).
  retire: [`1.0.0@${T0}`, `1.1.0@${T1}`, `1.2.0@${T2}`, `1.3.0@${T3}`],
  // 셀프점검 문항·승인 규칙·비밀 키 안내는 src/lib/runbook.ts(PRIVACY_QUESTIONS, APPROVAL_RULE, secretGuidance)와 같은 원문이다
  // (tests/runbook.test.ts가 확인). 버전별 내용이 바뀌지 않도록 가져오지 않고 적어 둔다.
  body: `
# Dandi에 내 사이트 올리기

교사가 만든 정적 사이트(맨 위에 index.html이 있는 폴더)를 Dandi 허브에 올리고 미니앱으로 등록합니다. 허브가 제공하는 CLI를 설치 없이 npx로 실행하고, 명령은 모두 직접 실행합니다. 교사에게는 쉬운 한국어 합니다체로 말하고, 주소는 한 줄에 하나씩 고치지 않고 보여 줍니다.

## 준비

- 허브 주소: {{HUB}}
  이 스킬을 내려받은 허브입니다. 교사가 다른 Dandi 허브 주소를 주면 그 허브의 llms.txt를 따르고, 주소를 짐작해서 만들지 않습니다.
- 명령 앞부분: \`{{CLI}}\`
  아래 명령은 모두 이 앞부분으로 시작합니다. 그대로 복사해 실행합니다.
- 셸: Git Bash·macOS·Linux: npx / Windows PowerShell·cmd: npx.cmd 로 시작합니다. CLI가 알려 주는 next_step은 셸에 맞게 나오므로 그대로 실행합니다. PowerShell에서는 먼저 \`[Console]::OutputEncoding=[Text.Encoding]::UTF8\` 을 실행하고, JSON은 \`ConvertFrom-Json\` 으로 읽습니다.
- 모든 명령에 \`--json\` 을 붙입니다. 오류에는 hint와 다음 명령(next_step, 또는 채워서 쓸 next_step_template)이 함께 옵니다.
- 앞부분의 tgz 주소가 404로 실패하면 허브의 CLI가 바뀐 것입니다. {{HUB}}/llms.txt 에 적힌 새 앞부분을 쓰고(로컬 허브라 웹 읽기가 막히면 터미널에서 내려받습니다) 이 스킬도 다시 설치합니다. whoami 결과에 cli_update가 있으면 cli_update.prefix를 씁니다.
- 허브의 최신 절차가 필요하면 \`{{CLI}} guide\` 로 런북 원문을 읽습니다.

## 기본 흐름

1~4단계는 확인 질문 없이 바로 진행합니다.

1. 로그인 확인: \`{{CLI}} whoami --json\`
   종료 코드 0이면 3단계, 4이면 2단계로 갑니다.
2. 로그인(브라우저 승인): \`{{CLI}} login --hub {{HUB}} --json\`
   종료 코드 5와 "done":false가 나옵니다. verification_uri_complete를 한 줄에 그대로 보여 주고 "위 링크를 열고, 코드가 <user_code>와 같으면 [승인]을 누르십시오."라고 말합니다. 차례를 끝내지 말고 같은 차례에서 곧바로 next_step(login --wait --json)을 실행합니다. 이 명령이 최대 90초 동안 승인을 기다리므로, 백그라운드로 돌리거나 교사의 답을 기다리며 멈추지 않습니다. 0이면 3단계, 5이면 같은 명령을 다시 실행, 6(거부)이면 다시 로그인할지 교사에게 먼저 묻고, 7(만료)이면 2단계를 한 번만 다시 합니다.
3. 바로 올리기: package.json에 build 스크립트가 있으면 먼저 빌드합니다(예: npm run build). 그다음 \`{{CLI}} deploy --json\` 을 실행합니다.
   폴더를 적지 않으면 dandi.json의 outputDir, dist, build, out, 현재 폴더 순으로 맨 위에 index.html이 있는 곳을 고릅니다. package.json이 있는 프로젝트 폴더 자체는 올리지 않습니다. 교사가 폴더를 말했으면 \`{{CLI}} deploy "<폴더>" --json\` 처럼 적고, 어느 폴더가 사이트인지 알 수 없을 때만 묻습니다.
4. 미리보기: previewUrl을 한 줄에 보여 주고 "비공개 미리보기입니다. 아직 허브에 공개되지 않았습니다."라고 말합니다.
   - warnings에 개인정보로 보이는 값이 있으면 파일과 종류를 알리고, 실제 학생 정보라면 지운 뒤 다시 올릴지 묻습니다.
   - skipped에 파일이 있으면(한글·워드 문서 등) 이름을 알리고 허브 자료실({{HUB}}/files)에 올리거나 PDF로 바꾸도록 제안합니다.
   - \`notes\` 는 참고 사항입니다. 문제를 설명할 때만 말합니다.
5. 등록 정보와 셀프점검
   - 교사의 요청에 제목, 설명, 학교급, 분류, ①~⑤ 답이 이미 모두 있으면 그대로 쓰고 다시 묻지 않습니다.
   - 빠진 항목이 있으면 한 번의 메시지로 묻습니다. 코드를 보고 예상한 답을 적어 주되 교사가 하나씩 확인해야 합니다. "공개 전에 아래 항목에 직접 답해 주십시오."
   - 제목 / 한 줄 설명 / 학교급(초·중·고·특수) / 분류(수업·업무·학생지도·기타)
   - ① 학생 개인정보(이름, 학번, 연락처, 상담 기록 등)를 수집하거나 처리합니까? (예/아니요)
   - ② 데이터 저장 위치 (예: 저장 안 함(브라우저 안에서만 처리), Supabase(서울 리전))
   - ③ 보관 기간 (예: 저장 안 함, 학기 종료 시 삭제)
   - ④ 입력 내용을 외부 서비스(해외 AI API 등)로 보냅니까? (예/아니요)
   - ⑤ 학교 내부 승인(운영위원회 등)이 필요합니까? (예/아니요, ①이 "예"면 반드시 "예")
6. 기록과 등록: 답을 deploy 결과의 manifest가 가리키는 dandi.json에 UTF-8로 적습니다(siteId는 그대로 둡니다. PowerShell은 \`Set-Content -Encoding UTF8\`).
   title, description, schoolLevels(elem·middle·high·special), category(class·work·guidance·etc), privacyCheck(① collectsStudentData, ② storageLocation, ③ retention, ④ externalTransfer, ⑤ needsSchoolApproval. 예는 true, 아니요는 false). 그다음 deploy 결과의 next_step(publish --json)을 실행합니다.
7. 결과 보고: 결과의 message를 그대로 전하고 appUrl을 한 줄에 보여 줍니다. 등록에 쓴 제목, 설명, 학교급, 분류, ①~⑤ 답도 함께 보여 줍니다.
   - approvalStatus가 approved이면 이미 받은 학교 내부 승인이 유지되어 새 버전이 바로 공개된 것입니다.
   - liveVersion이 kept_until_approval이면 liveUrl도 보여 주고, 학교 내부 승인 완료를 표시할 때까지 이전 공개 버전이 그대로 보인다고 안내합니다.
   - ⑤가 "예"이면 승인 대기(①이 "예"면 ⑤도 반드시 "예")입니다. 교사가 학교 내부 승인을 마치고 {{HUB}}/studio/apps 에서 승인 완료를 표시하기 전까지 허브 목록에 나타나지 않습니다. ①이 "예"인데 ⑤가 "아니요"이면 등록되지 않으므로 ⑤를 스스로 바꾸지 말고 교사에게 다시 묻습니다.

## 이미 올린 사이트 고치기

1, 3, 4단계를 거칩니다. deploy 결과의 saved_answers를 보여 주고 그대로 둘지 바꿀지 한 번에 확인합니다(교사가 요청에서 이미 말했으면 묻지 않습니다). 그다음 next_step을 실행하고 "지금 공개된 버전은 다시 등록할 때까지 그대로입니다."라고 알립니다.

## 오류

| 종료 코드 | 뜻 | 할 일 |
| --- | --- | --- |
| 1 | 기타 오류 | hint를 교사에게 한 줄로 알립니다(network_error면 허브 주소와 실행 여부를 확인하게 합니다) |
| 2 | 사용법·폴더·dandi.json 인코딩 오류 | hint대로 고칩니다. nothing_to_publish면 3단계부터 합니다 |
| 4 | 로그인 필요 | 2단계 |
| 5 | 승인 대기 | next_step을 다시 실행합니다 |
| 6 | 거부됨 | 다시 로그인할지 먼저 묻습니다 |
| 7 | 만료 | 2단계를 한 번만 다시 합니다 |
| 20 | 업로드 거부 | 아래 오류 코드별로 고친 뒤 3단계 |
| 21 | 등록 정보·셀프점검 누락 | missing 항목만 교사에게 묻고 6단계 |

- source_folder: 빌드하지 않은 소스 폴더입니다. 빌드한 뒤 결과 폴더를 올립니다. \`--allow-source\` 는 교사가 그 폴더가 완성본이라고 확인할 때만 씁니다.
- secret_detected: hint를 그대로 전합니다. Dandi 사이트 호스팅은 정적 파일만 제공하므로 키를 보관할 수 없습니다. AI 기능은 서버 프록시({{HUB}}/downloads/ai-proxy-example.md)를 따로 배포해 publish --url로 등록하거나, AI 호출을 빼십시오. 키를 숨기거나 나눠서 검사를 피하지 마십시오.
- site_not_found: 오류에 나온 계정이 교사의 계정인지 먼저 묻습니다. 아니면 \`{{CLI}} login --force --json\` 으로 다시 로그인합니다. 교사가 새 사이트를 원할 때만 next_step_template(--new-site)을 실행합니다(이전 siteId는 previousSiteId에 남습니다).

## 한 번에 실행하는 방식(headless)

Codex(codex exec), Antigravity(agy -p), Grok(grok -p)처럼 한 번에 실행하는 방식은 중간에 답을 받을 수 없습니다. 교사에게 먼저 터미널에서 \`{{CLI}} login\` 으로 로그인해 두고, 요청 문장에 제목, 설명, 학교급, 분류, ①~⑤ 답을 함께 적도록 안내합니다. 답이 빠졌으면 미리보기까지만 하고 필요한 항목을 알려 줍니다.

## 셸을 쓸 수 없을 때

Claude 데스크톱이나 채팅형 도구에서는 허브의 원격 MCP({{HUB}}/mcp)를 연결해 dandi_deploy_files, dandi_privacy_questions, dandi_publish_site 도구를 씁니다. 연결 방법은 {{HUB}}/connect 에 있습니다. 채팅 커넥터는 공개 HTTPS 주소의 허브에만 연결됩니다. 연결할 수 없으면 교사에게 {{HUB}}/studio/sites 에서 사이트 폴더를 직접 올려 달라고 안내합니다.

## 하지 않는 일

- 토큰, 비밀번호, API 키를 채팅에 붙여 넣으라고 하지 않습니다. 로그인은 브라우저에서만 합니다.
- ~/.dandi 폴더, .env 파일, 키를 출력·커밋·업로드하지 않습니다. 키를 숨기거나 나눠서 검사를 피하지 않습니다.
- 셀프점검 질문에 교사 대신 답하지 않습니다. 교사가 준 답만 씁니다.
- 실제 학생 정보를 예시 데이터, 파일 이름, 제목, 설명에 넣지 않습니다.
- 교사 대신 로그인을 승인하거나 학교 내부 승인을 표시하지 않습니다.
- 교사가 고른 폴더 밖의 파일을 올리지 않습니다.
`,
};

const STUDENT_PII_CHECK: SeedDef = {
  name: "student-pii-check",
  title: "학생 개인정보 공개 전 점검",
  description:
    "미니앱이나 사이트를 공개하기 전에 학생 개인정보(이름 목록, 학번, 연락처, 주민등록번호, 성적, 상담·건강 기록)가 코드·데이터 파일·화면·외부 전송에 남아 있는지 점검하고, Dandi 셀프점검 5문항에 답할 근거를 정리합니다. Use when the user asks for a privacy check, PII review, student data audit, pre-publish review, 개인정보 점검, 공개 전 점검.",
  schoolLevels: ALL_LEVELS,
  body: `
# 학생 개인정보 공개 전 점검

교사가 만든 미니앱·사이트 프로젝트를 공개하기 전에 학생 개인정보가 남아 있는지 확인합니다. 점검 결과는 Dandi 셀프점검 5문항에 답할 근거가 됩니다. 판단은 교사가 하고, AI는 찾은 내용을 정리해 보여 줍니다.

## 1. 무엇을 찾는가

- 학생 이름 목록: 배열이나 표로 된 한글 이름, 좌석표, 모둠 편성표
- 식별 번호: 학번, 출석 번호와 이름을 함께 적은 표, 주민등록번호
- 연락처: 학생·보호자 휴대전화 번호, 개인 이메일, 집 주소
- 민감한 기록: 성적, 출결, 상담 내용, 건강·장애 정보, 가정환경
- 사진과 목소리: 학생 얼굴이 나온 이미지, 녹음 파일

## 2. 어디를 찾는가

1. 데이터 파일: csv, xlsx, json, txt 등 프로젝트에 들어 있는 모든 데이터 파일
2. 소스 코드: 코드 안에 직접 적은 배열·객체, 주석, 테스트용 예시 데이터
3. 화면에 보이는 문구: HTML, 안내문, 자리표시 텍스트(placeholder)
4. 이미지와 첨부 파일: assets, images, public 폴더
5. 빌드 결과물: dist, build, out 폴더에 원본 데이터가 복사되지 않았는지

## 3. 데이터가 어디로 가는가

- 입력 폼이 무엇을 받는지 확인합니다. 이름 대신 번호나 별명으로 충분한지 교사에게 묻습니다.
- 저장 위치를 확인합니다. 저장하지 않음, 브라우저(localStorage), 외부 데이터베이스, 구글 스프레드시트 등으로 나눕니다.
- 외부 전송을 확인합니다. fetch, XMLHttpRequest, 폼 action이 보내는 주소를 모두 적고, 해외 AI API로 입력 내용을 보내는지 표시합니다.
- 보관 기간을 확인합니다. 자동 삭제 기능이 있는지, 학기가 끝나면 지우는지 적습니다.

## 4. 결과 보고 형식

찾은 항목마다 아래 표로 정리합니다. 실제 값은 표에 옮겨 적지 말고 파일 위치와 종류만 적습니다.

| 파일(줄) | 종류 | 설명 | 권장 조치 |
| --- | --- | --- | --- |
| data/students.csv | 이름 목록 | 3학년 1반 이름 30개 | 가상의 이름으로 바꾸거나 파일 삭제 |

## 5. 셀프점검 5문항 답 준비

점검 결과를 바탕으로 교사가 답할 수 있게 근거를 정리합니다. 답은 교사가 직접 정합니다.

1. 학생 개인정보를 수집·처리하는가: 입력 폼과 데이터 파일 점검 결과
2. 저장 위치: 3번에서 확인한 저장 방식
3. 보관 기간: 자동 삭제 여부와 교사가 정한 기간
4. 외부 전송: 전송 주소 목록과 해외 서버 여부
5. 학교 내부 승인 필요 여부: 1번이 예이면 승인이 필요하다고 안내합니다

## 고치는 방법

- 시연과 공유에는 가상의 데이터를 씁니다(예: 학생1, 학생2).
- 이름 대신 번호나 모둠 이름을 씁니다.
- 꼭 저장해야 하면 브라우저 안에만 저장하고, 공개 서버로 보내지 않습니다.
- AI API를 써야 하면 개인정보를 빼고 보내며, 키는 서버 함수의 환경변수로만 읽습니다.
`,
};

const PARENT_LETTER_WRITER: SeedDef = {
  name: "parent-letter-writer",
  title: "가정통신문 초안 작성",
  description:
    "학교 행사·현장체험학습·방과후학교·상담 주간 등의 가정통신문(학부모 안내문) 초안을 학교 공문 문체로 작성하고, 회신서와 쉬운 한국어 요약을 함께 만듭니다. Use when the user asks for a parent letter, school newsletter, notice to parents, field trip notice, consent form, 가정통신문, 학부모 안내문.",
  schoolLevels: ALL_LEVELS,
  body: `
# 가정통신문 초안 작성

학교에서 보호자에게 보내는 가정통신문 초안을 만듭니다. 결과는 교사가 검토하고 학교 결재를 거쳐 발송합니다.

## 먼저 물어볼 것

필요한 정보가 없으면 초안을 쓰기 전에 교사에게 묻습니다.

1. 안내할 내용(행사 이름, 목적)
2. 일시와 장소
3. 대상 학년·반
4. 준비물, 비용, 신청 방법과 마감일
5. 회신서가 필요한지(참가 동의, 희망 조사 등)
6. 문의처(담당 부서 이름과 학교 대표번호는 교사가 직접 넣습니다)

## 쓰는 방법

- 문체는 합니다체의 공손한 공문 문체로 씁니다. 느낌표와 이모티콘은 쓰지 않습니다.
- 구성은 인사말, 안내 본문, 세부 사항 표, 협조 부탁, 끝인사, 날짜와 학교장 이름 순서입니다.
- 날짜는 "2026. 10. 15.(목)" 처럼 마침표와 요일을 함께 씁니다.
- 세부 사항(일시, 장소, 대상, 준비물, 비용)은 표로 정리합니다.
- A4 한 쪽 안에 들어가게 씁니다.
- 다문화 가정을 위해 마지막에 쉬운 한국어로 쓴 세 줄 요약을 덧붙입니다.

## 개인정보

- 학생 이름 목록, 보호자 휴대전화 번호, 개인 이메일을 넣지 않습니다.
- 회신서에는 학년, 반, 번호, 학생 이름, 보호자 서명 칸만 둡니다.
- 문의처는 개인 번호가 아니라 학교 대표번호나 담당 부서로 적습니다.

## 결과 형식

templates/letter-template.md의 틀을 따릅니다. 회신서가 필요하면 절취선 아래에 회신서를 붙입니다.
`,
  extra: {
    "templates/letter-template.md": `# 가정통신문 틀

(학교 이름) 가정통신문 제 (번호) 호

## (제목)

학부모님 안녕하십니까.
(계절 인사 한 문장) 늘 학교 교육에 관심을 가져 주셔서 감사합니다.

(안내 목적을 두세 문장으로 씁니다.)

| 항목 | 내용 |
| --- | --- |
| 일시 | 2026. 00. 00.(요일) 00:00 ~ 00:00 |
| 장소 | |
| 대상 | |
| 준비물 | |
| 비용 | |
| 신청 방법 | |

(협조를 부탁하는 문장을 씁니다.)

2026년 00월 00일

(학교 이름) 학교장

문의: (담당 부서), 학교 대표번호

---- 절취선 ----

## 회신서

| 학년 | 반 | 번호 | 학생 이름 |
| --- | --- | --- | --- |
| | | | |

위 내용을 확인하였으며 (참가에 동의합니다 / 동의하지 않습니다).

보호자 이름: ________ (서명)

## 쉬운 한국어 요약

1. (무엇을 하는지)
2. (언제, 어디서)
3. (무엇을 내야 하는지, 언제까지)
`,
  },
};

const LESSON_PLAN_RUBRIC: SeedDef = {
  name: "lesson-plan-rubric",
  title: "수업 지도안과 평가 루브릭",
  description:
    "교과·학년·단원·성취기준을 받아 차시별 수업 지도안(도입·전개·정리)과 성취기준에 맞춘 3~4수준 평가 루브릭(채점 기준표)을 만듭니다. 과정중심평가와 수행평가 채점 기준, 특수교육 대상 학생을 위한 조정 방안도 제안합니다. Use when the user asks for a lesson plan, rubric, scoring guide, performance assessment, 수업 지도안, 평가 기준표, 루브릭.",
  schoolLevels: ALL_LEVELS,
  body: `
# 수업 지도안과 평가 루브릭

교사가 준 교과, 학년, 단원, 성취기준으로 수업 지도안과 평가 루브릭을 만듭니다. 결과는 교사가 수업 상황에 맞게 고쳐 씁니다.

## 입력으로 받을 것

1. 교과와 학년(예: 초등 6학년 국어)
2. 단원과 차시 수
3. 성취기준 코드와 문장(예: [6국01-02]). 모르면 교사에게 묻고, 임의로 지어내지 않습니다.
4. 수업 환경(1인 1기기, 모둠 활동 가능 여부, 수업 시간)
5. 배려가 필요한 학생이 있는지(개별 학생 이름은 받지 않습니다)

## 수업 지도안 형식

차시마다 아래 표를 만듭니다.

| 단계 | 시간 | 교수·학습 활동 | 자료 및 유의점 |
| --- | --- | --- | --- |
| 도입 | 5분 | 동기 유발, 학습 목표 확인 | |
| 전개 | 30분 | 활동 1, 활동 2 | |
| 정리 | 5분 | 배운 내용 정리, 차시 예고 | |

- 학습 목표는 관찰할 수 있는 행동 동사로 씁니다(예: 설명할 수 있다, 비교할 수 있다).
- 활동마다 교사의 발문 예시를 한두 개 넣습니다.
- AI 도구를 쓰는 활동이면 학생 개인정보를 입력하지 않도록 유의점을 적습니다.

## 평가 루브릭 형식

references/rubric-example.md의 예시처럼 평가 요소와 수준을 표로 만듭니다.

- 평가 요소는 성취기준에서 뽑고, 두세 개로 제한합니다.
- 수준은 네 단계(매우 잘함, 잘함, 보통, 노력 필요) 또는 세 단계로 씁니다.
- 수준마다 학생이 실제로 보이는 행동을 적습니다. "우수함" 같은 막연한 말만 쓰지 않습니다.
- 수준 사이의 차이가 분명하게 드러나게 씁니다.
- 피드백 문장 예시를 수준별로 하나씩 덧붙입니다.

## 조정 방안

- 특수교육 대상 학생이나 기초학력 지원이 필요한 학생을 위해 과제 분량, 제시 방법, 평가 방법을 조정하는 안을 따로 적습니다.
- 개별 학생을 가리키는 내용은 쓰지 않고, 유형별로 씁니다.
`,
  extra: {
    "references/rubric-example.md": `# 평가 루브릭 예시

초등 6학년 국어, 성취기준 [6국01-02] 의견을 제시하고 함께 조정하며 토의한다.

| 평가 요소 | 매우 잘함 | 잘함 | 보통 | 노력 필요 |
| --- | --- | --- | --- | --- |
| 의견 제시 | 알맞은 근거 두 가지 이상을 들어 의견을 분명하게 말한다 | 근거 하나를 들어 의견을 말한다 | 의견을 말하지만 근거가 부족하다 | 도움을 받아 의견을 말한다 |
| 의견 조정 | 다른 의견의 좋은 점을 찾아 자기 의견을 고쳐 말한다 | 다른 의견을 듣고 같은 점과 다른 점을 말한다 | 다른 의견을 끝까지 듣는다 | 도움을 받아 다른 의견을 듣는다 |

## 수준별 피드백 문장 예시

- 매우 잘함: 근거를 두 가지나 들어 설득력이 있었습니다. 다음에는 반대 의견에 답하는 근거도 준비해 보십시오.
- 잘함: 근거가 분명했습니다. 근거를 하나 더 찾아보면 의견이 더 단단해집니다.
- 보통: 의견이 잘 드러났습니다. 왜 그렇게 생각하는지 이유를 한 가지 덧붙여 보십시오.
- 노력 필요: 친구의 의견을 듣고 나의 생각과 같은지 다른지부터 말해 보십시오.
`,
  },
};

const DEFS: SeedDef[] = [DANDI_DEPLOY, STUDENT_PII_CHECK, PARENT_LETTER_WRITER, LESSON_PLAN_RUBRIC];

const encoder = new TextEncoder();
const blobs = new Map<string, Uint8Array>();
const templateBlobs = new Set<string>();
const retired = new Map<string, ReadonlySet<string>>();

function buildSeedSkill(def: SeedDef): Skill {
  const version = def.version ?? "1.0.0";
  const createdAt = def.createdAt ?? T0;
  const texts: Record<string, string> = { "SKILL.md": skillMd(def), ...(def.extra ?? {}) };
  const raw = Object.entries(texts).map(([path, text]) => ({ path, bytes: encoder.encode(text), template: TEMPLATE_RE.test(text) }));
  const files: SiteFile[] = raw.map((f) => {
    const sha256 = sha256Hex(f.bytes);
    blobs.set(sha256, f.bytes);
    if (f.template) templateBlobs.add(sha256);
    return { path: f.path, size: f.bytes.byteLength, sha256, contentType: "text/markdown; charset=utf-8" };
  });
  if (def.retire?.length) retired.set(def.name, new Set(def.retire));
  const archive = buildSkillArchive(raw);
  const archiveHash = sha256Hex(archive);
  blobs.set(archiveHash, archive);
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    license: "CC-BY-4.0",
    schoolLevels: def.schoolLevels,
    compatibility: ["claude-code", "cursor", "codex"],
    authorId: "seed_admin",
    authorName: "교육청 관리자(데모)",
    installs: 0,
    latestVersion: version,
    versions: [
      {
        version,
        files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
        digest: `sha256:${archiveHash}`,
        hasScripts: false,
        findings: [],
        status: "approved",
        reviewedByName: "자동 검토",
        createdAt,
      },
    ],
    createdAt: T0,
    updatedAt: createdAt,
  };
}

export const SEED_SKILLS: Skill[] = DEFS.map(buildSeedSkill);

/** 시드 스킬의 파일·압축 파일 본문(sha256 → 바이트). skills.ts가 blob이 없을 때 여기서 채운다. */
export const SEED_SKILL_BLOBS: ReadonlyMap<string, Uint8Array> = blobs;

/** {{HUB}}·{{CLI}} 자리표시가 든 시드 파일의 sha256. 이 파일이 든 버전은 내보낼 때 허브별로 렌더링한다. */
export const SKILL_TEMPLATE_BLOBS: ReadonlySet<string> = templateBlobs;

/** 스킬 이름 → 새 시드 버전을 덧붙일 때 숨길 이전 시드 버전("버전@createdAt"). */
export const SEED_RETIRED_VERSIONS: ReadonlyMap<string, ReadonlySet<string>> = retired;
