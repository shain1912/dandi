"use server";

import { incrementRuns } from "@/lib/apps";

// F-05 실행 수 집계. 서버 렌더링 중에는 쓰지 않고, 실행 화면이 브라우저에 뜬 뒤 한 번만 호출된다.
export async function recordAppRun(appId: string): Promise<void> {
  if (typeof appId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(appId)) return;
  await incrementRuns(appId); // 없는 id는 incrementRuns가 무시한다.
}
