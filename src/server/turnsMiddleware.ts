import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfig } from "../config/loadConfig";
import type { FleetConfig } from "../config/types";
import { createTurnsDaemon, type TurnsDaemon } from "./turnsDaemon";

/**
 * Dev-server-only bridge from the Node-side turns daemon to the browser —
 * same pattern as `vite.config.ts`'s existing `/relay-proxy` (see README >
 * "Browser CORS"): this repo's build target is `npm run dev`, so a
 * dev-server middleware is the natural place for the one piece of v0.2 that
 * genuinely needs Node (reading owner key material, holding a live WS
 * connection) to hand its output to the browser.
 *
 * All the actual logic lives here, unit-tested; `vite.config.ts` itself
 * stays thin glue wiring this into `server.middlewares`, mirroring how the
 * existing proxy config has no dedicated test of its own either.
 */

const DEFAULT_FLEET_YAML_PATH = resolve(process.cwd(), "public/fleet.yaml");

export interface TurnsMiddlewareDeps {
  readFleetYaml?: () => string;
  createDaemon?: (config: FleetConfig) => TurnsDaemon;
}

export interface TurnsMiddleware {
  /** The route the browser polls. */
  readonly path: string;
  /** Lazily starts the daemon on first call, then returns the current
   * snapshot as a JSON string on every call (including the first). */
  handle(): string;
  /** Stops the daemon (if started) and forgets it — a later `handle()` call
   * would start a fresh one. */
  dispose(): void;
}

export function createTurnsMiddleware(deps: TurnsMiddlewareDeps = {}): TurnsMiddleware {
  const readFleetYaml = deps.readFleetYaml ?? (() => readFileSync(DEFAULT_FLEET_YAML_PATH, "utf8"));
  const createDaemon = deps.createDaemon ?? ((config: FleetConfig) => createTurnsDaemon(config));

  let daemon: TurnsDaemon | null = null;

  function ensureStarted(): TurnsDaemon {
    if (!daemon) {
      const config = parseConfig(readFleetYaml());
      daemon = createDaemon(config);
      daemon.start();
    }
    return daemon;
  }

  return {
    path: "/turns-state.json",
    handle(): string {
      return JSON.stringify(ensureStarted().getSnapshot());
    },
    dispose(): void {
      daemon?.stop();
      daemon = null;
    },
  };
}
