import type { TurnsSnapshot } from "../server/turnsDaemon";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function looksLikeTurnsSnapshot(value: unknown): value is TurnsSnapshot {
  return isRecord(value) && Array.isArray(value.relays);
}

/**
 * Fetch the v0.2 turns daemon's decoded-events snapshot from the Vite
 * dev-server middleware (`/turns-state.json` — see
 * `src/server/turnsMiddleware.ts`). Mirrors `presence/bridge.ts`'s
 * `fetchPresence` shape: a pure async function taking an injectable
 * `fetchImpl`, so the polling hook stays free of any HTTP mocking.
 */
export async function fetchTurnState(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnsSnapshot> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`turns state: failed to fetch ${url}: HTTP ${response.status}`);
  }
  const json: unknown = await response.json();
  if (!looksLikeTurnsSnapshot(json)) {
    throw new Error(`turns state: malformed response from ${url}`);
  }
  return json;
}
