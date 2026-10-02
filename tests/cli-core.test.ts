import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CliError,
  checkSourceFolder,
  collectSiteFolder,
  createCtx,
  decodeInlineFiles,
  describeDeploy,
  describePublish,
  findManifestDir,
  newManifestDir,
  readManifest,
  renameWithRetry,
  resolveSiteFolder,
  walkFolder,
} from "../cli/core.mjs";
import { APPROVAL_RULE } from "../cli/lib.mjs";
import { MCP_TOOLS, createMcpServer } from "../cli/mcp.mjs";

let tmp = "";

function put(rel: string, content: string | Uint8Array = "x") {
  const abs = path.join(tmp, ...rel.split("/"));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "vh-cli-core-"));
  // 사이트 폴더(site/)와 빌드 결과 폴더(proj/dist/)
  put("site/index.html", "<h1>퀴즈</h1>");
  put("site/app.js", "console.log(1)");
  put("site/assets/logo.png", new Uint8Array([137, 80, 78, 71]));
  put("site/app.js.map", "{}");
  put("site/README", "readme");
  put("site/.env", "SECRET=1");
  put("site/.env.local", "SECRET=2");
  put("site/.git/config", "[core]");
  put("site/.hidden", "h");
  put("site/sub/.secret", "s");
  put("site/node_modules/lib/index.js", "module.exports = 1");
  put("site/dandi.json", "{}");
  put("proj/dandi.json", JSON.stringify({ outputDir: "public" }));
  put("proj/dist/index.html", "<p>dist</p>");
  put("proj/public/index.html", "<p>public</p>");
  put("proj/src/main.ts", "x");
  put("empty/readme.txt", "nothing");
  put("secret-site/index.html", '<script>const key = "dd_sk_abcdef";</script>');
  // Vite 소스 폴더(빌드 전) · 빌드 결과가 있는 소스 폴더 · package.json만 있는 정적 사이트
  put("vite-src/index.html", '<!doctype html><div id="root"></div><script type="module" src="/src/main.jsx"></script>');
  put("vite-src/package.json", '{"name":"x"}');
  put("vite-src/src/main.jsx", "export {}");
  put("vite-built/index.html", '<script type="module" src="/src/main.tsx"></script>');
  put("vite-built/package.json", '{"name":"x"}');
  put("vite-built/vite.config.ts", "export default {}");
  put("vite-built/dist/index.html", '<script type="module" src="/assets/index-abc.js"></script>');
  put("static-pkg/index.html", "<p>static</p>");
  put("static-pkg/app.js", "console.log(1)");
  put("static-pkg/package.json", '{"scripts":{"dev":"live-server"}}');
  put("static-pkg/vite.config.js", "export default {}");
  // npm create vite(vanilla) 빌드 전: /src/main.js를 type=module로 불러오고 package.json에 build 스크립트·vite가 있음
  put("vite-vanilla/index.html", '<!doctype html><div id="app"></div><script type="module" src="/src/main.js"></script>');
  put("vite-vanilla/package.json", '{"scripts":{"dev":"vite","build":"vite build"},"devDependencies":{"vite":"^5.0.0"}}');
  put("vite-vanilla/src/main.js", "import './style.css'");
  // build 스크립트는 있지만 index.html은 평범한 스크립트를 불러옴(빌드 결과 없음)
  put("needs-build/index.html", '<script src="app.js"></script>');
  put("needs-build/package.json", '{"scripts":{"build":"webpack"}}');
  // React 수업 페이지: 코드 예시만 있고 package.json 없음 / package.json(빌드 없음)이 있는 수업 페이지
  const lesson = '<h1>React</h1><pre><code>import App from "./App.jsx";</code></pre><script src="quiz.js"></script>';
  put("lesson/index.html", lesson);
  put("lesson-pkg/index.html", lesson);
  put("lesson-pkg/package.json", '{"name":"lesson","scripts":{"start":"npx serve ."}}');
  // package.json 없이 소스 모듈을 불러오는 폴더(거부하지 않고 notes로 알림)
  put("loose-src/index.html", '<script type="module" src="/src/main.jsx"></script>');
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const guide = () => ({ prefix: "npx -y http://hub/dandi-0.2.0.tgz", hub: "http://hub", retry: null });

