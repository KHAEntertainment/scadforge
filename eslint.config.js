// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "spikes/**",
      "**/*.tsbuildinfo"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }]
    }
  },
  {
    // Node-context files: root/package tooling configs, CLI scripts, the
    // scad-core/libs runtimes (child processes, fs, path) and the eval
    // harnesses under evals/, which drive a real server from a Node process.
    files: [
      "*.config.{js,ts,mjs,cjs}",
      "**/vite.config.ts",
      "scripts/**/*.mjs",
      "evals/**/*.mjs",
      "apps/server/**/*.{ts,mjs}"
    ],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  }
);
