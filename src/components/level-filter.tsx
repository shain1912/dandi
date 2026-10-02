import Link from "next/link";
import { SCHOOL_LEVELS } from "@/lib/constants";

// 학교급 필터 링크(F-07, 교사단 논의 P8). 서버 컴포넌트에서 ?level= 쿼리로 동작한다.
export function LevelFilter({
  basePath,
  current,
  extraQuery = {},
}: {
  basePath: string;
  current?: string;
  extraQuery?: Record<string, string | undefined>;
}) {
  const href = (level?: string) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(extraQuery)) if (v) q.set(k, v);
    if (level) q.set("level", level);
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  return (
    <nav className="filter" aria-label="학교급 필터">
      <Link href={href()} aria-current={!current ? "page" : undefined}>
        전체
      </Link>
      {SCHOOL_LEVELS.map((l) => (
        <Link key={l.id} href={href(l.id)} aria-current={current === l.id ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