test("walkFolder: 제외 규칙에 걸린 파일·폴더는 읽지 않음", async () => {
  const r = await walkFolder(path.join(tmp, "site"));
  assert.deepEqual(
    r.files.map((f) => f.path).sort(),
    ["README", "app.js", "app.js.map", "assets/logo.png", "index.html"],
  );
  for (const p of [".env", ".env.local", ".git/", ".hidden", "node_modules/", "dandi.json", "sub/.secret"]) {
    assert.ok(r.excluded.includes(p), `${p} in ${JSON.stringify(r.excluded)}`);
  }
  assert.equal(r.files.find((f) => f.path === "index.html")?.size, Buffer.byteLength("<h1>퀴즈</h1>"));
});

test("collectSiteFolder: 허용되지 않는 확장자는 건너뛰고 나머지를 읽음", async () => {
  const r = await collectSiteFolder(path.join(tmp, "site"), "dandi");
  assert.deepEqual(r.files.map((f) => f.path).sort(), ["app.js", "assets/logo.png", "index.html"]);
  assert.deepEqual(r.skipped.map((s) => s.path).sort(), ["README", "app.js.map"]);
  assert.deepEqual(r.withheld, []);
  assert.equal(new TextDecoder().decode(r.files.find((f) => f.path === "index.html")?.bytes), "<h1>퀴즈</h1>");
});

test("collectSiteFolder: 맨 위에 package.json이 있으면 빌드 설정 파일은 올리지 않고 경고", async () => {
  const r = await collectSiteFolder(path.join(tmp, "static-pkg"), guide());
  assert.deepEqual(r.files.map((f) => f.path).sort(), ["app.js", "index.html"]);
  assert.deepEqual(r.withheld.sort(), ["package.json", "vite.config.js"]);
  // 빌드 설정 파일 안내는 warnings(개인정보)가 아니라 notes에 둔다.
  assert.deepEqual(r.notes.map((w) => w.kind), ["source_file", "source_file"]);
  assert.equal("localWarnings" in r, false);
});

test("collectSiteFolder: 한글 파일 이름은 허브와 같은 NFC 경로로 보냄", async () => {
  const nfd = "사진.png".normalize("NFD");
  put("nfc-site/index.html", "<p>x</p>");
  put(`nfc-site/${nfd}`, new Uint8Array([1]));
  const r = await collectSiteFolder(path.join(tmp, "nfc-site"), "dandi");
  assert.deepEqual(r.files.map((f) => f.path).sort(), ["index.html", "사진.png".normalize("NFC")].sort());
  assert.deepEqual(decodeInlineFiles([{ path: "index.html", content: "x" }, { path: nfd, content: "AQ==", encoding: "base64" }], "p")[1].path, "사진.png".normalize("NFC"));
});

test("collectSiteFolder: 비밀값이 있으면 업로드 거부(종료 코드 20), 안내는 서버 프록시·키 숨기기 금지", async () => {
  await assert.rejects(collectSiteFolder(path.join(tmp, "secret-site"), { ...guide(), retry: 'p deploy "secret-site" --json' }), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "secret_detected");
    assert.equal(err.exitCode, 20);
    assert.match(String(err.hint), /index\.html/);
    assert.match(String(err.hint), /http:\/\/hub\/downloads\/ai-proxy-example\.md/);
    assert.doesNotMatch(String(err.hint), /dd_sk_abcdef/);
    assert.equal(err.nextStep, 'p deploy "secret-site" --json');
    assert.match(String(err.extra?.agent_instructions), /Never obfuscate, encode or split the key/);
    return true;
  });
});

