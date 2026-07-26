/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createTurnsMiddleware } from "./src/server/turnsMiddleware";

// v0.2: serves the Node-side turns daemon's decoded-telemetry snapshot to
// the browser at /turns-state.json. Dev-server-only, same rationale as the
// /relay-proxy workaround below — see src/server/turnsMiddleware.ts for why
// this genuinely needs Node (owner key material, a live WS connection) and
// src/turns/buildBoard.ts for what the browser does with the result. All
// the actual logic is unit-tested there; this plugin is thin glue.
function turnsStatePlugin(): Plugin {
  const middleware = createTurnsMiddleware();
  return {
    name: "buzz-fleet-turns-state",
    configureServer(server) {
      server.middlewares.use(middleware.path, (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        try {
          res.end(middleware.handle());
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
      server.httpServer?.on("close", () => middleware.dispose());
    },
  };
}

// https://vite.dev/config/ | https://vitest.dev/config/
export default defineConfig({
  plugins: [react(), turnsStatePlugin()],
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
