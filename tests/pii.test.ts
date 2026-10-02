import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPII, maskFields, maskPII, PII_MASK, scanPII } from "../src/lib/pii.ts";
import type { PiiType } from "../src/lib/pii.ts";

/** 문자열 전체가 한 건으로 잡히고 통째로 가려지는지 확인한다. */
function assertWhole(s: string, type: PiiType) {
  const found = scanPII(s);
  assert.equal(found.length, 1, `${s} → ${JSON.stringify(found)}`);
  assert.equal(found[0].type, type, s);
  assert.equal(found[0].value, s, s);
  assert.equal(found[0].index, 0, s);
  assert.equal(maskPII(s).text, PII_MASK, s);
}

function assertClean(s: string) {
  assert.deepEqual(scanPII(s), [], s);
  assert.equal(hasPII(s), false, s);
  assert.equal(maskPII(s).text, s, s);
}

test("주민등록번호: 하이픈 유무·공백 모두 감지", () => {
  for (const s of ["900101-1234567", "9001011234567", "900101 - 2234567"]) {
    assert.equal(scanPII(`번호 ${s} 입니다`)[0]?.type, "rrn", s);
  }
});

test("주민등록번호: 날짜가 아닌 13자리는 무시", () => {
  assert.equal(hasPII("주문번호 9913451234567"), false);
});

test("휴대전화: 구분자 유무와 한글 인접 모두 감지", () => {
  for (const s of ["010-1234-5678", "01012345678", "010.123.4567", "연락처01012345678"]) {
    assert.equal(scanPII(s)[0]?.type, "mobile", s);
  }
});

test("지역번호 전화와 이메일, 카드번호 감지", () => {
  assert.equal(scanPII("학교 051-123-4567")[0]?.type, "phone");
  assert.equal(scanPII("문의 02-1234-5678")[0]?.type, "phone");
  assert.equal(scanPII("메일 teacher.kim@school.go.kr")[0]?.type, "email");
  assert.equal(scanPII("4111-1111-1111-1111")[0]?.type, "card");
});

test("휴대전화: 괄호·국가번호·넓은 구분자 형태도 번호 전체를 감지", () => {
  for (const s of [
    "(010)1234-5678",
    "(010) 1234-5678",
    "010)1234-5678",
    "+82 10-1234-5678",
    "+82-10-1234-5678",
    "+821012345678",
    "+82 (0)10-1234-5678",
    "+82-010-1234-5678",
    "010 - 1234 - 5678",
    "010  1234  5678",
    "010\n1234\n5678",
    "011-123-4567",
  ]) {
    assertWhole(s, "mobile");
  }
});

test("지역번호: 구분자 없는 번호와 +82 국가번호도 감지", () => {
  for (const s of [
    "0212345678",
    "0311234567",
    "+82-2-123-4567",
    "+82 31 123 4567",
    "(02)123-4567",
    "02)1234-5678",
    "070-1234-5678",
    "064 123 4567",
  ]) {
    assertWhole(s, "phone");
  }
});

test("숫자가 더 붙은 긴 숫자열은 일부만 잘라 잡지 않음", () => {
  for (const s of [
    "01012345678901",
    "1010-1234-5678",
    "010-1234-56789",
    "(010)1234-56789",
    "+82101234567890",
    "02123456789012",
    "031123456789",
    "9001011234567890",
  ]) {
    assertClean(s);
  }
});

test("유니코드 대시·전각 숫자·전각 괄호·전각 공백을 반각처럼 처리", () => {
  for (const s of ["010–1234–5678", "010—1234—5678", "010－1234－5678", "０１０-１２３４-５６７８", "（010）1234-5678"]) {
    assertWhole(s, "mobile");
  }
  for (const s of ["900101–1234567", "900101 – 1234567", "９００１０１－１２３４５６７"]) {
    assertWhole(s, "rrn");
  }
  // 눈으로 구분하기 어려운 글자는 코드 포인트로 만든다.
  // ‐ ‑ ‒ – — ― − ﹣ － 와 소프트 하이픈(U+00AD)
  for (const cp of [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe63, 0xff0d, 0x00ad]) {
    const d = String.fromCharCode(cp);
    assertWhole(`010${d}1234${d}5678`, "mobile");
    assertWhole(`900101${d}1234567`, "rrn");
    assertWhole(`900101 ${d} 1234567`, "rrn");
  }
  // 전각 공백(U+3000), NBSP, 탭
  for (const cp of [0x3000, 0x00a0, 0x09]) {
    const sp = String.fromCharCode(cp);
    assertWhole(`010${sp}1234${sp}5678`, "mobile");
    assertWhole(`900101${sp}-${sp}1234567`, "rrn");
  }
});

