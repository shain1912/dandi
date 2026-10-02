import { authenticateCli } from "@/lib/cli";

// F-17: dandi login / whoami가 토큰을 확인할 때 호출한다.
export async function GET(req: Request) {
  const auth = await authenticateCli(req);
  if (!auth.ok) return auth.response;
  const { name, role, schoolLevel } = auth.user;
  return Response.json({ name, role, schoolLevel });
}
