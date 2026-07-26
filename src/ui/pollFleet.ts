import type { FleetConfig } from "../config/types";
import type { AgentPresence } from "../presence/types";
import { fetchPresence } from "../presence/bridge";
import { classifyRoster } from "../presence/classify";

/**
 * Poll every relay in `config` once, classify each relay's roster against
 * `previousByPubkey`, and return the flattened results in relay order (each
 * relay's roster order preserved within it).
 *
 * Pure aside from the injected `fetchImpl` — no timers, no React — so the
 * polling logic itself is directly unit-testable without fake clocks.
 */
export async function pollFleet(
  config: FleetConfig,
  previousByPubkey: Map<string, AgentPresence>,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentPresence[]> {
  const perRelay = await Promise.all(
    config.relays.map(async (relay) => {
      const eventsByPubkey = await fetchPresence(
        relay.url,
        relay.callerPubkey,
        relay.roster.map((agent) => agent.pubkey),
        fetchImpl,
      );
      return classifyRoster({
        roster: relay.roster,
        eventsByPubkey,
        previousByPubkey,
        now,
      });
    }),
  );
  return perRelay.flat();
}