test("resolveSiteFolder: outputDir → dist → build → out → 현재 폴더 순서, 못 찾으면 사용법 오류(2)와 next_step_template", async () => {
  const proj = path.join(tmp, "proj");
  assert.equal(await resolveSiteFolder(proj, undefined, "public", "p"), path.join(proj, "public"));
  assert.equal(await resolveSiteFolder(proj, undefined, undefined, "p"), path.join(proj, "dist"));
  // 폴더를 적으면 그 폴더, 맨 위에 index.html이 없으면 그 안의 dist
  assert.equal(await resolveSiteFolder(tmp, "site", undefined, "p"), path.join(tmp, "site"));
  assert.equal(await resolveSiteFolder(tmp, "proj", undefined, "p"), path.join(proj, "dist"));
  await assert.rejects(resolveSiteFolder(tmp, "empty", undefined, "p"), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "missing_index");
    assert.equal(err.exitCode, 2);
    assert.equal(err.nextStep, null);
    assert.equal(err.nextStepTemplate, 'p deploy "<폴더>" --json');
    return true;
  });
  await assert.rejects(resolveSiteFolder(path.join(tmp, "empty"), undefined, undefined, "p"), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.match(String(err.hint), /찾아본 곳: dist, build, out, 현재 폴더\./);
    return true;
  });
  await assert.rejects(resolveSiteFolder(tmp, "no-such-dir", undefined, "p"), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "folder_not_found");
    assert.equal(err.exitCode, 2);
    assert.equal(err.nextStep, null);
    return true;
  });
});

test("checkSourceFolder: 빌드 전 소스 폴더는 source_folder(20), 빌드 결과가 있으면 그 폴더를 next_step으로", async () => {
  await assert.rejects(checkSourceFolder(path.join(tmp, "vite-src"), guide(), tmp), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "source_folder");
    assert.equal(err.exitCode, 20);
    assert.match(err.message, /\/src\/main\.jsx/);
    assert.equal(err.nextStep, null);
    assert.match(String(err.nextStepTemplate), /deploy "<폴더>" --json/);
    assert.match(String(err.extra?.agent_instructions), /Build the project first/);
    assert.match(String(err.hint), /--allow-source/);
    return true;
  });
  await assert.rejects(checkSourceFolder(path.join(tmp, "vite-built"), guide(), tmp), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "source_folder");
    assert.equal(err.nextStep, "npx -y http://hub/dandi-0.2.0.tgz deploy vite-built/dist --json");
    assert.equal(err.extra?.build_folder, path.join(tmp, "vite-built", "dist"));
    assert.match(String(err.extra?.agent_instructions), /with next_step\./);
    return true;
  });
  // 빌드 결과 폴더 자체나 평범한 정적 사이트는 통과
  assert.deepEqual(await checkSourceFolder(path.join(tmp, "vite-built", "dist"), guide(), tmp), { sourceRoot: false, notes: [] });
  assert.deepEqual(await checkSourceFolder(path.join(tmp, "static-pkg"), guide(), tmp), { sourceRoot: true, notes: [] });
  assert.deepEqual(await checkSourceFolder(path.join(tmp, "site"), guide(), tmp), { sourceRoot: false, notes: [] });
});

test("checkSourceFolder: 빌드 전 Vite vanilla(/src/main.js)·build 스크립트만 있는 폴더도 거부, --allow-source면 notes로 통과", async () => {
  await assert.rejects(checkSourceFolder(path.join(tmp, "vite-vanilla"), guide(), tmp), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "source_folder");
    assert.match(err.message, /\/src\/main\.js/);
    return true;
  });
  await assert.rejects(checkSourceFolder(path.join(tmp, "needs-build"), guide(), tmp), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "source_folder");
    assert.match(err.message, /build 스크립트/);
    assert.match(String(err.extra?.agent_instructions), /Build the project first/);
    return true;
  });
  const allowed = await checkSourceFolder(path.join(tmp, "vite-vanilla"), guide(), tmp, { allowSource: true });
  assert.equal(allowed.sourceRoot, true);
  assert.deepEqual(allowed.notes.map((n) => n.kind), ["source_allowed"]);
});

test("checkSourceFolder: 코드 예시가 있는 수업 페이지는 거부하지 않고, package.json 없는 폴더는 소스 모듈이 있어도 notes만", async () => {
  assert.deepEqual(await checkSourceFolder(path.join(tmp, "lesson"), guide(), tmp), { sourceRoot: false, notes: [] });
  assert.deepEqual(await checkSourceFolder(path.join(tmp, "lesson-pkg"), guide(), tmp), { sourceRoot: true, notes: [] });
  const loose = await checkSourceFolder(path.join(tmp, "loose-src"), guide(), tmp);
  assert.equal(loose.sourceRoot, false);
  assert.deepEqual(loose.notes.map((n) => n.kind), ["source_module"]);
  assert.match(loose.notes[0].message, /\/src\/main\.jsx/);
});