test("검사용 사본을 써도 인덱스와 값은 원문 기준", () => {
  const s = "😀 전화：０１０－１２３４－５６７８ 끝";
  const [m] = scanPII(s);
  assert.equal(m.type, "mobile");
  assert.equal(m.index, s.indexOf("０"));
  assert.equal(m.value, "０１０－１２３４－５６７８");
  assert.equal(maskPII(s).text, "😀 전화：*** 끝");
});

test("밑줄로 이어 쓴 번호도 감지하고, 밑줄이 든 이메일은 그대로 이메일", () => {
  const phone = maskPII("홍길동_010_1234_5678");
  assert.equal(phone.text, "홍길동_***");
  assert.deepEqual(phone.labels, ["휴대전화번호"]);

  const rrn = scanPII("홍길동_900101_1234567");
  assert.equal(rrn.length, 1);
  assert.equal(rrn[0].type, "rrn");
  assert.equal(rrn[0].value, "900101_1234567");

  assertWhole("kim_t@school.kr", "email");
  assert.equal(maskPII("메일 kim_t@school.kr 입니다").text, "메일 *** 입니다");
});

test("이메일: 파일 이름·SSH 저장소 주소는 이메일이 아님", () => {
  const exts = ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "js", "mjs", "ts", "tsx", "css", "md", "json", "html", "git", "zip", "pdf"];
  for (const ext of exts) {
    assertClean(`images/logo@2x.${ext}`);
    assertClean(`icon@3x.${ext.toUpperCase()}`);
  }
  assertClean("git@github.com:school/quiz.git");
  assertClean("git clone git@github.com:school/quiz.git");
  // 콜론 뒤가 공백·한글이면 평범한 문장 속 이메일이다.
  assert.equal(maskPII("메일 kim@school.kr: 확인").text, "메일 ***: 확인");
  assert.equal(maskPII("kim@school.kr:연락").text, "***:연락");
});

test("카드번호: Luhn이 맞는 13~19자리만, 연속 숫자와 묶음 형태 모두 감지", () => {
  for (const s of [
    "4111111111111111",
    "4111-1111-1111-1111",
    "4111 1111 1111 1111",
    "5555-5555-5555-4444",
    "2223 0000 4840 0011",
    "3782-822463-10005",
    "378282246310005",
  ]) {
    assertWhole(s, "card");
  }
  // 뒤에 CVC가 붙어도 카드번호 부분만 가린다.
  assert.equal(maskPII("카드 4111 1111 1111 1111 123").text, "카드 *** 123");
});

test("카드번호: Luhn 불일치·시간표·0으로 시작하는 번호는 무시", () => {
  for (const s of [
    "1234-5678-9012-3456",
    "4111-1111-1111-1112",
    "시간표 0850-0935 0945-1030",
    "시간표 1300-1350 1400-1450 1500-1550",
    "0000-0000-0000-0000",
    "ISBN 9788912345671",
    "2025 2026 2027 2028",
  ]) {
    assertClean(s);
  }
});

test("겹치는 매치는 가장 긴 것이 이김", () => {
  const r = maskPII("kim.01012345678@gmail.com");
  assert.equal(r.text, "***");
  assert.equal(r.count, 1);
  assert.deepEqual(r.labels, ["이메일"]);
  assert.equal(maskPII("01012345678@naver.com").text, "***");
  // 길이가 같으면 앞 규칙(주민등록번호)이 이긴다. 9001011234563은 Luhn도 맞다.
  const tie = scanPII("9001011234563");
  assert.equal(tie.length, 1);
  assert.equal(tie[0].type, "rrn");
});

test("여러 매치는 원문 순서대로 돌려줌", () => {
  const s = "메일 a@b.co 전화 010-1234-5678 카드 4111-1111-1111-1111 주민 900101-1234567";
  const found = scanPII(s);
  assert.deepEqual(
    found.map((m) => m.type),
    ["email", "mobile", "card", "rrn"],
  );
  for (const m of found) assert.equal(s.slice(m.index, m.index + m.value.length), m.value);
  assert.equal(maskPII(s).text, "메일 *** 전화 *** 카드 *** 주민 ***");
});

