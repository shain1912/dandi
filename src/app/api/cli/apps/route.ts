import { revalidatePath } from "next/cache";
import { createApp } from "@/lib/apps";
import { authenticateCli, jsonError, parseNewAppInput } from "@/lib/cli";

// F-18: dandi publish. 웹 폼과 같은 createApp을 사용하므로
// 셀프점검 검증(F-16)과 서버 마스킹(F-14)이 똑같이 적용된다.

const MAX_BODY_CHARS = 64 * 1024;

export async function POST(req: Request) {
  const auth = await authenticateCli(req);
  if (!auth.ok) return auth.response;

  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return jsonError(413, "요청 본문이 너무 큽니다.");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError(400, "요청 본문이 올바른 JSON이 아닙니다.");
  }

  const parsed = parseNewAppInput(body);
  if (!parsed.ok) return jsonError(400, parsed.error);

  const result = await createApp(parsed.value, auth.user);
  if (!result.ok) return jsonError(400, result.error);

  revalidatePath("/");
  revalidatePath("/apps");
  revalidatePath("/studio");
  revalidatePath("/studio/apps");
  revalidatePath("/admin");
  const app = result.value;
  return Response.json(
    { id: app.id, url: `/apps/${app.id}`, title: app.title, approvalStatus: app.approvalStatus },
    { status: 201 },
  );
}