test("checkSourceFolder(stdio MCP): next_step 대신 dandi_deploy_folder에 빌드 폴더를 넘기라고 안내", async () => {
  await assert.rejects(checkSourceFolder(path.join(tmp, "vite-built"), guide(), tmp, { via: "mcp" }), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.nextStep, null);
    assert.equal(err.nextStepTemplate, undefined);
    assert.match(String(err.extra?.agent_instructions), /call dandi_deploy_folder with path set to build_folder/);
    assert.ok(String(err.extra?.agent_instructions).includes(path.join(tmp, "vite-built", "dist")));
    assert.doesNotMatch(String(err.extra?.agent_instructions), /next_step/);
    assert.match(String(err.hint), /allowSource: true/);
    return true;
  });
  await assert.rejects(checkSourceFolder(path.join(tmp, "vite-src"), guide(), tmp, { via: "mcp" }), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.match(String(err.extra?.agent_instructions), /call dandi_deploy_folder with the path of the build output folder/);
    return true;
  });
});

test("findManifestDir / newManifestDir: 폴더 안 → 바로 위(다른 폴더를 올리던 dandi.json은 쓰지 않음)", async () => {
  put("mf/own/index.html", "x");
  put("mf/own/dandi.json", "{}");
  assert.equal(await findManifestDir(path.join(tmp, "mf", "own")), path.join(tmp, "mf", "own"));
  // 프로젝트 폴더의 dist: 위 폴더의 dandi.json을 쓴다
  put("mf/p1/dandi.json", JSON.stringify({ siteId: "site_a", outputDir: "" }));
  put("mf/p1/dist/index.html", "x");
  assert.equal(await findManifestDir(path.join(tmp, "mf", "p1", "dist")), path.join(tmp, "mf", "p1"));
  // outputDir이 다른 폴더를 가리키면 쓰지 않는다
  put("mf/home/dandi.json", JSON.stringify({ siteId: "site_b", outputDir: "../other/dist" }));
  put("mf/home/quiz/index.html", "x");
  assert.equal(await findManifestDir(path.join(tmp, "mf", "home", "quiz")), null);
  // outputDir이 비어 있고 siteId가 있으면(예전 CLI가 남긴 파일) 빌드 폴더가 아닌 하위 폴더에는 조용히 쓰지도, 새로 만들지도 않고 묻게 한다
  put("mf/home2/dandi.json", JSON.stringify({ siteId: "site_c", outputDir: "", title: "퀴즈" }));
  put("mf/home2/quiz/index.html", "x");
  await assert.rejects(findManifestDir(path.join(tmp, "mf", "home2", "quiz")), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "manifest_in_parent");
    assert.equal(err.exitCode, 2);
    assert.equal(err.extra?.parent_siteId, "site_c");
    return true;
  });
  // 그 폴더가 현재 폴더(또는 --dir)면 이어서 쓴다
  assert.equal(await findManifestDir(path.join(tmp, "mf", "home2", "quiz"), { adoptFrom: [path.join(tmp, "mf", "home2")] }), path.join(tmp, "mf", "home2"));
  // --site·--new-site를 직접 주면 쓰지 않는다(새 dandi.json)
  assert.equal(await findManifestDir(path.join(tmp, "mf", "home2", "quiz"), { explicitSite: true }), null);
  // outputDir이 이 폴더를 가리키면 쓴다
  put("mf/p2/dandi.json", JSON.stringify({ siteId: "site_d", outputDir: "site" }));
  put("mf/p2/site/index.html", "x");
  assert.equal(await findManifestDir(path.join(tmp, "mf", "p2", "site")), path.join(tmp, "mf", "p2"));
  assert.equal(newManifestDir(path.join(tmp, "a", "dist")), path.join(tmp, "a"));
  assert.equal(newManifestDir(path.join(tmp, "a", "내 사이트")), path.join(tmp, "a", "내 사이트"));
});

