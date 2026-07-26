import { useEffect, useRef, useState } from "react";
import { loadConfig } from "../config/loadConfig";
import type { AgentPresence } from "../presence/types";
import { pollFleet } from "./pollFleet";

export interface FleetPresenceState {
  agents: AgentPresence[];
  now: number;
  loading: boolean;
  error: string | null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Load `configUrl` (default `/fleet.yaml`), then poll every relay it
 * declares on `pollIntervalMs`, exposing the latest classified roster.
 *
 * A poll failure sets `error` but leaves the last-known `agents` in place —
 * a transient relay blip shouldn't blank the board. A config load failure
 * is fatal to this hook instance (nothing to poll) and leaves `agents` empty.
 */
export function useFleetPresence(configUrl = "/fleet.yaml"): FleetPresenceState {
  const [state, setState] = useState<FleetPresenceState>({
    agents: [],
    now: Date.now(),
    loading: true,
    error: null,
  });
  const previousByPubkeyRef = useRef(new Map<string, AgentPresence>());

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;

    async function poll(config: Awaited<ReturnType<typeof loadConfig>>) {
      const now = Date.now();
      try {
        const agents = await pollFleet(config, previousByPubkeyRef.current, now);
        if (cancelled) {
          return;
        }
        for (const agent of agents) {
          previousByPubkeyRef.current.set(agent.pubkey, agent);
        }
        setState({ agents, now, loading: false, error: null });
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({ ...prev, loading: false, error: messageOf(err) }));
        }
      }
    }

    loadConfig(configUrl)
      .then(async (config) => {
        if (cancelled) {
          return;
        }
        await poll(config);
        if (!cancelled) {
          intervalId = setInterval(() => void poll(config), config.pollIntervalMs);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState((prev) => ({ ...prev, loading: false, error: messageOf(err) }));
        }
      });

    return () => {
      cancelled = true;
      if (intervalId !== undefined) {
        clearInterval(intervalId);
      }
    };
  }, [configUrl]);

  return state;
}
