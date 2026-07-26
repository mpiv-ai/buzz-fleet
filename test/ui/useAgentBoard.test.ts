import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAgentBoard } from "../../src/ui/useAgentBoard";
import type { FleetPresenceState } from "../../src/ui/useFleetPresence";
import type { TurnStateState } from "../../src/ui/useTurnState";
import type { ChannelMessageRecord } from "../../src/turns/swallowed";

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

  it("exposes cost from the turn-state snapshot", () => {
    const cost = {
      perAgent: [
        {
          agentPubkey: PK,
          label: "gatekeeper",
          turnCount: 3,
          totalTokens: 900,
          totalCostUsd: 0.09,
          latestCumulative: null,
        },
      ],
      fleetTotal: { agentCount: 1, turnCount: 3, totalTokens: 900, totalCostUsd: 0.09 },
      trend: [],
    };
    useFleetPresenceMock.mockReturnValue({
      agents: [{ pubkey: PK, label: "gatekeeper", liveness: "alive", rawStatus: "online", lastSeenAt: 1_000 }],
      now: 1_000,
      loading: false,
      error: null,
    });
    useTurnStateMock.mockReturnValue({
      snapshot: { relays: [], cost },
      loading: false,
      error: null,
    });

    const { result } = renderHook(() => useAgentBoard());

    expect(result.current.cost).toEqual(cost);
  });

  it("exposes cost as null before any turn-state snapshot has loaded", () => {
    useFleetPresenceMock.mockReturnValue({
      agents: [{ pubkey: PK, label: "gatekeeper", liveness: "alive", rawStatus: "online", lastSeenAt: 1_000 }],
      now: 1_000,
      loading: false,
      error: null,
    });
    useTurnStateMock.mockReturnValue({ snapshot: null, loading: true, error: null });

    const { result } = renderHook(() => useAgentBoard());

    expect(result.current.cost).toBeNull();
  });

  describe("swallowed detection end to end (channelMessages flattened from the snapshot)", () => {
    const T0 = 1_785_000_000_000;
    const CHANNEL_ID = "chan-1";
    const events = [
      {
        seq: 0,
        timestamp: new Date(T0).toISOString(),
        kind: "turn_started",
        agentIndex: 0,
        channelId: CHANNEL_ID,
        sessionId: "s",
        turnId: "t1",
        payload: { source: "channel" },
      },
      {
        seq: 1,
        timestamp: new Date(T0 + 1_000).toISOString(),
        kind: "turn_completed",
        agentIndex: 0,
        channelId: CHANNEL_ID,
        sessionId: "s",
        turnId: "t1",
        payload: { outcome: "ok" },
      },
    ];
    // 130s after resolution — past the 120s corroboration window.
    const now = T0 + 1_000 + 130_000;
    const EMPTY_COST = {
      perAgent: [],
      fleetTotal: { agentCount: 0, turnCount: 0, totalTokens: 0, totalCostUsd: 0 },
      trend: [],
    };

    function mockSnapshot(channelMessages: ChannelMessageRecord[]) {
      useFleetPresenceMock.mockReturnValue({
        agents: [{ pubkey: PK, label: "gatekeeper", liveness: "alive", rawStatus: "online", lastSeenAt: now }],
        now,
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
              agents: [{ pubkey: PK, label: "gatekeeper", events }],
              channelMessages,
            },
          ],
          cost: EMPTY_COST,
        },
        loading: false,
        error: null,
      });
    }

    it("flags swallowed when no relay's channelMessages contain a reply from the agent", () => {
      mockSnapshot([]);

      const { result } = renderHook(() => useAgentBoard());

      expect(result.current.rows[0]?.state).toBe("swallowed");
    });

    it("does NOT flag swallowed once a reply from the agent is present in the flattened channelMessages — proves the plumbing threads real data through, not just an always-empty default", () => {
      mockSnapshot([{ pubkey: PK, channelId: CHANNEL_ID, createdAt: T0 + 1_000 + 8_000 }]);

      const { result } = renderHook(() => useAgentBoard());

      expect(result.current.rows[0]?.state).not.toBe("swallowed");
    });
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
