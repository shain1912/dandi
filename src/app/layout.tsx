import type { Metadata } from "next";
import Link from "next/link";
import { levelLabel } from "@/lib/constants";
import { getCurrentUser } from "@/lib/session";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dandi 프로토타입",
  description: "교사 중심 바이브코딩 & 미니앱 허브 (v0.2 프로토타입)",
};

const NAV = [
  { href: "/", label: "허브" },
  { href: "/apps", label: "미니앱" },
  { href: "/community", label: "커뮤니티" },
  { href: "/files", label: "자료실" },
  { href: "/templates", label: "템플릿" },
  { href: "/skills", label: "스킬" },
  { href: "/books", label: "서가" },
  { href: "/docs", label: "문서" },
  { href: "/connect", label: "AI로 연결" },
  { href: "/ai", label: "AI" },
  { href: "/studio", label: "스튜디오" },
  { href: "/admin", label: "관리자" },
];

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  const who =
    user.role === "anon"
      ? "익명 방문자"
      : `${user.name}${user.schoolLevel ? ` (${levelLabel(user.schoolLevel)})` : ""} · ${
          user.role === "admin" ? "관리자" : "교사"
        }`;
  return (
    <html lang="ko">
      <body>
        <header className="site-header">
          <nav className="site-nav">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="session">
            <span>{who}</span> <Link href="/login">{user.role === "anon" ? "교사 로그인" : "계정"}</Link>
          </div>
        </header>
        <main>{children}</main>
        <footer className="site-footer">Dandi v0.2 프로토타입 · 로컬 저장소 · 데모 로그인 · 모의 AI 응답 · AI 에이전트는 /llms.txt를 읽으십시오</footer>
      </body>
    </html>
  );
}
