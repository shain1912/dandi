// 개인정보(PII) 검사기. 클라이언트 1차 필터(F-13)와 서버 2차 마스킹(F-14)이 같은 규칙을 사용한다.
// 브라우저에서도 import되므로 Node 전용 API를 사용하지 않는다.

export type PiiType = "rrn" | "mobile" | "phone" | "email" | "card";

export interface PiiMatch {
  type: PiiType;
  label: string;
  value: string;
  index: number;
}

interface PiiRule {
  type: PiiType;
  label: string;
  pattern: RegExp;
  /** 매치 중 실제로 인정할 길이. 0이면 버린다. 없으면 매치 전체를 인정한다. */
  accept?: (value: string, scan: string, end: number) => number;
}

// 검사용 사본. 글자를 한 글자(UTF-16 코드 단위)씩 1:1로만 바꿔 원문과 인덱스가 어긋나지 않게 한다.
// 전각 문자 → 반각, 각종 대시·밑줄·소프트 하이픈 → '-', 특수 공백(탭, NBSP, U+3000 등) → ' '
const FULLWIDTH = /[\uFF01-\uFF5E]/g;
const DASHES = /[_\u00AD\u2010-\u2015\u2212\uFE63]/g;
const SPACES = /[\t\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function toScanText(text: string): string {
  return text
    .replace(FULLWIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(DASHES, "-")
    .replace(SPACES, " ");
}

// 모든 반복에 상한을 두고 이메일은 왼쪽 경계를 고정해, 한 위치에서 드는 일이 상수로 묶인다(입력 길이에 선형).
// 숫자 경계는 \b 대신 lookaround로 잡는다. 한글 바로 옆에 붙은 번호("연락처01012345678")도 잡기 위해서다.
// 번호 묶음 사이 구분자: 공백 0~2개 + ('-'·'.'·줄바꿈 중 하나, 없어도 됨) + 공백 0~2개
const SEP = String.raw`[ ]{0,2}(?:[-.]|\r?\n)?[ ]{0,2}`;

/** 휴대전화·지역번호 공통 틀. code는 앞자리 0을 뺀 식별번호다. */
function telPattern(code: string): RegExp {
  // (010) · 010) · +82 10 · +82 (0)10 · +82-010 형태의 앞부분
  const head = String.raw`(?:\+82${SEP}(?:\(0\)[ ]?)?0?${code}|\(0${code}\)|0${code}\)?)`;
  return new RegExp(String.raw`(?<!\d)${head}${SEP}\d{3,4}${SEP}\d{4}(?!\d)`, "g");
}

/**
 * 소수 부분(예: 3.0212345678)은 전화번호로 보지 않는다. 구분자 없이 붙은 숫자가 "숫자." 바로 뒤에 올 때만 제외한다.
 * 쉼표로 이은 연락처 목록(010-…,010-…)이나 번호 목록(1. 010-…)은 계속 가린다.
 */
function telLength(value: string, scan: string, end: number): number {
  const start = end - value.length;
  if (scan[start - 1] !== "." || !/^\d+$/.test(value)) return value.length;
  // 정수 부분이 1~6자리일 때만 소수로 본다(01012345678.01023456789처럼 번호를 점으로 이은 경우는 가린다).
  const intPart = /(?:^|\D)(\d+)$/.exec(scan.slice(Math.max(0, start - 8), start - 1));
  return intPart && intPart[1].length <= 6 ? 0 : value.length;
}

// 파일 확장자와 겹치는 최상위 도메인. logo@2x.png 같은 이미지 이름을 이메일로 보지 않는다.
const FILE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp",
  "js", "mjs", "ts", "tsx", "css", "md", "json", "html", "git", "zip", "pdf",
]);