test("readManifest: UTF-16(PowerShell Out-File·>)은 읽고, ANSI(CP949)·깨진 글자는 manifest_encoding(2), 파일을 지우라고 하지 않음", async () => {
  const json = JSON.stringify({ title: "우리말 퀴즈", siteId: "site_x" });
  put("enc/utf16/dandi.json", new Uint8Array([0xff, 0xfe, ...Buffer.from(json, "utf16le")]));
  assert.equal((await readManifest(path.join(tmp, "enc", "utf16"))).manifest?.title, "우리말 퀴즈");
  put("enc/bom/dandi.json", new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(json, "utf8")]));
  assert.equal((await readManifest(path.join(tmp, "enc", "bom"))).manifest?.siteId, "site_x");
  // "우리말"을 CP949로 저장(Set-Content 기본값)
  put("enc/ansi/dandi.json", new Uint8Array([...Buffer.from('{"title":"', "latin1"), 0xbf, 0xec, 0xb8, 0xae, 0xb8, 0xbb, ...Buffer.from('","siteId":"site_x"}', "latin1")]));
  put("enc/fffd/dandi.json", JSON.stringify({ title: "\uFFFD\uFFFD 퀴즈" }));
  put("enc/broken/dandi.json", '{"title": "x",, }');
  for (const dir of ["ansi", "fffd"]) {
    await assert.rejects(readManifest(path.join(tmp, "enc", dir)), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "manifest_encoding");
      assert.equal(err.exitCode, 2);
      assert.match(String(err.hint), /Set-Content -Encoding UTF8/);
      assert.match(String(err.hint), /WriteAllText/);
      assert.match(String(err.hint), /지우지 마십시오/);
      assert.match(String(err.extra?.agent_instructions), /Never delete the file/);
      return true;
    });
  }
  await assert.rejects(readManifest(path.join(tmp, "enc", "broken")), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "manifest_parse_error");
    assert.doesNotMatch(String(err.hint), /init을 다시/);
    assert.match(String(err.hint), /지우지 마십시오/);
    return true;
  });
});

test("describeDeploy: 이미 공개한 사이트는 '허브에 다시 등록하기 전까지', 승인 필요 앱은 '학교 내부 승인 완료를 표시하기 전까지', notes는 warnings와 따로", () => {
  const base = {
    siteId: "s",
    deployId: "d",
    slug: "q",
    projectId: null,
    previewUrl: "http://p/",
    status: "preview",
    warnings: [{ path: "index.html", kind: "mobile", message: "휴대전화번호" }],
    uploaded: 1,
    reused: 0,
    notes: [{ path: "package.json", kind: "source_file", message: "빌드 설정 파일" }],
  };
  const pub = { appId: "a", appUrl: "http://h/apps/a", liveUrl: "http://q/", approvalStatus: "not_required" };
  const plain = describeDeploy({ ...base, published: pub, answers: null }, "http://h", { publishHow: "run next_step" });
  assert.match(plain.message, /허브에 다시 등록하기 전까지/);
  assert.doesNotMatch(plain.message, /publish/);
  assert.deepEqual(plain.warnings.map((w) => w.kind), ["mobile"]);
  assert.deepEqual(plain.notes.map((n) => n.kind), ["source_file"]);
  const approved = describeDeploy({ ...base, published: { ...pub, approvalStatus: "approved" }, answers: null }, "http://h", { publishHow: "run next_step" });
  assert.match(approved.message, /학교 내부 승인 완료를 표시하기 전까지/);
  const pending = describeDeploy({ ...base, published: { ...pub, approvalStatus: "pending" }, answers: null }, "http://h", { publishHow: "run next_step" });
  assert.match(pending.message, /학교 내부 승인 완료를 표시하기 전까지 공개 주소는 바뀌지 않습니다/);
  const fresh = describeDeploy({ ...base, published: null, answers: null }, "http://h", { publishHow: "run next_step" });
  assert.match(fresh.message, /아직 허브에 공개되지 않았습니다/);
});

test("describePublish: 허브 message를 그대로 쓰고, 이전 버전 유지는 liveVersion kept_until_approval로 판단", () => {
  const serverMsg = "셀프점검 답이 승인받을 때와 달라져 새 버전은 학교 내부 승인을 다시 받아야 합니다. 승인 완료를 표시할 때까지 공개 주소는 이전에 공개한 버전을 계속 보여 주고…";
  const kept = describePublish({ approvalStatus: "pending", liveVersion: "kept_until_approval", message: serverMsg, appUrl: "a", liveUrl: "l" });
  assert.equal(kept.message, serverMsg);
  assert.equal(kept.keepsLive, true);
  assert.match(kept.agent_instructions, /kept_until_approval/);
  assert.match(kept.agent_instructions, /liveUrl/);
  const approved = describePublish({ approvalStatus: "approved", liveVersion: "updated", message: null, appUrl: "a", liveUrl: "l" });
  assert.equal(approved.keepsLive, false);
  assert.match(approved.message, /승인 완료 상태를 유지/);
  assert.match(approved.agent_instructions, /approval was kept/);
  const oldHub = describePublish({ approvalStatus: "pending", liveVersion: null, message: null, appUrl: "a", liveUrl: null });
  assert.match(oldHub.message, /승인 대기/);
  assert.equal(describePublish({ approvalStatus: "not_required", liveVersion: "updated", message: null, appUrl: "a", liveUrl: "l" }).message, "허브에 공개했습니다.");
});