test("일반 숫자·날짜·시간은 오탐하지 않음", () => {
  for (const s of [
    "2026-09-17 17:00",
    "3학년 2반 15번",
    "예산 1,000,000원",
    "버전 16.3.6",
    "교실 302호",
    "2026.09.28",
    "09:00~10:30",
    "2026-09-28 09:00~10:30",
    "학번 20231234",
    "010",
    "1.0.10",
    "next@16.3.6",
    "user@localhost",
  ]) {
    assertClean(s);
  }
});

test("긴 입력도 선형 시간: 100만 자 입력이 넉넉한 제한 시간 안에 끝남", () => {
  const N = 1_000_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const inputs: [string, string][] = [
    ["영문 한 덩어리", "a".repeat(N)],
    ["숫자 한 덩어리", "1".repeat(N)],
    ["점으로 이은 영문", fill("a.")],
    ["@ 반복", fill("a@")],
    ["긴 로컬 파트", fill("x".repeat(63) + "@")],
    ["도메인 라벨 반복", fill("a@" + "b.".repeat(40))],
    ["4자리 묶음 반복", fill("1111 ")],
    ["전각 숫자", "０".repeat(N)],
    ["밑줄", "_".repeat(N)],
  ];
  for (const [name, s] of inputs) {
    const t = performance.now();
    scanPII(s);
    const ms = performance.now() - t;
    assert.ok(ms < 2000, `${name}: ${ms.toFixed(0)}ms`);
  }

  // 매치가 아주 많은 경우도 선형이어야 한다.
  const unit = "연락 010-1234-5678 kim@school.kr 카드 4111-1111-1111-1111 ";
  const s = unit.repeat(Math.floor(N / unit.length));
  const t = performance.now();
  const r = maskPII(s);
  const ms = performance.now() - t;
  assert.ok(ms < 2000, `매치 다수: ${ms.toFixed(0)}ms`);
  assert.equal(r.count, Math.floor(N / unit.length) * 3);
});

test("maskPII는 매치를 ***로 바꾸고 개수와 종류를 알려 줌", () => {
  const r = maskPII("엄마 010-1111-2222, 메일 a@b.co 로 연락");
  assert.equal(r.text, "엄마 ***, 메일 *** 로 연락");
  assert.equal(r.count, 2);
  assert.deepEqual(r.labels.sort(), ["이메일", "휴대전화번호"].sort());
});

test("maskFields는 여러 필드를 한 번에 마스킹", () => {
  const r = maskFields({ title: "제목", body: "주민번호 900101-1234567" });
  assert.equal(r.values.body, "주민번호 ***");
  assert.equal(r.values.title, "제목");
  assert.equal(r.count, 1);
});

test("회귀: 이메일 뒤에 콜론과 비밀번호·번호가 붙어도 가림(SSH 저장소 주소만 제외)", () => {
  assert.equal(maskPII("a@b.com:pw1234").text, "***:pw1234");
  assert.equal(maskPII("kim@school.kr:010-1234-5678").text, "***:***");
  assertClean("git@github.com:school/quiz.git");
});

test("회귀: 구분자 없는 숫자는 실제 카드 브랜드 식별번호·길이일 때만 카드번호", () => {
  assertWhole("4111111111111111", "card");
  assertWhole("378282246310005", "card");
  assertWhole("5555555555554444", "card");
  // Luhn은 맞지만 브랜드 규칙에 맞지 않는 긴 숫자(주문·계좌번호 등)는 무시
  for (const s of ["3000000000000004", "6000000000000002", "9790000000000001"]) assertClean(s);
});

test("회귀: 소수점 뒤 숫자는 전화번호가 아님", () => {
  assertClean("3.0212345678");
  assertClean("0.0312345678");
  assertWhole("0212345678", "phone");
});

test("회귀: 쉼표로 이은 연락처 목록과 번호 목록의 번호를 모두 가림", () => {
  assert.equal(maskPII("010-1234-5678,010-2345-6789").text, "***,***");
  assert.equal(maskPII("02-123-4567, 031-123-4567").text, "***, ***");
  assert.equal(maskPII("1.010-1234-5678").text, "1.***");
  assert.equal(maskPII("1. 010-1234-5678").text, "1. ***");
  assert.equal(maskPII("연락처 01012345678.01023456789").text, "연락처 ***.***");
  assertClean("3.0212345678");
});
