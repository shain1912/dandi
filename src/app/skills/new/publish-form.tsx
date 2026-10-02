"use client";

import { useActionState, useState, useTransition } from "react";
import { blockSubmitIfPII, PiiInput, PiiTextarea } from "@/components/pii-guard";
import { SCHOOL_LEVELS } from "@/lib/constants";
import type { SchoolLevel } from "@/lib/types";
import { publishSkillAction, type PublishSkillFormState } from "../actions";

// src/lib/skills.ts는 서버 전용이라 화면에서 쓰는 값만 옮겨 둔다(서버가 같은 한도로 다시 검사한다).
const TOOLS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
];
const LIMITS = { fileBytes: 2 * 1024 * 1024, totalBytes: 10 * 1024 * 1024, fileCount: 200 };

const SKELETON = `---
name: my-skill
description: 이 스킬이 하는 일과 쓰는 때를 한두 문장으로 씁니다. Use when the user asks for (영어 트리거 문구).
license: CC-BY-4.0
metadata:
  title: 한국어 제목
---

# 한국어 제목

## 언제 쓰는가
- 교사가 ... 을 부탁할 때

## 절차
1. ...
2. ...

## 하지 않는 일
- 학생 이름, 연락처 같은 개인정보를 넣지 않습니다.
`;

type Mode = "folder" | "zip" | "paste";

/** 폴더에서 올리지 않을 파일(점으로 시작하는 파일·폴더, macOS 메타데이터, node_modules). */
function skipped(path: string): boolean {
  return path.split("/").some((s) => s.startsWith(".") || s === "__MACOSX" || s === "node_modules");
}

export function SkillPublishForm({ defaultLevel }: { defaultLevel: SchoolLevel | null }) {
  const [state, action, pending] = useActionState<PublishSkillFormState, FormData>(publishSkillAction, {});
  const [, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>("folder");
  const [picked, setPicked] = useState<{ files: File[]; skipped: number } | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);

  function onFolderChange(e: React.ChangeEvent<HTMLInputElement>) {
    const all = Array.from(e.target.files ?? []);
    const keep = all.filter((f) => !skipped(f.webkitRelativePath || f.name));
    setPicked({ files: keep, skipped: all.length - keep.length });
    setClientError(null);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    blockSubmitIfPII(e);
    if (e.defaultPrevented) return;
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData();
    fd.set("mode", mode);
    fd.set("title", (form.elements.namedItem("title") as HTMLInputElement | null)?.value ?? "");
    form.querySelectorAll<HTMLInputElement>('input[name="schoolLevels"]:checked').forEach((el) => fd.append("schoolLevels", el.value));
    form.querySelectorAll<HTMLInputElement>('input[name="compatibility"]:checked').forEach((el) => fd.append("compatibility", el.value));

    if (mode === "folder") {
      if (!picked || picked.files.length === 0) return setClientError("SKILL.md가 든 스킬 폴더를 선택하십시오.");
      if (picked.files.length > LIMITS.fileCount) return setClientError(`파일은 ${LIMITS.fileCount}개까지 올릴 수 있습니다.`);
      const big = picked.files.find((f) => f.size > LIMITS.fileBytes);
      if (big) return setClientError(`파일 하나는 2MB까지 올릴 수 있습니다: ${big.webkitRelativePath || big.name}`);
      if (picked.files.reduce((n, f) => n + f.size, 0) > LIMITS.totalBytes) return setClientError("스킬 전체 크기는 10MB까지입니다.");
      for (const f of picked.files) {
        fd.append("files", f);
        fd.append("paths", f.webkitRelativePath || f.name);
      }
    } else if (mode === "zip") {
      const zip = (form.elements.namedItem("zip") as HTMLInputElement | null)?.files?.[0];
      if (!zip) return setClientError("zip 파일을 선택하십시오.");
      fd.set("zip", zip);
    } else {
      fd.set("skillMd", (form.elements.namedItem("skillMd") as HTMLTextAreaElement | null)?.value ?? "");
    }
    setClientError(null);
    startTransition(() => action(fd));
  }

  return (
    <form action={action} className="stack" onSubmit={handleSubmit}>
      <fieldset>
        <legend>올리는 방법</legend>
        <label>
          <input type="radio" name="mode" value="folder" checked={mode === "folder"} onChange={() => setMode("folder")} /> 스킬
          폴더 선택
        </label>{" "}
        <label>
          <input type="radio" name="mode" value="zip" checked={mode === "zip"} onChange={() => setMode("zip")} /> zip 파일
        </label>{" "}
        <label>
          <input type="radio" name="mode" value="paste" checked={mode === "paste"} onChange={() => setMode("paste")} /> SKILL.md
          붙여 넣기(프롬프트만 있는 스킬)
        </label>
      </fieldset>

      {mode === "folder" && (
        <label className="field">
          <span>스킬 폴더 (폴더 이름 = SKILL.md의 name)</span>
          <input
            type="file"
            name="files"
            multiple
            onChange={onFolderChange}
            ref={(el) => {
              if (el) {
                el.setAttribute("webkitdirectory", "");
                el.setAttribute("directory", "");
              }
            }}
          />
          {picked && (
            <span className="muted">
              파일 {picked.files.length}개를 올립니다
              {picked.skipped > 0 ? `(점으로 시작하는 파일 등 ${picked.skipped}개는 뺍니다)` : ""}.{" "}
              {picked.files
                .slice(0, 8)
                .map((f) => f.webkitRelativePath || f.name)
                .join(", ")}
              {picked.files.length > 8 ? " 외" : ""}
            </span>
          )}
        </label>
      )}
      {mode === "zip" && (
        <label className="field">
          <span>스킬 zip 파일 (SKILL.md가 맨 위나 폴더 하나 안에 있어야 합니다)</span>
          <input type="file" name="zip" accept=".zip,application/zip" />
        </label>
      )}
      {mode === "paste" && (
        <PiiTextarea name="skillMd" label="SKILL.md" required rows={22} maxLength={200000} defaultValue={SKELETON} />
      )}

      <PiiInput name="title" label="한국어 제목 (비우면 metadata의 title 또는 name)" maxLength={80} placeholder="예: 가정통신문 초안 작성" />
      <fieldset>
        <legend>학교급 (비우면 전체)</legend>
        {SCHOOL_LEVELS.map((l) => (
          <label key={l.id}>
            <input type="checkbox" name="schoolLevels" value={l.id} defaultChecked={defaultLevel === l.id} /> {l.label}{" "}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>호환 도구 (비우면 compatibility 문구에서 찾고, 없으면 세 도구 모두)</legend>
        {TOOLS.map((t) => (
          <label key={t.id}>
            <input type="checkbox" name="compatibility" value={t.id} /> {t.label}{" "}
          </label>
        ))}
      </fieldset>

      {(clientError || state.error) && (
        <div className="error" role="alert">
          <p style={{ margin: 0 }}>{clientError ?? state.error}</p>
          {!clientError && state.hint && <p style={{ margin: 0 }}>{state.hint}</p>}
          {!clientError && state.findings && state.findings.length > 0 && (
            <ul>
              {state.findings.slice(0, 20).map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {state.notice && !clientError && (
        <p className="notice" role="status">
          {state.notice}
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "검사하고 게시하는 중…" : "스킬 게시"}
      </button>
    </form>
  );
}