test("renameWithRetry: 백신 등이 잠근 파일(EPERM/EACCES/EBUSY)은 다시 시도, 다른 오류는 바로 실패", async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
  };
  await renameWithRetry("a", "b", flaky);
  assert.equal(calls, 3);

  let n = 0;
  await assert.rejects(
    renameWithRetry("a", "b", async () => {
      n++;
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    }, 3),
    /busy/,
  );
  assert.equal(n, 3);

  let m = 0;
  await assert.rejects(
    renameWithRetry("a", "b", async () => {
      m++;
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    }),
    /gone/,
  );
  assert.equal(m, 1);
});

test("decodeInlineFiles: utf8·base64, 경로·확장자·크기 검사", () => {
  const files = decodeInlineFiles(
    [
      { path: "index.html", content: "<p>안녕</p>" },
      { path: "./img/a.png", content: Buffer.from([1, 2, 3]).toString("base64"), encoding: "base64" },
    ],
    "p",
  );
  assert.deepEqual(files.map((f) => f.path), ["index.html", "img/a.png"]);
  assert.deepEqual([...files[1].bytes], [1, 2, 3]);

  const code = (input: unknown) => {
    try {
      decodeInlineFiles(input, "p");
      return "ok";
    } catch (err) {
      assert.ok(err instanceof CliError);
      return `${err.code}:${err.exitCode}`;
    }
  };
  assert.equal(code([]), "invalid_argument:2");
  assert.equal(code([{ path: "index.html" }]), "invalid_argument:2");
  assert.equal(code([{ path: "index.html", content: "x", encoding: "hex" }]), "invalid_argument:2");
  assert.equal(code([{ path: "index.html", content: "a" }, { path: "index.html", content: "b" }]), "invalid_argument:2");
  assert.equal(code([{ path: "../index.html", content: "x" }]), "invalid_path:20");
  assert.equal(code([{ path: "index.html", content: "x" }, { path: "a.exe", content: "x" }]), "disallowed_extension:20");
  assert.equal(code([{ path: "page.html", content: "x" }]), "bundle_rejected:20");
  assert.equal(code([{ path: "index.html", content: "dd_cli_zzz" }]), "secret_detected:20");
  assert.equal(code([{ path: "index.html", content: "a".repeat(5 * 1024 * 1024 + 1) }]), "bundle_rejected:20");
});

/* ---------- stdio MCP (프로세스 안에서 handle 호출) ---------- */

function server() {
  const cfg = mkdtempSync(path.join(tmp, "mcp-cfg-"));
  return createMcpServer({
    env: { DANDI_CONFIG_DIR: cfg, DANDI_HUB: "http://127.0.0.1:9" },
    cwd: tmp,
    log: () => {},
  });
}

