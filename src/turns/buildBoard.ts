import type { RosterAgent } from "../config/types";
import type { AgentPresence } from "../presence/types";
import { classifySlot, rollupAgentState } from "./classify";
import type {
  ClassifyThresholds,
  ObserverEvent,
  SixState,
  SlotLivenessResult,
} from "./types";

/** One slot's classification, ready for display. */
export interface SlotBoardRow extends SlotLivenessResult {
  agentIndex: number;
}

/** One roster agent's row, ready for display — the rollup state plus
 * per-slot detail wherever lifecycle events actually expose slots (empty
 * `slots` for a relay with no owner key configured, i.e. still v0.1-only). */
export interface AgentBoardRow {
  pubkey: string;
  label: string | undefined;
  state: SixState;
  lastTransitionAt: number;
  /** Carried through from presence for continuity with the v0.1 "last seen" column. */
  presenceLastSeenAt: number | null;
  slots: SlotBoardRow[];
}

export interface BuildAgentBoardInput {
  roster: RosterAgent[];
  presenceByPubkey: Map<string, AgentPresence>;
  /** This agent's raw decoded telemetry across all its slots (daemon snapshot). */
  turnEventsByPubkey: Map<string, ObserverEvent[]>;
  now: number;
  /** Prior board rows, for lastTransitionAt hysteresis at both the
   * aggregate and per-slot level. Keyed by pubkey. */
  previousRows?: Map<string, AgentBoardRow>;
  thresholds?: Partial<ClassifyThresholds>;
}

function groupByAgentIndex(events: ObserverEvent[]): Map<number, ObserverEvent[]> {
  const grouped = new Map<number, ObserverEvent[]>();
  for (const event of events) {
    if (event.agentIndex === null) {
      continue; // not yet attributable to a specific slot — see module doc
    }
    const bucket = grouped.get(event.agentIndex);
    if (bucket) {
      bucket.push(event);
    } else {
      grouped.set(event.agentIndex, [event]);
    }
  }
  return grouped;
}

const FALLBACK_PRESENCE: AgentPresence = {
  pubkey: "",
  liveness: "dead",
  rawStatus: null,
  lastSeenAt: null,
};

/**
 * Combine a roster, the v0.1 presence poll, and the v0.2 daemon's decoded
 * telemetry snapshot into display-ready board rows. Pure — no timers, no
 * React, no transport — the browser-side `useTurnState`/`App` wiring is the
 * only caller with actual side effects.
 */
export function buildAgentBoard(input: BuildAgentBoardInput): AgentBoardRow[] {
  return input.roster.map((agent) => {
    const presence = input.presenceByPubkey.get(agent.pubkey) ?? FALLBACK_PRESENCE;
    const events = input.turnEventsByPubkey.get(agent.pubkey) ?? [];
    const previousRow = input.previousRows?.get(agent.pubkey);
    const eventsByAgentIndex = groupByAgentIndex(events);

    const slots: SlotBoardRow[] = Array.from(eventsByAgentIndex.entries())
      .sort(([a], [b]) => a - b)
      .map(([agentIndex, slotEvents]) => {
        const previousSlot = previousRow?.slots.find((s) => s.agentIndex === agentIndex);
        const result = classifySlot({
          now: input.now,
          presence: { liveness: presence.liveness },
          events: slotEvents,
          previous: previousSlot,
          thresholds: input.thresholds,
        });
        return { agentIndex, ...result };
      });

    const state = rollupAgentState(slots, { liveness: presence.liveness });
    const lastTransitionAt =
      previousRow && previousRow.state === state ? previousRow.lastTransitionAt : input.now;

    return {
      pubkey: agent.pubkey,
      label: agent.label,
      state,
      lastTransitionAt,
      presenceLastSeenAt: presence.lastSeenAt,
      slots,
    };
  });
}
