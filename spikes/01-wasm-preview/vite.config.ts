import { defineConfig } from "vite";

// THROWAWAY spike config (Issue #3). Not part of the pnpm workspace.
export default defineConfig({
  worker: {
    format: "es",
  },
  server: {
    // Cross-origin isolation is not required by this openscad-wasm build
    // (single-threaded, no SharedArrayBuffer) but is harmless to allow here.
    fs: {
      allow: ["."],
    },
  },
  build: {
    target: "es2022",
  },
});
