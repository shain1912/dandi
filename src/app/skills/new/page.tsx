import type { Metadata } from "next";
import Link from "next/link";
import { hubOrigin } from "@/lib/origin";
import { getCurrentUser, isTeacher } from "@/lib/session";
import { vibeHubCliPrefix } from "@/lib/skills";
import { SkillPublishForm } from "./publish-form";

export const metadata: Metadata = { title: "스킬 게시 · Dandi" };

// F-38 스킬 게시(웹). 폴더 선택·zip·SKILL.md 붙여 넣기. CLI 게시와 같은 검증·안전 검토를 거친다.
export default async function NewSkillPage() {
  const user = await getCurrentUser();
  if (!isTeacher(user)) {
    return (
      <>
        <h1>스킬 게시</h1>
        <p className="notice">
          스킬 게시는 교사만 사용할 수 있습니다. <Link href="/login?next=/skills/new">교사 로그인</Link> 후 다시
          시도하십시오.
        </p>
        <p>
          <Link href="/skills">스킬 목록으로 돌아가기</Link>
        </p>
      </>
    );
  }
  const hub = await hubOrigin();
  return (
    <>
      <p className="muted">
        <Link href="/skills">스킬 목록</Link> / 스킬 게시
      </p>
      <h1>스킬 게시</h1>
      <p className="muted">
        SKILL.md가 든 스킬 폴더를 올립니다. 게시할 때마다 바꿀 수 없는 새 버전이 만들어지고, 설치 명령으로 Claude Code·Cursor·Codex에
        설치할 수 있게 됩니다.
      </p>

      <h2>게시 전에 확인하십시오</h2>
      <ul>
        <li>
          SKILL.md 첫머리에 <code>---</code>로 감싼 앞부분이 있어야 합니다. <code>name</code>은 영어 소문자·숫자·하이픈 64자
          이내이고 폴더 이름과 같아야 합니다. <code>description</code>은 1~1024자이며 한국어 설명과 영어 트리거 문구(Use when
          ...)를 함께 쓰기를 권장합니다. <code>license</code>는 반드시 적습니다(예: CC-BY-4.0).
        </li>
        <li>
          한국어 제목은 <code>metadata</code> 아래 <code>title</code>에 적습니다. 버전을 직접 정하려면{" "}
          <code>version: &quot;1.2.0&quot;</code>처럼 적고, 비워 두면 1.0.0부터 자동으로 올립니다.
        </li>
        <li>
          값에 콜론과 공백(<code>: </code>)이 들어가면 값 전체를 큰따옴표로 감싸십시오. 설치 도구가 앞부분을 읽지 못합니다.
        </li>
        <li>한도: 파일당 2MB, 전체 10MB, 200개. 이미지 등 바이너리 파일은 assets/ 폴더에만 둘 수 있습니다.</li>
        <li>
          학생 개인정보(연락처, 주민등록번호 등)나 API 키·토큰이 있으면 게시가 거부됩니다. 점으로 시작하는 파일(.env 등)은
          올라가지 않습니다.
        </li>
        <li>
          프롬프트만 있는 스킬은 자동 검토 후 바로 공개됩니다. scripts/ 폴더, 훅(hooks), <code>!`명령`</code> 문법, 넓은 셸
          권한(<code>Bash(*)</code>), 바깥으로 데이터를 보내는 명령, .env 파일이나 로그인 정보(~/.dandi 등)를 읽게 하는 문장 등이 있으면
          관리자 검토를 거친 뒤 공개됩니다.
        </li>
      </ul>
      <p className="muted">
        터미널에서는 <code>{vibeHubCliPrefix(hub)} skill publish ./내-스킬-폴더</code> 로도 게시할
        수 있습니다.
      </p>

      <h2>올리기</h2>
      <SkillPublishForm defaultLevel={user.schoolLevel} />
    </>
  );
}
