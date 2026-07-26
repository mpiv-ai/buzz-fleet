/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/ | https://vitest.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev convenience for relays that don't emit browser CORS headers on
      // /query (observed against the local demo rig's relay build — see
      // README > "Browser CORS"). Point a relay's fleet.yaml `url` at
      // "/relay-proxy" to reach it through this same-origin proxy instead
      // of its real origin. Not needed for a relay that sets CORS itself.
      "/relay-proxy": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/relay-proxy/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    css: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "json-summary", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/vite-env.d.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
