# 미니앱에서 Dandi AI 게이트웨이를 안전하게 부르는 법 (서버 프록시)

Dandi 프로젝트 API 키(`dd_sk_...`)는 비밀번호와 같습니다. 미니앱 화면(HTML·JavaScript)에 넣으면 페이지를 여는 누구나 키를 보고 선생님 프로젝트의 예산으로 AI를 부를 수 있습니다.

그래서 게이트웨이는 브라우저에서 `dd_sk_` 키로 온 요청(`Origin`, `Sec-Fetch-Site` 등 브라우저 신호가 있는 요청)을 **401 `browser_key_forbidden`** 으로 거부합니다. 키는 미니앱의 **서버 함수(프록시)** 에서만 환경변수로 읽어 씁니다.

```text
[학생 브라우저] --(프롬프트만)--> [미니앱 서버 함수 /api/ai] --(x-api-key: 환경변수의 키)--> [Dandi 게이트웨이 /api/ai/chat]
```

## 1. 키 만들기

1. 허브의 **스튜디오 → 프로젝트·API 키**(`/studio/projects`)에서 미니앱용 프로젝트를 만듭니다. 월 예산은 필수입니다.
2. 프로젝트의 **키** 탭에서 역할 `inference`, 만료(예: 학기 말)를 골라 새 키를 만듭니다.
3. 원문은 이때 **한 번만** 보입니다. 바로 복사해 아래 환경변수에 넣습니다. 채팅·메신저·공개 저장소에 붙여 넣지 마십시오.

## 2. 환경변수

로컬 개발: 미니앱 폴더의 `.env.local` (이 파일은 `.gitignore`에 넣어 커밋하지 않습니다)

```bash
DANDI_PROJECT_KEY=dd_sk_발급받은_키
DANDI_HUB_URL=https://허브-주소
```

Vercel 배포: 프로젝트 **Settings → Environment Variables** 에 같은 두 값을 넣거나 터미널에서 넣습니다.

```bash
npx vercel env add DANDI_PROJECT_KEY
npx vercel env add DANDI_HUB_URL
```

> `NEXT_PUBLIC_`, `VITE_` 같은 접두어를 붙이지 마십시오. 이런 접두어가 붙은 변수는 빌드할 때 브라우저 코드에 그대로 들어갑니다.

## 3-A. Next.js (App Router) 서버 함수

`app/api/ai/route.ts`

```ts
// 미니앱의 서버 함수. 키는 서버 환경변수에서만 읽습니다.
const MODEL = "claude"; // 프로젝트에서 허용한 모델 id (허브 /ai 화면의 모델 가이드 참고)

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const prompt = typeof body?.prompt === "string" ? body.prompt : "";
  if (prompt.length === 0 || prompt.length > 2000) {
    return Response.json({ error: "prompt는 1~2000자 문자열이어야 합니다." }, { status: 400 });
  }

  // 브라우저에서 온 헤더(Origin, 쿠키 등)를 그대로 넘기지 말고 새로 만듭니다.
  const res = await fetch(`${process.env.DANDI_HUB_URL}/api/ai/chat`, {
    method: "POST",
    headers: {
      "x-api-key": process.env.DANDI_PROJECT_KEY ?? "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, prompt }),
  });
  const data = await res.json();

  if (!res.ok) {
    // 키·예산 오류의 자세한 내용은 서버 로그에만 남기고, 화면에는 짧게 알립니다. 키는 로그에 남기지 않습니다.
    console.error("Dandi 게이트웨이 오류", res.status, data.error?.code);
    return Response.json({ error: data.error?.message ?? "AI 호출에 실패했습니다." }, { status: res.status });
  }
  return Response.json({ output: data.output });
}
```

## 3-B. 정적 사이트 + Vercel 함수 (Next.js가 아닐 때)

폴더 구조

```text
my-app/
  index.html
  api/
    ai.js      ← Vercel이 서버 함수로 실행합니다
```

`api/ai.js`

