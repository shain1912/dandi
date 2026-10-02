"use client";

import { useState } from "react";
import { maskPII, scanPII } from "@/lib/pii";

// 모두 가짜 값이다(0으로 채운 번호, example.com 도메인).
const SAMPLES = [
  {
    label: "가정통신문 초안",
    text:
      "3학년 2반 학부모님께\n현장체험학습 신청서는 9월 30일까지 제출해 주십시오.\n" +
      "문의는 담임 휴대전화 010-0000-0000 또는 이메일 teacher@example.com으로 연락해 주십시오.\n" +
      "행정실 전화: 02-000-0000",
  },
  {
    label: "학생 명단을 붙여 넣은 실수",
    text:
      "홍길동 000101-3000000 보호자 010.0000.0000\n" +
      "김예시 0001014000000 보호자 연락처01000000000\n" +
      "방과후 수강료 결제 카드 4111-1111-1111-1111",
  },
  {
    label: "오탐 확인(개인정보 없음)",
    text:
      "2026-09-17 17:00 교과협의회\n3학년 2반 15번 발표\n예산 1,000,000원\n교실 302호\n버전 16.3.6",
  },
];

const RULES = [
  "주민등록번호·외국인등록번호 (하이픈·공백 유무 무관)",
  "휴대전화번호 (010 등, 구분자 없이 붙여 써도 감지)",
  "지역번호 전화·인터넷전화 (02, 031~064, 070)",
  "이메일 주소",
  "카드번호 (13~19자리, Luhn 검사를 통과하는 번호)",
];

export function PiiView() {
  const [text, setText] = useState("");
  const matches = scanPII(text);
  const masked = maskPII(text);

  return (
    <>
      <p className="filter">
        {SAMPLES.map((s) => (
          <button key={s.label} type="button" onClick={() => setText(s.text)}>
            예시: {s.label}
          </button>
        ))}
        <button type="button" onClick={() => setText("")}>
          지우기
        </button>
      </p>

      <label className="field">
        <span>검사할 글</span>
        <textarea
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="게시글, 앱 설명, AI에 보낼 프롬프트 등을 붙여 넣으십시오. 입력한 내용은 서버로 보내지 않습니다."
          aria-invalid={matches.length > 0}
        />
      </label>

      <h2>감지 결과</h2>
      {text.trim() === "" ? (
        <p className="muted">글을 입력하거나 예시를 선택하십시오.</p>
      ) : matches.length === 0 ? (
        <p>감지된 개인정보가 없습니다. 이 글은 그대로 등록할 수 있습니다.</p>
      ) : (
        <>
          <p className="notice" role="alert">
            개인정보로 보이는 항목 {matches.length}건을 찾았습니다. 작성 화면에서는 등록이 차단되고(1차 클라이언트 필터),
            필터를 우회하더라도 서버가 저장 전에 *** 로 가립니다(2차 서버 마스킹).
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>종류</th>
                  <th>감지된 값</th>
                  <th>위치(글자)</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m) => (
                  <tr key={`${m.index}-${m.value}`}>
                    <td>
                      <span className="badge warn">{m.label}</span>
                    </td>
                    <td>
                      <code>{m.value}</code>
                    </td>
                    <td>{m.index + 1}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>서버 저장 시 모습 (마스킹 미리보기)</h2>
      <pre aria-live="polite">{text ? masked.text : " "}</pre>
      <p className="muted">
        가린 항목 {masked.count}건{masked.labels.length ? ` · ${masked.labels.join(", ")}` : ""}
      </p>

      <h2>검사 규칙</h2>
      <ul>
        {RULES.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p className="muted">
        날짜, 시간, 학년·반·번호, 금액, 호실, 버전 번호처럼 숫자가 많은 일반 문장은 감지하지 않도록 조정되어 있습니다.
        이름·주소처럼 형식이 정해지지 않은 개인정보는 자동으로 찾지 못하므로 직접 확인하십시오.
      </p>
    </>
  );
}
