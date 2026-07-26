import type { RosterAgent } from "../config/types";

/**
 * A relay-signed presence event as synthesized by the bridge's
 * `synthesize_presence` (buzz-relay `crates/buzz-relay/src/api/bridge.rs`).
 *
 * `pubkey` here is the RELAY's signing key, not the agent's — the subject
 * pubkey lives in the first `["p", <hex>]` tag. `created_at` is stamped at
 * synthesis (request) time on every read, not the original publish time —
 * see README > "How liveness works".
 */
export interface BridgePresenceEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  sig: string;
  tags: string[][];
}

export type LivenessStatus = "alive" | "dead";

export interface AgentPresence {
  pubkey: string;
  label?: string;
  liveness: LivenessStatus;
  /**
   * Exact `content` string from the relay when an event was present on the
   * most recent poll, else `null`. Kept even when it doesn't map to a known
   * status so the UI can surface it verbatim for debugging.
   */
  rawStatus: string | null;
  /** Client-observed wall-clock ms epoch this agent was last confirmed alive, or `null` if never seen. */
  lastSeenAt: number | null;
}

export interface ClassifyAgentInput {
  agent: RosterAgent;
  /** This agent's event from the latest successful poll, if the bridge returned one. */
  event: BridgePresenceEvent | undefined;
  /** This agent's previously computed state, if any (`undefined` on the first poll). */
  previous: AgentPresence | undefined;
  /** Wall-clock ms epoch of the poll, injected for testability. */
  now: number;
}
