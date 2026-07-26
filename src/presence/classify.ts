import type { RosterAgent } from "../config/types";
import type {
  AgentPresence,
  BridgePresenceEvent,
  ClassifyAgentInput,
} from "./types";

const ALIVE_STATUSES = new Set(["online", "away"]);

/**
 * Classify one agent's liveness from its (possibly absent) event on the
 * latest poll.
 *
 * Absence is decisive: the bridge's Redis `MGET` already dropped any key
 * that was never published or whose 90s TTL lapsed, so an absent agent is
 * immediately `dead` — there is no elapsed-time threshold to re-derive
 * client-side. See README > "How liveness works".
 */
export function classifyAgent({
  agent,
  event,
  previous,
  now,
}: ClassifyAgentInput): AgentPresence {
  if (!event) {
    return {
      pubkey: agent.pubkey,
      label: agent.label,
      liveness: "dead",
      rawStatus: null,
      lastSeenAt: previous?.lastSeenAt ?? null,
    };
  }

  const liveness = ALIVE_STATUSES.has(event.content) ? "alive" : "dead";

  return {
    pubkey: agent.pubkey,
    label: agent.label,
    liveness,
    rawStatus: event.content,
    lastSeenAt: liveness === "alive" ? now : (previous?.lastSeenAt ?? null),
  };
}

export interface ClassifyRosterInput {
  roster: RosterAgent[];
  eventsByPubkey: Map<string, BridgePresenceEvent>;
  previousByPubkey: Map<string, AgentPresence>;
  now: number;
}

/** Classify an entire roster, preserving roster order. */
export function classifyRoster({
  roster,
  eventsByPubkey,
  previousByPubkey,
  now,
}: ClassifyRosterInput): AgentPresence[] {
  return roster.map((agent) =>
    classifyAgent({
      agent,
      event: eventsByPubkey.get(agent.pubkey),
      previous: previousByPubkey.get(agent.pubkey),
      now,
    }),
  );
}
