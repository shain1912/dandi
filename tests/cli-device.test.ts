import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";

// 브라우저 승인 로그인(F-53) 서버 쪽 lib 테스트: 요청한 곳 표시와 로그인 시작 속도 제한(QA R12).
// src/lib/device-auth.ts는 서버 전용(server-only, next/headers)이고 확장자 없는 상대 경로를 쓰므로,
// 이 파일 안에서만 쓰는 로더로 해석한다(tests/books.test.ts와 같은 방법).
const ROOT = new URL("../", import.meta.url).href;
const HOOKS = `
const ROOT = ${JSON.stringify(ROOT)};
const stub = (src) => ({ url: "data:text/javascript," + encodeURIComponent(src), shortCircuit: true });
export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return stub("export default null");
  if (specifier === "next/headers") return stub("export async function headers(){return new Headers()} export async function cookies(){return {get(){return undefined},set(){}}}");
  if (specifier.startsWith("@/")) specifier = new URL("src/" + specifier.slice(2), ROOT).href;
  try {
    return await next(specifier, context);
  } catch (err) {
    if ((specifier.startsWith(".") || specifier.startsWith("file:")) && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
      for (const ext of [".ts", ".tsx"]) {
        try { return await next(specifier + ext, context); } catch {}
      }
    }
    throw err;
  }
}`;
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`);

// db.ts가 가져올 때 저장 위치를 정하므로 먼저 임시 폴더를 지정한다(프로젝트 data/는 건드리지 않는다).
const dataDir = mkdtempSync(path.join(os.tmpdir(), "dandi-device-test-"));
process.env.DANDI_DATA_DIR = dataDir;

const device = await import("../src/lib/device-auth.ts");

after(() => rmSync(dataDir, { recursive: true, force: true }));

const HUB = "http://localhost:3000";

test("friendlyIp: 프록시 없이 알 수 없는 IP(local)는 허브를 localhost로 열었어도 '확인할 수 없음'", () => {
  assert.equal(device.friendlyIp("local"), "확인할 수 없음");
  assert.equal(device.friendlyIp("unknown"), "확인할 수 없음");
  assert.equal(device.friendlyIp(""), "확인할 수 없음");
  // 믿을 수 있는 프록시가 알려 준 실제 주소
  assert.equal(device.friendlyIp("127.0.0.1"), "이 컴퓨터");
  assert.equal(device.friendlyIp("::1"), "이 컴퓨터");
  assert.equal(device.friendlyIp("203.0.113.7"), "203.0.113.7");
});

test("startRateLimited: 실제 IP는 IP별 1분 10회, 모르는 IP는 공용 1분 120회 + client·hostname별 1분 10회", () => {
  const now = Date.parse("2026-09-29T00:10:00.000Z");
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();
  const rows = (n: number, row: { ip: string; client: string; hostname: string }, secondsAgo = 10) =>
    Array.from({ length: n }, () => ({ ...row, createdAt: at(secondsAgo) }));

  // 실제 IP: 같은 IP 10회까지
  const ipRows = rows(9, { ip: "203.0.113.7", client: "claude-code", hostname: "pc1" });
  assert.equal(device.startRateLimited(ipRows, { ip: "203.0.113.7", client: "codex", hostname: "pc2" }, now), false);
  const ipFull = rows(10, { ip: "203.0.113.7", client: "claude-code", hostname: "pc1" });
  assert.equal(device.startRateLimited(ipFull, { ip: "203.0.113.7", client: "codex", hostname: "pc2" }, now), true);
  assert.equal(device.startRateLimited(ipFull, { ip: "203.0.113.8", client: "codex", hostname: "pc2" }, now), false);
  // 1분이 지난 요청은 세지 않는다
  assert.equal(device.startRateLimited(rows(10, { ip: "203.0.113.7", client: "x", hostname: "y" }, 61), { ip: "203.0.113.7", client: "x", hostname: "y" }, now), false);

  // IP를 모름: 한 클라이언트(같은 client+hostname)는 10회까지, 다른 컴퓨터는 막지 않는다(예전 공용 30회 한도로 연수장이 막히던 문제)
  const oneClient = rows(10, { ip: "local", client: "claude-code", hostname: "teacher-pc-1" });
  assert.equal(device.startRateLimited(oneClient, { ip: "local", client: "claude-code", hostname: "teacher-pc-1" }, now), true);
  assert.equal(device.startRateLimited(oneClient, { ip: "local", client: "claude-code", hostname: "teacher-pc-2" }, now), false);
  const classroom = Array.from({ length: 40 }, (_, i) => ({ ip: "local", client: "claude-code", hostname: `pc-${i}`, createdAt: at(5) }));
  assert.equal(device.startRateLimited(classroom, { ip: "local", client: "codex", hostname: "pc-41" }, now), false);
  // 공용 한도 120회는 이름을 바꿔 가며 보내도 넘지 못한다
  const flood = Array.from({ length: 120 }, (_, i) => ({ ip: i % 2 ? "local" : "unknown", client: `c${i}`, hostname: `h${i}`, createdAt: at(5) }));
  assert.equal(device.startRateLimited(flood, { ip: "local", client: "new", hostname: "new" }, now), true);
  // 공용 묶음은 실제 IP 요청과 섞이지 않는다
  assert.equal(device.startRateLimited(flood, { ip: "203.0.113.9", client: "new", hostname: "new" }, now), false);
});

test("startDeviceAuth: 프록시 없는 허브(local)에서 한 클라이언트가 한도를 넘겨도 다른 교사의 로그인은 막히지 않음", async () => {
  const flooder = { client: "curl", hostname: "attacker", os: "linux" };
  for (let i = 0; i < 10; i++) {
    const r = await device.startDeviceAuth(flooder, "local", HUB);
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  const blocked = await device.startDeviceAuth(flooder, "local", HUB);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.status, 429);
    assert.equal(blocked.code, "rate_limited");
  }
  const teacher = await device.startDeviceAuth({ client: "claude-code", hostname: "teacher-pc", os: "win32 10.0.26200" }, "local", HUB);
  assert.equal(teacher.ok, true, JSON.stringify(teacher));
  if (teacher.ok) {
    assert.match(teacher.value.user_code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    assert.equal(teacher.value.verification_uri, `${HUB}/device`);
    const view = await device.getDeviceAuthByUserCode(teacher.value.user_code);
    assert.equal(view?.ip, "local");
    assert.equal(device.friendlyIp(view?.ip ?? ""), "확인할 수 없음");
  }
});
