import { useEffect, useState } from "react";
import type { TurnsSnapshot } from "../server/turnsDaemon";
import { fetchTurnState } from "./fetchTurnState";

export interface TurnStateState {
  snapshot: TurnsSnapshot | null;
  loading: boolean;
  error: string | null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Faster than presence's default poll interval (v0.1's `pollIntervalMs`,
 * typically 20s) — a wedged/crashed-mid-turn transition is exactly the kind
 * of thing this board exists to surface promptly. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Poll the v0.2 turns daemon's snapshot endpoint on an interval, exposing
 * the latest decoded-events snapshot. Mirrors `useFleetPresence`'s shape and
 * error-handling policy: a poll failure sets `error` but leaves the
 * last-known `snapshot` in place, never blanking the board over a
 * transient hiccup.
 */
export function useTurnState(
  url = "/turns-state.json",
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
): TurnStateState {
  const [state, setState] = useState<TurnStateState>({
    snapshot: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const snapshot = await fetchTurnState(url);
        if (!cancelled) {
          setState({ snapshot, loading: false, error: null });
        }
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({ ...prev, loading: false, error: messageOf(err) }));
        }
      }
    }

    void poll();
    const intervalId = setInterval(() => void poll(), pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [url, pollIntervalMs]);

  return state;
}
