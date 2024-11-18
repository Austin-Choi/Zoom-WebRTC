import globals from "globals";
import pluginJs from "@eslint/js";
import prettierPlugin from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";

export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: globals.node, // Node.js 환경을 설정
    },
    rules: {
      "no-console": "off", // 콘솔 사용 허용
      "prettier/prettier": "error", // Prettier 규칙을 ESLint에 통합
    },
  },
  pluginJs.configs.recommended,
  prettierConfig, // Prettier 규칙 적용
  {
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      "prettier/prettier": "error",
    },
  },
];