```js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 받습니다." });
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
  if (prompt.length === 0 || prompt.length > 2000) {
    return res.status(400).json({ error: "prompt는 1~2000자 문자열이어야 합니다." });
  }
  const r = await fetch(`${process.env.DANDI_HUB_URL}/api/ai/chat`, {
    method: "POST",
    headers: { "x-api-key": process.env.DANDI_PROJECT_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude", prompt }),
  });
  const data = await r.json();
  if (!r.ok) return res.status(r.status).json({ error: data.error?.message ?? "AI 호출에 실패했습니다." });
  return res.status(200).json({ output: data.output });
}
```

## 3-C. Express (학교 서버 등)

```js
import express from "express";

const app = express();
app.use(express.json({ limit: "20kb" }));

app.post("/api/ai", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
  if (prompt.length === 0 || prompt.length > 2000) return res.status(400).json({ error: "prompt는 1~2000자여야 합니다." });
  const r = await fetch(`${process.env.DANDI_HUB_URL}/api/ai/chat`, {
    method: "POST",
    headers: { "x-api-key": process.env.DANDI_PROJECT_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude", prompt }),
  });
  const data = await r.json();
  res.status(r.status).json(r.ok ? { output: data.output } : { error: data.error?.message ?? "AI 호출에 실패했습니다." });
});

app.listen(3001);
```

## 4. 브라우저(미니앱 화면) 코드

화면 코드는 키 없이 **내 서버 함수만** 부릅니다.

```js
const res = await fetch("/api/ai", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "오늘 배운 광합성을 초등학생 눈높이로 세 줄 요약" }),
});
const { output, error } = await res.json();
```

## 5. 게이트웨이 응답과 오류

성공(200): `{ model, output, projectId, usage: { tokens, remaining, quota, teacherRemaining, teacherCap }, warnings, piiMasked, mock }`
응답 헤더 `x-dandi-project-id`로 키가 속한 프로젝트를 알려 줍니다.

| 상태 | code | 뜻 |
|---|---|---|
| 401 | `missing_key`, `invalid_key`, `key_disabled`, `key_expired` | 키가 없거나 삭제·비활성화·만료됨 |
| 401 | `browser_key_forbidden` | 브라우저에서 `dd_sk_` 키로 직접 호출함 → 서버 프록시로 바꾸십시오 |
| 403 | `project_archived`, `insufficient_role` | 보관한 프로젝트, 또는 readonly 키 |
| 403 | `model_not_allowed` | 교육청 정책 검토 중이거나 프로젝트에서 허용하지 않은 모델 |
| 400 | `invalid_request`, `model_not_found` | 요청 형식 오류, 없는 모델 |
| 429 | `project_quota_exceeded` | 프로젝트 월 예산 초과 |
| 429 | `teacher_quota_exceeded` | 교사 전체 월 상한 초과(모든 프로젝트 합계) |

프롬프트에 섞인 전화번호·이메일 등 개인정보는 게이트웨이가 모델로 보내기 전에 `***`로 가립니다. 그래도 학생 개인정보는 처음부터 보내지 마십시오.

## 6. 점검 목록

- [ ] `dd_sk_` 키가 HTML·JavaScript·공개 저장소 어디에도 없다 (`git grep dd_sk_` 로 확인)
- [ ] 환경변수 이름에 `NEXT_PUBLIC_`·`VITE_` 접두어가 없다
- [ ] `.env.local`이 `.gitignore`에 들어 있다
- [ ] 서버 함수가 prompt 길이를 제한한다
- [ ] 미니앱마다 키를 따로 만들고, 쓰지 않는 키는 비활성화했다
- [ ] 키가 새어 나갔다면 허브 프로젝트의 키 탭에서 **즉시 비활성화**하고 새 키로 바꾼다

## 참고: 허브 정적 호스팅에 올린 사이트

허브의 정적 호스팅(`dandi deploy`)에는 서버 함수가 없습니다. AI 호출이 필요한 미니앱은 서버 함수를 지원하는 곳(Vercel 등)에 배포하고, 허브에는 그 주소를 미니앱으로 등록하십시오. 정적 사이트용 공개 키(`dd_pk_`)와 단기 토큰은 이후 단계(F-36)에서 제공할 예정입니다.
