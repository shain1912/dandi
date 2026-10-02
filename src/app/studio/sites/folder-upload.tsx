"use client";

import { useState } from "react";
import { scanPII } from "@/lib/pii";
import type { SiteWarning } from "@/lib/sites";
import { finalizeDeployAction, startDeployAction, uploadSiteFileAction, type PublishValues } from "./actions";
import { PublishForm } from "./publish-form";
import { SECRET_DETECTED_MESSAGE, hasSecret, isSiteTextPath, secretDetectedHint } from "./secret-scan";
import { sha256OfBuffer } from "./sha256";

// 웹 폴더 올리기(F-52). 셸이 없는 교사가 사이트 폴더를 고르거나 끌어다 놓으면 CLI와 같은 3단계로 올린다.
// 1) 브라우저에서 파일마다 sha256을 계산해 목록을 보내고 2) 서버에 없는 파일만 올린 뒤 3) 확정해 미리보기 주소를 받는다.
// 비밀값(API 키·토큰)은 서버 finalize와 같은 규칙(secret-scan.ts)으로 올리기 전에 브라우저에서 먼저 막는다(QA R8).

type Picked = { path: string; file: File };
type Limits = { totalBytes: number; fileCount: number; fileBytes: number };
type ProjectOption = { id: string; name: string };

/**
 * 고른 파일 경로를 서버 저장 형식(NFC)으로 맞춘다. macOS Finder가 만든 한글 파일 이름은 NFD로 들어오는데,
 * 서버는 경로를 NFC로 바꿔 돌려주므로 그대로 두면 올릴 파일을 찾지 못한다(QA web-upload-nfd-filenames).
 */
function normalizePickedPath(p: string): string {
  return p.normalize("NFC").replace(/^\/+/, "");
}

type Done = { siteId: string; deployId: string; slug: string; previewUrl: string; warnings: SiteWarning[] };

// 폴더 이름을 사이트 폴더로 인정하는 빌드 결과 폴더(CLI deploy의 기본 폴더 순서와 같다)
const BUILD_DIRS = ["dist", "build", "out"];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** CLI와 같은 제외 규칙: node_modules, 점으로 시작하는 파일·폴더(.git, .env 등), dandi.json */
function excludedReason(p: string, allowedExt: string[]): string | null {
  const segs = p.split("/");
  if (segs.some((s) => s.startsWith("."))) return "숨김 파일";
  if (segs.includes("node_modules")) return "node_modules";
  if (p === "dandi.json") return "설정 파일";
  if (!allowedExt.includes(extOf(p))) return "허용되지 않는 형식";
  return null;
}

/** 모든 경로가 같은 최상위 폴더 안에 있으면 그 폴더 이름을 뗀다(고른 폴더 자체가 사이트 루트). */
function stripCommonRoot(items: Picked[]): Picked[] {
  if (items.length === 0) return items;
  const first = items[0].path.split("/")[0];
  if (!items.every((i) => i.path.includes("/") && i.path.split("/")[0] === first)) return items;
  return items.map((i) => ({ ...i, path: i.path.slice(first.length + 1) }));
}

async function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

async function walkEntry(entry: FileSystemEntry, prefix: string, out: Picked[], skipped: string[]): Promise<void> {
  const p = prefix + entry.name;
  if (entry.isDirectory) {
    // 큰 폴더는 읽기 전에 건너뛴다.
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      skipped.push(`${p}/`);
      return;
    }
    for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) {
      await walkEntry(child, `${p}/`, out, skipped);
    }
    return;
  }
  const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
  out.push({ path: p, file });
}