function emailLength(value: string, scan: string, end: number): number {
  if (FILE_EXTS.has(value.slice(value.lastIndexOf(".") + 1).toLowerCase())) return 0;
  // git@github.com:school/quiz.git 같은 SSH 저장소 주소. 콜론 뒤가 "소유자/저장소" 경로일 때만 제외한다
  // (kim@school.kr:pw1234, kim@school.kr:010-... 처럼 뒤에 비밀번호·번호가 붙은 경우는 계속 가린다).
  if (scan[end] === ":" && /^[\w.~-]+\/[\w./-]+/.test(scan.slice(end + 1, end + 201))) return 0;
  return value.length;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// 발급사 식별번호 첫 자리: 3(아멕스·JCB·다이너스), 4(비자), 5·22~27(마스터), 6(유니온페이 등), 9(국내 전용).
// 시각(0000~2359)으로 시작하는 시간표와 ISBN(978·979)은 여기서 걸러진다.
const CARD_IIN = /^(?:[3-6]|2[2-7]|9(?!7[89]))/;

// 구분자 없이 붙여 쓴 숫자는 오탐이 많아(주문·계좌번호 등) 실제 카드 브랜드의 식별번호·길이 조합만 인정한다.
const CONTIGUOUS_CARD = [
  /^4(?:\d{12}|\d{15}|\d{18})$/, // Visa 13·16·19
  /^3[47]\d{13}$/, // Amex 15
  /^(?:5[1-5]\d{14}|2(?:2[2-9]|[3-6]\d|7[01])\d{13}|2720\d{12})$/, // Mastercard 16
  /^35\d{14,17}$/, // JCB 16~19
  /^62\d{14,17}$/, // UnionPay 16~19
  /^(?:6011|64[4-9]\d|65\d{2})\d{12}$/, // Discover 16
  /^9(?!7[89])\d{15}$/, // 국내 전용 16
];

/** 뒤 묶음을 하나씩 떼어 보며 가장 긴 유효 카드번호 길이를 고른다(뒤에 CVC 등이 붙은 경우). */
function cardLength(value: string): number {
  if (!CARD_IIN.test(value)) return 0;
  if (/^\d+$/.test(value)) {
    return CONTIGUOUS_CARD.some((re) => re.test(value)) && luhn(value) ? value.length : 0;
  }
  let cut = value.length;
  while (cut > 0) {
    const digits = value.slice(0, cut).replace(/\D/g, "");
    if (digits.length < 13) break;
    if (digits.length <= 19 && luhn(digits)) return cut;
    cut = Math.max(value.lastIndexOf("-", cut - 1), value.lastIndexOf(" ", cut - 1));
  }
  return 0;
}

const RULES: PiiRule[] = [
  {
    // 주민등록번호·외국인등록번호: 생년월일 6자리 + 성별 자리(1~8) + 6자리
    type: "rrn",
    label: "주민등록번호",
    pattern: /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[ ]{0,2}(?:-|\r?\n)?[ ]{0,2}[1-8]\d{6}(?!\d)/g,
  },
  {
    type: "mobile",
    label: "휴대전화번호",
    pattern: telPattern("1[016789]"),
    accept: telLength,
  },
  {
    // 지역번호(02, 031~064), 인터넷전화(070)
    type: "phone",
    label: "전화번호",
    pattern: telPattern("(?:2|[3-6][1-5]|70)"),
    accept: telLength,
  },
  {
    // 왼쪽 lookbehind가 없으면 긴 영문 덩어리에서 시작 위치마다 다시 훑어 입력 길이의 제곱 시간이 든다.
    type: "email",
    label: "이메일",
    pattern:
      /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g,
    accept: emailLength,
  },
  {
    // 13~19자리 연속 숫자, 또는 4자리로 시작해 '-'나 ' ' 하나로 나뉜 묶음(4-4-4-4, 4-6-5 등). Luhn 검사 필수.
    type: "card",
    label: "카드번호",
    pattern: /(?<!\d)(?:\d{13,19}|\d{4}[- ]\d{4,6}(?:[- ]\d{3,6}){1,3})(?!\d)/g,
    accept: cardLength,
  },
];

export const PII_MASK = "***";

interface Candidate {
  rule: number;
  start: number;
  end: number;
}

/** 텍스트에서 개인정보 패턴을 찾는다. 겹치면 더 긴 매치가, 길이가 같으면 앞 규칙이 우선한다. */
export function scanPII(text: string): PiiMatch[] {
  if (!text) return [];
  const scan = toScanText(text);
  const found: Candidate[] = [];
  RULES.forEach((rule, i) => {
    const re = rule.pattern;
    re.lastIndex = 0;
    for (let m = re.exec(scan); m; m = re.exec(scan)) {
      const start = m.index;
      const len = rule.accept ? rule.accept(m[0], scan, start + m[0].length) : m[0].length;
      if (len > 0) found.push({ rule: i, start, end: start + len });
      // 버린 매치 안쪽에서 다시 찾을 수 있게 한 칸만 넘긴다.
      re.lastIndex = len > 0 ? start + len : start + 1;
    }
  });

  let kept = found;
  if (found.length > 1) {
    found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.rule - b.rule || a.start - b.start);
    const taken = new Uint8Array(text.length);
    kept = found.filter((c) => {
      for (let i = c.start; i < c.end; i++) if (taken[i]) return false;
      taken.fill(1, c.start, c.end);
      return true;
    });
    kept.sort((a, b) => a.start - b.start);
  }
  return kept.map((c) => ({
    type: RULES[c.rule].type,
    label: RULES[c.rule].label,
    value: text.slice(c.start, c.end),
    index: c.start,
  }));
}

export function hasPII(text: string): boolean {
  return scanPII(text).length > 0;
}

/** 찾은 개인정보를 모두 `***`로 바꾼다. */
export function maskPII(text: string): { text: string; count: number; labels: string[] } {
  const matches = scanPII(text);
  if (matches.length === 0) return { text, count: 0, labels: [] };
  let out = "";
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.index) + PII_MASK;
    cursor = m.index + m.value.length;
  }
  out += text.slice(cursor);
  return {
    text: out,
    count: matches.length,
    labels: [...new Set(matches.map((m) => m.label))],
  };
}

/** 여러 필드를 한 번에 마스킹한다. 서버 액션에서 저장 직전에 사용한다. */
export function maskFields<T extends Record<string, string>>(
  fields: T,
): { values: T; count: number; labels: string[] } {
  const values = { ...fields };
  let count = 0;
  const labels = new Set<string>();
  for (const key of Object.keys(values) as (keyof T)[]) {
    const r = maskPII(values[key]);
    values[key] = r.text as T[keyof T];
    count += r.count;
    r.labels.forEach((l) => labels.add(l));
  }
  return { values, count, labels: [...labels] };
}
