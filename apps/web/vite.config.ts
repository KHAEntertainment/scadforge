/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Issue #36: the app calls `createApiClient()` with no baseUrl and relies on
// same-origin `/api/*` requests being forwarded to `apps/server` by this dev
// proxy. Without it, `/api/*` hits Vite itself, which serves `index.html`
// with a 200 — see `apiClient.ts` for the client-side half of the fix.
//
// Target is configurable via `SCADFORGE_API_URL` (falls back to the legacy
// `VITE_API_PROXY_TARGET` name) so a demo can point the web app at a
// non-default server port/host without editing this file.
const apiProxyTarget =
  process.env.SCADFORGE_API_URL ?? process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true
      }
    }
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"]
  }
});
