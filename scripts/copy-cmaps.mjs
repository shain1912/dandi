// PDF 리더(F-44)용 pdf.js 정적 파일을 public/으로 복사한다. predev·prebuild에서 실행한다.
//   node_modules/pdfjs-dist/cmaps           → public/cmaps/                     (한글 등 CID 글꼴 CMap, cMapUrl "/cmaps/")
//   node_modules/pdfjs-dist/standard_fonts  → public/pdfjs/standard_fonts/      (내장되지 않은 표준 14 글꼴)
//   node_modules/pdfjs-dist/build/pdf.worker.min.mjs → public/pdfjs/pdf.worker.min.mjs (pdf.js 워커)
// 워커는 번들러 설정과 무관하게 동작하도록 정적 파일로 둔다. react-pdf가 쓰는 pdfjs-dist와 같은 판을 복사해야
// 하므로 react-pdf 위치에서 pdfjs-dist를 찾는다(버전이 다르면 "API version does not match Worker version" 오류).

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));

function resolvePdfjsDir() {
  const reactPdfPkg = require.resolve("react-pdf/package.json");
  const fromReactPdf = createRequire(reactPdfPkg);
  return path.dirname(fromReactPdf.resolve("pdfjs-dist/package.json"));
}

const pdfjsDir = resolvePdfjsDir();
const version = JSON.parse(readFileSync(path.join(pdfjsDir, "package.json"), "utf8")).version;

const copies = [
  { from: path.join(pdfjsDir, "cmaps"), to: path.join(root, "public", "cmaps") },
  { from: path.join(pdfjsDir, "standard_fonts"), to: path.join(root, "public", "pdfjs", "standard_fonts") },
  { from: path.join(pdfjsDir, "build", "pdf.worker.min.mjs"), to: path.join(root, "public", "pdfjs", "pdf.worker.min.mjs") },
];

for (const { from, to } of copies) {
  if (!existsSync(from)) {
    console.error(`pdfjs-dist ${version}에서 ${path.relative(root, from)}을(를) 찾지 못했습니다.`);
    process.exit(1);
  }
  rmSync(to, { recursive: true, force: true }); // 이전 판의 파일이 남지 않게 지우고 복사한다
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

console.log(`pdf.js ${version}: public/cmaps, public/pdfjs/standard_fonts, public/pdfjs/pdf.worker.min.mjs 복사 완료`);
