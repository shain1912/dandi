"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AuthError, requireTeacher } from "@/lib/session";
import { formatFinding, publishSkill, SKILL_LIMITS, unzipSkillArchive, type SkillInputFile } from "@/lib/skills";
import { normalizeNewlines } from "@/lib/text";

export type PublishSkillFormState = { error?: string; hint?: string; findings?: string[]; notice?: string };

const PASTE_MAX_CHARS = 200_000;

/** F-38 웹 게시: 폴더 선택(webkitdirectory), zip 파일, SKILL.md 붙여 넣기. CLI·API와 같은 publishSkill을 쓴다. */
export async function publishSkillAction(
  _prev: PublishSkillFormState,
  formData: FormData,
): Promise<PublishSkillFormState> {
  let user;
  try {
    user = await requireTeacher();
  } catch (err) {
    if (err instanceof AuthError) return { error: err.message };
    throw err;
  }

  const mode = String(formData.get("mode") ?? "");
  let files: SkillInputFile[] = [];
  if (mode === "folder") {
    const list = formData.getAll("files");
    const paths = formData.getAll("paths").map(String);
    if (list.length === 0) return { error: "스킬 폴더를 선택하십시오." };
    if (list.length !== paths.length) {
      return { error: "파일 경로를 확인할 수 없습니다. 브라우저의 자바스크립트를 켠 뒤 다시 시도하십시오." };
    }
    if (list.length > SKILL_LIMITS.fileCount) return { error: `파일은 ${SKILL_LIMITS.fileCount}개까지 올릴 수 있습니다.` };
    let total = 0;
    for (const f of list) {
      if (!(f instanceof File)) return { error: "파일을 읽을 수 없습니다." };
      total += f.size;
    }
    if (total > SKILL_LIMITS.totalBytes) return { error: "스킬 전체 크기는 10MB까지입니다." };
    for (let i = 0; i < list.length; i++) {
      const f = list[i] as File;
      files.push({ path: paths[i].slice(0, 400), bytes: new Uint8Array(await f.arrayBuffer()) });
    }
  } else if (mode === "zip") {
    const f = formData.get("zip");
    if (!(f instanceof File) || f.size === 0) return { error: "zip 파일을 선택하십시오." };
    if (f.size > SKILL_LIMITS.totalBytes * 2) return { error: "zip 파일이 너무 큽니다. 스킬 전체 크기는 10MB까지입니다." };
    const unzipped = unzipSkillArchive(new Uint8Array(await f.arrayBuffer()));
    if (!unzipped.ok) return { error: unzipped.message };
    files = unzipped.files;
  } else if (mode === "paste") {
    const text = normalizeNewlines(String(formData.get("skillMd") ?? ""));
    if (text.length > PASTE_MAX_CHARS) return { error: "SKILL.md가 너무 깁니다. 긴 내용은 폴더로 올리십시오." };
    if (!text.trim()) return { error: "SKILL.md 내용을 붙여 넣으십시오." };
    files = [{ path: "SKILL.md", bytes: new TextEncoder().encode(text) }];
  } else {
    return { error: "올리는 방법을 고르십시오." };
  }

  const title = String(formData.get("title") ?? "").slice(0, 200).trim();
  const result = await publishSkill(user, files, {
    title: title || undefined,
    schoolLevels: formData.getAll("schoolLevels").map(String),
    compatibility: formData.getAll("compatibility").map(String),
  });
  if (!result.ok) {
    return { error: result.message, hint: result.hint, findings: result.findings?.map(formatFinding) };
  }
  if (result.value.unchanged) {
    return {
      notice: `이미 같은 내용의 v${result.value.version}이(가) 있어 새 버전을 만들지 않았습니다. 내용을 바꾼 뒤 다시 올리십시오.`,
    };
  }

  revalidatePath("/skills");
  revalidatePath(`/skills/${result.value.name}`);
  revalidatePath("/admin/skills");
  redirect(`/skills/${result.value.name}?published=${result.value.version}`);
}
