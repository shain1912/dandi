import Link from "next/link";
import { AppCard } from "@/components/app-card";
import { LevelFilter } from "@/components/level-filter";
import { listApps } from "@/lib/apps";
import { APP_CATEGORIES, isAppCategory, isSchoolLevel } from "@/lib/constants";

// 미니앱 목록(F-05, F-06). 로그인 없이 학교급·분류로 걸러 보고 바로 실행한다.

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function categoryHref(level: string | undefined, category: string | undefined): string {
  const q = new URLSearchParams();
  if (level) q.set("level", level);
  if (category) q.set("category", category);
  const s = q.toString();
  return s ? `/apps?${s}` : "/apps";
}

export default async function AppsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const rawLevel = first(sp.level);
  const rawCategory = first(sp.category);
  const level = isSchoolLevel(rawLevel) ? rawLevel : undefined;
  const category = isAppCategory(rawCategory) ? rawCategory : undefined;

  const apps = await listApps({ level, category });

  return (
    <>
      <h1>미니앱</h1>
      <p className="muted">
        로그인 없이 바로 실행할 수 있습니다. 카드마다 배포 전 셀프점검 답변(학생 개인정보 처리, 외부 전송, 학교 내부 승인)을 배지로 표시합니다. 학교 내부 승인이 필요한 앱은 승인 완료 뒤에 목록에 나타납니다.{" "}
        <Link href="/studio/apps/new">미니앱 등록(교사)</Link>
      </p>

      <LevelFilter basePath="/apps" current={level} extraQuery={{ category }} />
      <nav className="filter" aria-label="분류 필터">
        <Link href={categoryHref(level, undefined)} aria-current={!category ? "page" : undefined}>
          전체 분류
        </Link>
        {APP_CATEGORIES.map((c) => (
          <Link
            key={c.id}
            href={categoryHref(level, c.id)}
            aria-current={category === c.id ? "page" : undefined}
          >
            {c.label}
          </Link>
        ))}
      </nav>

      {apps.length === 0 ? (
        <p className="muted">조건에 맞는 미니앱이 없습니다.</p>
      ) : (
        <ul className="list">
          {apps.map((app) => (
            <AppCard key={app.id} app={app} />
          ))}
        </ul>
      )}
    </>
  );
}