test("MCP: initialize는 요청한 버전을 협상하고 서버 정보·도구 기능을 알림", async () => {
  const s = server();
  const res = (await s.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1" } },
  })) as { result: Record<string, unknown> };
  assert.equal(res.result.protocolVersion, "2025-06-18");
  assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(res.result.serverInfo, { name: "dandi", title: "Dandi", version: "0.2.0" });
  assert.equal(typeof res.result.instructions, "string");
  assert.ok(String(res.result.instructions).includes(APPROVAL_RULE));

  const unknown = (await s.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as {
    result: Record<string, unknown>;
  };
  assert.equal(unknown.result.protocolVersion, "2025-11-25");
  assert.equal(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("MCP: tools/list는 계약 4장의 도구와 stdio 전용 도구를 모두 알림", async () => {
  const s = server();
  const res = (await s.handle({ jsonrpc: "2.0", id: "a", method: "tools/list" })) as {
    id: string;
    result: { tools: { name: string; description: string; inputSchema: { type: string } }[] };
  };
  assert.equal(res.id, "a");
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "dandi_deploy_files",
    "dandi_deploy_folder",
    "dandi_get_skill",
    "dandi_list_my_sites",
    "dandi_login",
    "dandi_privacy_questions",
    "dandi_publish_site",
    "dandi_search_skills",
    "dandi_whoami",
  ]);
  for (const t of res.result.tools) assert.equal(t.inputSchema.type, "object", t.name);
  const publish = MCP_TOOLS.find((t) => t.name === "dandi_publish_site");
  assert.ok(publish?.description.includes("교사가 셀프점검 5문항에 직접 답하고 확인하기 전에는 호출하지 마십시오"));
  // 승인 대기는 ⑤가 정한다(①이 아님)
  assert.ok(publish?.description.includes(APPROVAL_RULE));
  assert.ok(!publish?.description.includes("학생 개인정보를 다루면 학교 내부 승인 대기"));
});

test("MCP: ping, 알 수 없는 메서드·도구, 잘못된 요청", async () => {
  const s = server();
  assert.deepEqual(await s.handle({ jsonrpc: "2.0", id: 3, method: "ping" }), { jsonrpc: "2.0", id: 3, result: {} });
  const missing = (await s.handle({ jsonrpc: "2.0", id: 4, method: "nope/nope" })) as { error: { code: number } };
  assert.equal(missing.error.code, -32601);
  const tool = (await s.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "no_such_tool", arguments: {} } })) as {
    error: { code: number };
  };
  assert.equal(tool.error.code, -32602);
  const invalid = (await s.handle({ id: 6, method: "ping" })) as { error: { code: number } };
  assert.equal(invalid.error.code, -32600);
  assert.equal(await s.handle({ jsonrpc: "2.0", id: 7, result: {} }), null);
});

test("MCP: server/discover와 요청별 _meta(2026-07-28 개정)", async () => {
  const s = server();
  const d = (await s.handle({ jsonrpc: "2.0", id: 1, method: "server/discover" })) as { result: Record<string, unknown> };
  assert.deepEqual(d.result.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(d.result.capabilities, { tools: { listChanged: false } });
  const list = (await s.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
  })) as { result: { _meta: Record<string, unknown> } };
  assert.deepEqual(list.result._meta["io.modelcontextprotocol/serverInfo"], { name: "dandi", title: "Dandi", version: "0.2.0" });
});

test("MCP: 셀프점검 문항은 로그인 없이(⑤ 규칙 포함), 다른 도구는 로그인 안내를 도구 결과로 돌려줌", async () => {
  const s = server();
  const q = (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "dandi_privacy_questions" } })) as {
    result: { content: { type: string; text: string }[]; isError?: boolean; structuredContent: { questions: unknown[]; rule: string } };
  };
  assert.equal(q.result.isError, undefined);
  assert.match(q.result.content[0].text, /①[\s\S]*⑤/);
  assert.ok(q.result.content[0].text.includes(APPROVAL_RULE));
  assert.ok(!q.result.content[0].text.includes('①이 "예"이면 앱은'));
  assert.equal(q.result.structuredContent.questions.length, 5);
  assert.ok(q.result.structuredContent.rule.startsWith(APPROVAL_RULE));

  const who = (await s.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dandi_whoami", arguments: {} } })) as {
    result: { content: { text: string }[]; isError: boolean; structuredContent: { error: { code: string } } };
  };
  assert.equal(who.result.isError, true);
  assert.equal(who.result.structuredContent.error.code, "login_required");
  assert.match(who.result.content[0].text, /dandi_login/);

  const bad = (await s.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "dandi_deploy_folder", arguments: { path: 42 } },
  })) as { result: { isError: boolean; structuredContent: { error: { code: string } } } };
  assert.equal(bad.result.isError, true);
  assert.equal(bad.result.structuredContent.error.code, "invalid_argument");
});

test("createCtx: 비대화형 입력은 에이전트 모드", () => {
  const ctx = createCtx({ env: {}, stdinIsTTY: false });
  assert.equal(ctx.agent, true);
  assert.equal(ctx.client, "non-interactive");
  assert.equal(createCtx({ env: {}, stdinIsTTY: true }).agent, false);
});