export function FolderUpload({
  siteId,
  limits,
  allowedExt,
  publishDefaults,
  republish = false,
  urlExample,
  projects = [],
  hub,
}: {
  /** 있으면 이 사이트의 새 버전으로 올린다 */
  siteId?: string;
  limits: Limits;
  allowedExt: string[];
  publishDefaults: PublishValues;
  republish?: boolean;
  /** 사이트 이름이 들어간 공개 주소 예시(허브 설정에 따라 다르다) */
  urlExample?: string;
  /** 새 사이트를 연결할 내 활성 프로젝트(첫 항목이 기본 프로젝트). 비어 있으면 서버가 기본 프로젝트를 만든다 */
  projects?: ProjectOption[];
  /** 허브 주소(비밀값 안내의 서버 프록시 예시 링크에 쓴다). 없으면 현재 창의 origin */
  hub?: string;
}) {
  const [files, setFiles] = useState<Picked[]>([]);
  const [skipped, setSkipped] = useState<{ path: string; reason: string }[]>([]);
  const [rootNote, setRootNote] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  function accept(raw: Picked[], preSkipped: string[]) {
    setError(null);
    setDone(null);
    let items = stripCommonRoot(raw.map((r) => ({ ...r, path: normalizePickedPath(r.path) })));
    let note: string | null = null;
    if (!items.some((i) => i.path === "index.html")) {
      // 프로젝트 폴더를 골랐다면 빌드 결과 폴더를 사이트 루트로 쓴다.
      const dir = BUILD_DIRS.find((d) => items.some((i) => i.path === `${d}/index.html`));
      if (dir) {
        items = items.filter((i) => i.path.startsWith(`${dir}/`)).map((i) => ({ ...i, path: i.path.slice(dir.length + 1) }));
        note = `맨 위에 index.html이 없어 ${dir} 폴더를 사이트 폴더로 골랐습니다.`;
      }
    }
    const kept: Picked[] = [];
    const out: { path: string; reason: string }[] = preSkipped.map((p) => ({ path: p, reason: "숨김·node_modules 폴더" }));
    for (const i of items) {
      const reason = excludedReason(i.path, allowedExt);
      if (reason) out.push({ path: i.path, reason });
      else kept.push(i);
    }
    kept.sort((a, b) => a.path.localeCompare(b.path));
    setFiles(kept);
    setSkipped(out);
    setRootNote(note);
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files ? Array.from(e.target.files) : [];
    accept(
      list.map((file) => ({ path: file.webkitRelativePath || file.name, file })),
      [],
    );
  }

  async function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    // DataTransferItem은 이벤트 처리 중에만 읽을 수 있으므로 항목을 먼저 모은다.
    const entries = Array.from(e.dataTransfer.items)
      .map((item) => item.webkitGetAsEntry())
      .filter((x): x is FileSystemEntry => x !== null);
    if (entries.length === 0) return;
    setProgress("폴더를 읽는 중…");
    try {
      const out: Picked[] = [];
      const pre: string[] = [];
      for (const entry of entries) await walkEntry(entry, "", out, pre);
      accept(out, pre);
    } catch {
      setError({ message: "폴더를 읽지 못했습니다. '폴더 고르기' 버튼으로 다시 시도하십시오." });
    } finally {
      setProgress("");
    }
  }

  const totalBytes = files.reduce((s, f) => s + f.file.size, 0);
  const hasIndex = files.some((f) => f.path === "index.html");
  const tooBig = files.filter((f) => f.file.size > limits.fileBytes);
  const problems: string[] = [];
  if (files.length > 0 && !hasIndex) problems.push("사이트 폴더 맨 위에 index.html이 있어야 합니다. 빌드 결과 폴더(dist, build, out 등)를 고르십시오.");
  if (files.length > limits.fileCount) problems.push(`파일은 ${limits.fileCount}개까지 올릴 수 있습니다(현재 ${files.length}개).`);
  if (totalBytes > limits.totalBytes) problems.push(`사이트 전체 크기는 ${formatBytes(limits.totalBytes)}까지입니다(현재 ${formatBytes(totalBytes)}).`);
  if (tooBig.length > 0) {
    problems.push(`파일 하나는 ${formatBytes(limits.fileBytes)}까지입니다: ${tooBig.slice(0, 5).map((f) => f.path).join(", ")}`);
  }
  if (scanPII(title).length > 0) problems.push("사이트 제목에 개인정보로 보이는 값이 있습니다. 지우거나 바꾸십시오.");

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || files.length === 0 || problems.length > 0) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const manifest: { path: string; size: number; sha256: string }[] = [];
      const secretPaths: string[] = [];
      const decoder = new TextDecoder("utf-8", { fatal: false });
      for (let i = 0; i < files.length; i++) {
        setProgress(`파일 확인 중 ${i + 1}/${files.length}`);
        const f = files[i];
        const buf = await f.file.arrayBuffer();
        if (isSiteTextPath(f.path) && hasSecret(decoder.decode(buf))) secretPaths.push(f.path);
        manifest.push({ path: f.path, size: f.file.size, sha256: await sha256OfBuffer(buf) });
      }
      if (secretPaths.length > 0) {
        // 서버 finalize의 secret_detected와 같은 문장. 키가 든 파일은 허브로 보내지 않는다.
        setError({ message: SECRET_DETECTED_MESSAGE, hint: secretDetectedHint(secretPaths, hub ?? window.location.origin) });
        return;
      }
      setProgress("배포 준비 중…");
      const started = await startDeployAction({
        siteId,
        title: siteId ? undefined : title.trim() || undefined,
        slug: siteId ? undefined : slug.trim() || undefined,
        projectId: siteId ? undefined : projectId || undefined,
        files: manifest,
      });
      if (!started.ok) {
        setError(started);
        return;
      }
      // 서버는 NFC 경로를 돌려준다. 고른 파일도 NFC로 맞춰 두었으므로(accept) 같은 키로 찾는다.
      const byPath = new Map(files.map((f) => [normalizePickedPath(f.path), f.file]));
      for (let i = 0; i < started.upload.length; i++) {
        const p = started.upload[i];
        const file = byPath.get(p) ?? byPath.get(p.normalize("NFC"));
        if (!file) {
          setError({
            message: `서버가 요청한 파일을 고른 폴더에서 찾지 못했습니다: ${p}`,
            hint: "폴더를 다시 고른 뒤 올리십시오. 계속 실패하면 파일 이름을 영문으로 바꿔 보십시오.",
          });
          return;
        }
        setProgress(`올리는 중 ${i + 1}/${started.upload.length}: ${p}`);
        const fd = new FormData();
        fd.set("deployId", started.deployId);
        fd.set("path", p);
        fd.set("file", file);
        const up = await uploadSiteFileAction(fd);
        if (!up.ok) {
          setError(up);
          return;
        }
      }
      setProgress("확인하는 중…");
      const fin = await finalizeDeployAction(started.deployId);
      if (!fin.ok) {
        setError(fin);
        return;
      }
      setDone(fin);
    } catch {
      setError({ message: "올리는 중 연결이 끊겼습니다. 잠시 뒤 다시 시도하십시오." });
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  if (done) {
    return (
      <div>
        <h2>미리보기</h2>
        <p className="notice" role="status">
          사이트를 올렸습니다. 아래 미리보기 주소는 링크를 아는 사람만 볼 수 있고 검색에 나오지 않습니다. 확인한 뒤
          허브에 등록하면 공개 주소가 열립니다.
        </p>
        <p>
          <a href={done.previewUrl} target="_blank" rel="noopener noreferrer" className="button">
            미리보기 새 창으로 열기
          </a>{" "}
          <code>{done.previewUrl}</code>
        </p>
        {done.warnings.length > 0 && (
          <div className="notice">
            <p style={{ margin: 0 }}>
              개인정보로 보이는 값이 있습니다({done.warnings.length}건). 예시 값이면 그대로 두어도 되지만, 실제 학생·교사의
              개인정보라면 지운 뒤 다시 올리십시오.
            </p>
            <ul>
              {done.warnings.slice(0, 20).map((w, i) => (
                <li key={`${w.path}-${w.kind}-${i}`}>
                  <code>{w.path}</code>: {w.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        <iframe
          className="app-frame"
          src={done.previewUrl}
          title="사이트 미리보기"
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"
        />
        <h2>{republish ? "허브 등록 정보 고치기" : "허브에 등록"}</h2>
        <p className="muted">
          셀프점검 5문항에 직접 답하면 허브 미니앱으로 등록되고 공개 주소가 열립니다. 등록하지 않으면 미리보기로만 남습니다.
        </p>
        <PublishForm
          siteId={done.siteId}
          deployOptions={[{ id: done.deployId, label: "방금 올린 버전" }]}
          defaults={{ ...publishDefaults, title: publishDefaults.title || title.trim() }}
          republish={republish}
        />
      </div>
    );
  }

  return (
    <form onSubmit={upload} className="stack">
      {!siteId && (
        <>
          <label className="field">
            <span>사이트 제목 (선택)</span>
            <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="예: 3학년 과학 퀴즈" />
          </label>
          <label className="field">
            <span>사이트 이름 (선택, 주소에 들어갑니다)</span>
            <input
              value={slug}
              maxLength={30}
              pattern="[a-z0-9](?:[a-z0-9\-]{1,28}[a-z0-9])"
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="예: science-quiz (비우면 무작위 이름)"
            />
            <span className="muted">
              영문 소문자·숫자·하이픈 3~30자.{urlExample ? ` 공개 주소는 ${urlExample} 형태가 됩니다.` : ""}
            </span>
          </label>
          {projects.length > 0 && (
            <label className="field">
              <span>연결 프로젝트</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p, i) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {i === 0 ? " (기본)" : ""}
                  </option>
                ))}
              </select>
              <span className="muted">
                프로젝트는 AI 키·사용량을 묶는 단위입니다. 올린 뒤에도 사이트 관리 화면에서 바꿀 수 있습니다.
              </span>
            </label>
          )}
        </>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={dragOver ? "notice" : undefined}
        style={{ border: "1px dashed var(--line)", borderRadius: 4, padding: 16 }}
      >
        <p style={{ marginTop: 0 }}>사이트 폴더(index.html이 들어 있는 폴더)를 여기에 끌어다 놓거나 폴더를 고르십시오.</p>
        <input
          type="file"
          multiple
          onChange={onPick}
          disabled={busy}
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        />
        <p className="muted" style={{ marginBottom: 0 }}>
          node_modules, .git, .env 같은 숨김 파일과 dandi.json은 올리지 않습니다. 한도: 파일 {limits.fileCount}개, 합계{" "}
          {formatBytes(limits.totalBytes)}, 파일당 {formatBytes(limits.fileBytes)}.
        </p>
      </div>

      {rootNote && <p className="muted">{rootNote}</p>}
      {files.length > 0 && (
        <details>
          <summary>
            올릴 파일 {files.length}개 · {formatBytes(totalBytes)}
          </summary>
          <ul className="muted">
            {files.slice(0, 200).map((f) => (
              <li key={f.path}>
                <code>{f.path}</code> ({formatBytes(f.file.size)})
              </li>
            ))}
            {files.length > 200 && <li>외 {files.length - 200}개</li>}
          </ul>
        </details>
      )}
      {skipped.length > 0 && (
        <details>
          <summary>제외한 파일 {skipped.length}개</summary>
          <ul className="muted">
            {skipped.slice(0, 100).map((s) => (
              <li key={s.path}>
                <code>{s.path}</code> ({s.reason})
              </li>
            ))}
            {skipped.length > 100 && <li>외 {skipped.length - 100}개</li>}
          </ul>
        </details>
      )}
      {problems.map((p) => (
        <p key={p} className="error" role="alert">
          {p}
        </p>
      ))}
      {error && (
        <p className="error" role="alert">
          {error.message}
          {error.hint ? ` ${error.hint}` : ""}
        </p>
      )}
      {progress && (
        <p className="muted" role="status">
          {progress}
        </p>
      )}
      <button type="submit" disabled={busy || files.length === 0 || problems.length > 0}>
        {busy ? "올리는 중…" : siteId ? "새 버전 올리기" : "올리고 미리보기 만들기"}
      </button>
    </form>
  );
}
