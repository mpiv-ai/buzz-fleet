import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAgentBoard } from "../../src/ui/useAgentBoard";
import type { FleetPresenceState } from "../../src/ui/useFleetPresence";
import type { TurnStateState } from "../../src/ui/useTurnState";

const useFleetPresenceMock = vi.fn<() => FleetPresenceState>();
const useTurnStateMock = vi.fn<() => TurnStateState>();

vi.mock("../../src/ui/useFleetPresence", () => ({
  useFleetPresence: () => useFleetPresenceMock(),
}));
vi.mock("../../src/ui/useTurnState", () => ({
  useTurnState: () => useTurnStateMock(),
}));

const PK = "f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1";

describe("useAgentBoard", () => {
  it("builds presence-only rows when no turn snapshot has loaded yet", () => {
    useFleetPresenceMock.mockReturnValue({
      agents: [{ pubkey: PK, label: "gatekeeper", liveness: "alive", rawStatus: "online", lastSeenAt: 1_000 }],
      now: 1_000,
      loading: false,
      error: null,
    });
    useTurnStateMock.mockReturnValue({ snapshot: null, loading: true, error: null });

    const { result } = renderHook(() => useAgentBoard());

    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0]).toMatchObject({ pubkey: PK, state: "alive", slots: [] });
    expect(result.current.loading).toBe(false);
  });

  it("merges turn-state slots into the row for the matching agent pubkey", () => {
    useFleetPresenceMock.mockReturnValue({
      agents: [{ pubkey: PK, label: "gatekeeper", liveness: "alive", rawStatus: "online", lastSeenAt: 1_000 }],
      now: 1_000,
      loading: false,
      error: null,
    });
    useTurnStateMock.mockReturnValue({
      snapshot: {
        relays: [
          {
            configuredUrl: "http://localhost:3000",
            wsUrl: "ws://localhost:3000",
            status: "connected",
            lastNotice: null,
            ownerPubkey: "o".repeat(64),
            agents: [
              {
                pubkey: PK,
                label: "gatekeeper",
                events: [
                  {
                    seq: 0,
                    timestamp: new Date(1_000).toISOString(),
                    kind: "turn_started",
                    agentIndex: 0,
                    channelId: null,
                    sessionId: null,
                    turnId: "t1",
                    payload: { source: "channel" },
                  },
                ],
              },
            ],
            channelMessages: [],
          },
        ],
        cost: {
          perAgent: [],
          fleetTotal: { agentCount: 0, turnCount: 0, totalTokens: 0, totalCostUsd: 0 },
          trend: [],
        },
      },
      loading: false,
      error: null,
    });

    const { result } = renderHook(() => useAgentBoard());

    expect(result.current.rows[0]?.slots).toHaveLength(1);
    expect(result.current.rows[0]?.slots[0]?.openTurn?.turnId).toBe("t1");
  });

  it("prefers the presence error, falling back to the turn-state error", () => {
    useFleetPresenceMock.mockReturnValue({ agents: [], now: 0, loading: false, error: "presence broke" });
    useTurnStateMock.mockReturnValue({ snapshot: null, loading: false, error: "daemon broke" });

    const { result } = renderHook(() => useAgentBoard());
    expect(result.current.error).toBe("presence broke");

    useFleetPresenceMock.mockReturnValue({ agents: [], now: 0, loading: false, error: null });
    const { result: result2 } = renderHook(() => useAgentBoard());
    expect(result2.current.error).toBe("daemon broke");
  });

  it("carries lastTransitionAt forward across re-renders when state doesn't change", () => {
    useFleetPresenceMock.mockReturnValue({
      agents: [{ pubkey: PK, label: "gatekeeper", liveness: "alive", rawStatus: "online", lastSeenAt: 1_000 }],
      now: 1_000,
      loading: false,
      error: null,
    });
    useTurnStateMock.mockReturnValue({ snapshot: null, loading: false, error: null });

    const { result, rerender } = renderHook(() => useAgentBoard());
    const firstTransitionAt = result.current.rows[0]?.lastTransitionAt;
    expect(firstTransitionAt).toBe(1_000);

    useFleetPresenceMock.mockReturnValue({
      agents: [{ pubkey: PK, label: "gatekeeper", liveness: "alive", rawStatus: "online", lastSeenAt: 21_000 }],
      now: 21_000,
      loading: false,
      error: null,
    });
    rerender();

    expect(result.current.rows[0]?.state).toBe("alive");
    expect(result.current.rows[0]?.lastTransitionAt).toBe(1_000);
  });
});
