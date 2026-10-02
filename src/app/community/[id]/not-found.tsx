import Link from "next/link";

export default function PostNotFound() {
  return (
    <>
      <h1>글을 찾을 수 없습니다</h1>
      <p className="muted">삭제되었거나 주소가 잘못되었습니다.</p>
      <p>
        <Link href="/community">커뮤니티 목록으로</Link>
      </p>
    </>
  );
}
