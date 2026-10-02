import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 빌드 때 생성·복사되는 서드파티 파일(pdf.js 워커·글꼴 맵, CLI tarball)
    "public/pdfjs/**",
    "public/cmaps/**",
    "public/*.tgz",
  ]),
]);

export default eslintConfig;
