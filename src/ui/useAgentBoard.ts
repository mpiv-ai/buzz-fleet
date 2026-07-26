import { useEffect, useRef, useState } from "react";
import type { AgentPresence } from "../presence/types";
import type { CostSnapshot } from "../server/turnsDaemon";
import { buildAgentBoard, type AgentBoardRow } from "../turns/buildBoard";
import type { ChannelMessageRecord } from "../turns/swallowed";
import type { ObserverEvent } from "../turns/types";
import { useFleetPresence } from "./useFleetPresence";
import { useTurnState } from "./useTurnState";

export interface AgentBoardState {
  rows: AgentBoardRow[];
  now: number;
  loading: boolean;
  error: string | null;
  /** v0.3 fleet-wide cost summary from the same snapshot — `null` until the
   * turns daemon has been polled at least once. See `CostPanel.tsx`. */
  cost: CostSnapshot | null;
}

function turnEventsByPubkeyFrom(
  snapshot: ReturnType<typeof useTurnState>["snapshot"],
): Map<string, ObserverEvent[]> {
  const map = new Map<string, ObserverEvent[]>();
  for (const relay of snapshot?.relays ?? []) {
    for (const agent of relay.agents) {
      map.set(agent.pubkey, agent.events);
    }
  }
  return map;
}

/** Flatten every relay's recent kind-9 channel messages into one list —
 * `buildAgentBoard` (via `swallowed.ts`) filters by channel/author itself,
 * so which relay a message came from doesn't matter here. */
function channelMessagesFrom(
  snapshot: ReturnType<typeof useTurnState>["snapshot"],
): ChannelMessageRecord[] {
  const messages: ChannelMessageRecord[] = [];
  for (const relay of snapshot?.relays ?? []) {
    messages.push(...relay.channelMessages);
  }
  return messages;
}

/**
 * Composes the v0.1 presence poll with the v0.2 turns-daemon poll into
 * display-ready {@link AgentBoardRow}s. `loading` reflects presence alone —
 * turn telemetry is an enhancement layered on top (see `buildBoard.ts`'s
 * graceful presence-only fallback), never a precondition for showing the
 * board at all. `error` prefers the presence error (nothing renders at all
 * without it) and falls back to the turn-state error only when presence
 * itself is healthy.
 */
export function useAgentBoard(): AgentBoardState {
  const presence = useFleetPresence();
  const turnState = useTurnState();
  const previousRowsRef = useRef(new Map<string, AgentBoardRow>());
  const [rows, setRows] = useState<AgentBoardRow[]>([]);

  useEffect(() => {
    const roster = presence.agents.map((a) => ({ pubkey: a.pubkey, label: a.label }));
    const presenceByPubkey = new Map<string, AgentPresence>(presence.agents.map((a) => [a.pubkey, a]));
    const turnEventsByPubkey = turnEventsByPubkeyFrom(turnState.snapshot);
    const channelMessages = channelMessagesFrom(turnState.snapshot);

    const result = buildAgentBoard({
      roster,
      presenceByPubkey,
      turnEventsByPubkey,
      channelMessages,
      now: presence.now,
      previousRows: previousRowsRef.current,
    });
    previousRowsRef.current = new Map(result.map((r) => [r.pubkey, r]));
    setRows(result);
  }, [presence.agents, presence.now, turnState.snapshot]);

  return {
    rows,
    now: presence.now,
    loading: presence.loading,
    error: presence.error ?? turnState.error,
    cost: turnState.snapshot?.cost ?? null,
  };
}
