import { describe, expect, it } from "vitest";
import { buildAgentBoard } from "../../src/turns/buildBoard";
import { SWALLOWED_CORROBORATION_WINDOW_MS } from "../../src/turns/swallowed";
import type { ChannelMessageRecord } from "../../src/turns/swallowed";
import type { AgentPresence } from "../../src/presence/types";
import type { ObserverEvent } from "../../src/turns/types";
import type { RosterAgent } from "../../src/config/types";

const PK_A = "a".repeat(64);
const PK_B = "b".repeat(64);
const CHANNEL_ID = "5cdc97df-99b0-4d22-86fa-3d1478d697b1";
const T0 = 1_785_000_000_000;

function presence(pubkey: string, liveness: "alive" | "dead", lastSeenAt: number | null): AgentPresence {
  return { pubkey, liveness, rawStatus: liveness === "alive" ? "online" : null, lastSeenAt };
}

function turnStarted(
  atMs: number,
  agentIndex: number,
  turnId: string,
  source = "channel",
  channelId: string | null = null,
): ObserverEvent {
  return {
    seq: 0,
    timestamp: new Date(atMs).toISOString(),
    kind: "turn_started",
    agentIndex,
    channelId,
    sessionId: "s",
    turnId,
    payload: { source },
  };
}

function turnCompleted(
  atMs: number,
  agentIndex: number,
  turnId: string,
  outcome: string,
  channelId: string | null = null,
): ObserverEvent {
  return {
    seq: 0,
    timestamp: new Date(atMs).toISOString(),
    kind: "turn_completed",
    agentIndex,
    channelId,
    sessionId: "s",
    turnId,
    payload: { outcome },
  };
}

function channelMessage(overrides: Partial<ChannelMessageRecord> = {}): ChannelMessageRecord {
  return {
    pubkey: PK_A,
    channelId: CHANNEL_ID,
    createdAt: T0 + 5_000,
    ...overrides,
  };
}

describe("buildAgentBoard", () => {
  it("falls back to presence-only (no slots) for a roster agent with zero turn events", () => {
    const roster: RosterAgent[] = [{ pubkey: PK_A, label: "gatekeeper" }];
    const rows = buildAgentBoard({
      roster,
      presenceByPubkey: new Map([[PK_A, presence(PK_A, "alive", T0)]]),
      turnEventsByPubkey: new Map(),
      now: T0,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pubkey: PK_A, label: "gatekeeper", state: "alive", slots: [] });
  });

  it("reflects presence dead with no slots as the dead state", () => {
    const roster: RosterAgent[] = [{ pubkey: PK_A }];
    const rows = buildAgentBoard({
      roster,
      presenceByPubkey: new Map([[PK_A, presence(PK_A, "dead", null)]]),
      turnEventsByPubkey: new Map(),
      now: T0,
    });

    expect(rows[0]?.state).toBe("dead");
  });

  it("groups events by agentIndex into per-slot detail", () => {
    const roster: RosterAgent[] = [{ pubkey: PK_A, label: "gatekeeper" }];
    const events: ObserverEvent[] = [
      turnStarted(T0, 0, "t0"),
      turnStarted(T0, 1, "t1", "heartbeat"),
    ];
    const rows = buildAgentBoard({
      roster,
      presenceByPubkey: new Map([[PK_A, presence(PK_A, "alive", T0)]]),
      turnEventsByPubkey: new Map([[PK_A, events]]),
      now: T0 + 1_000,
    });

    expect(rows[0]?.slots).toHaveLength(2);
    const slot0 = rows[0]?.slots.find((s) => s.agentIndex === 0);
    const slot1 = rows[0]?.slots.find((s) => s.agentIndex === 1);
    expect(slot0?.openTurn?.source).toBe("channel");
    expect(slot1?.openTurn?.source).toBe("heartbeat");
  });

  it("rolls per-slot states up into the row's aggregate state", () => {
    const roster: RosterAgent[] = [{ pubkey: PK_A }];
    // slot 0: open turn ticking well past the wedged threshold => wedged.
    const events: ObserverEvent[] = [turnStarted(T0, 0, "t0")];
    for (let t = 10_000; t <= 70_000; t += 10_000) {
      events.push({ ...turnStarted(T0 + t, 0, "t0"), kind: "turn_liveness" });
    }

    const rows = buildAgentBoard({
      roster,
      presenceByPubkey: new Map([[PK_A, presence(PK_A, "alive", T0)]]),
      turnEventsByPubkey: new Map([[PK_A, events]]),
      now: T0 + 70_000,
    });

    expect(rows[0]?.state).toBe("wedged");
  });

  it("processes every roster agent independently, in roster order", () => {
    const roster: RosterAgent[] = [{ pubkey: PK_A, label: "a" }, { pubkey: PK_B, label: "b" }];
    const rows = buildAgentBoard({
      roster,
      presenceByPubkey: new Map([
        [PK_A, presence(PK_A, "alive", T0)],
        [PK_B, presence(PK_B, "dead", null)],
      ]),
      turnEventsByPubkey: new Map(),
      now: T0,
    });

    expect(rows.map((r) => r.pubkey)).toEqual([PK_A, PK_B]);
    expect(rows[0]?.state).toBe("alive");
    expect(rows[1]?.state).toBe("dead");
  });

  it("carries lastTransitionAt forward across calls when the aggregate state is unchanged", () => {
    const roster: RosterAgent[] = [{ pubkey: PK_A }];
    const first = buildAgentBoard({
      roster,
      presenceByPubkey: new Map([[PK_A, presence(PK_A, "alive", T0)]]),
      turnEventsByPubkey: new Map(),
      now: T0,
    });

    const second = buildAgentBoard({
      roster,
      presenceByPubkey: new Map([[PK_A, presence(PK_A, "alive", T0 + 30_000)]]),
      turnEventsByPubkey: new Map(),
      now: T0 + 30_000,
      previousRows: new Map(first.map((r) => [r.pubkey, r])),
    });

    expect(second[0]?.state).toBe("alive");
    expect(second[0]?.lastTransitionAt).toBe(T0);
  });

  it("carries a slot's own lastTransitionAt forward via previousRows, independent of the aggregate", () => {
    const roster: RosterAgent[] = [{ pubkey: PK_A }];
    const events: ObserverEvent[] = [turnStarted(T0, 0, "t0")];
    for (let t = 10_000; t <= 70_000; t += 10_000) {
      events.push({ ...turnStarted(T0 + t, 0, "t0"), kind: "turn_liveness" });
    }

    const first = buildAgentBoard({
      roster,
      presenceByPubkey: new Map([[PK_A, presence(PK_A, "alive", T0)]]),
      turnEventsByPubkey: new Map([[PK_A, events]]),
      now: T0 + 70_000,
    });
    expect(first[0]?.slots[0]?.state).toBe("wedged");
    const wedgedSince = first[0]?.slots[0]?.lastTransitionAt;

    // One more poll, ten seconds later, still wedged — lastTransitionAt for
    // the slot should not move.
    events.push({ ...turnStarted(T0 + 80_000, 0, "t0"), kind: "turn_liveness" });
    const second = buildAgentBoard({
      roster,
      presenceByPubkey: new Map([[PK_A, presence(PK_A, "alive", T0 + 80_000)]]),
      turnEventsByPubkey: new Map([[PK_A, events]]),
      now: T0 + 80_000,
      previousRows: new Map(first.map((r) => [r.pubkey, r])),
    });

    expect(second[0]?.slots[0]?.state).toBe("wedged");
    expect(second[0]?.slots[0]?.lastTransitionAt).toBe(wedgedSince);
  });

  // v0.3: swallowed detection goes live — buildAgentBoard now derives
  // classifySlot's channelActivity.replySeenAfterLastChannelTurn from a real
  // channel-message feed instead of leaving it permanently unset.
  describe("swallowed detection (v0.3)", () => {
    it("flags a slot swallowed once the corroboration window elapses with no reply from the agent", () => {
      const roster: RosterAgent[] = [{ pubkey: PK_A, label: "gatekeeper" }];
      const events: ObserverEvent[] = [
        turnStarted(T0, 0, "t1", "channel", CHANNEL_ID),
        turnCompleted(T0 + 1_000, 0, "t1", "ok", CHANNEL_ID),
      ];
      const now = T0 + 1_000 + SWALLOWED_CORROBORATION_WINDOW_MS;

      const rows = buildAgentBoard({
        roster,
        presenceByPubkey: new Map([[PK_A, presence(PK_A, "alive", now)]]),
        turnEventsByPubkey: new Map([[PK_A, events]]),
        channelMessages: [],
        now,
      });

      expect(rows[0]?.state).toBe("swallowed");
      expect(rows[0]?.slots[0]?.state).toBe("swallowed");
    });

    it("does not flag swallowed when the agent's own reply appears in the channel within the window", () => {
      const roster: RosterAgent[] = [{ pubkey: PK_A, label: "gatekeeper" }];
      const events: ObserverEvent[] = [
        turnStarted(T0, 0, "t1", "channel", CHANNEL_ID),
        turnCompleted(T0 + 1_000, 0, "t1", "ok", CHANNEL_ID),
      ];
      const now = T0 + 1_000 + SWALLOWED_CORROBORATION_WINDOW_MS;

      const rows = buildAgentBoard({
        roster,
        presenceByPubkey: new Map([[PK_A, presence(PK_A, "alive", now)]]),
        turnEventsByPubkey: new Map([[PK_A, events]]),
        channelMessages: [channelMessage({ pubkey: PK_A, createdAt: T0 + 1_000 + 8_000 })],
        now,
      });

      expect(rows[0]?.state).not.toBe("swallowed");
    });

    it("does not flag swallowed while the corroboration window is still open", () => {
      const roster: RosterAgent[] = [{ pubkey: PK_A }];
      const events: ObserverEvent[] = [
        turnStarted(T0, 0, "t1", "channel", CHANNEL_ID),
        turnCompleted(T0 + 1_000, 0, "t1", "ok", CHANNEL_ID),
      ];
      const now = T0 + 1_000 + SWALLOWED_CORROBORATION_WINDOW_MS - 1;

      const rows = buildAgentBoard({
        roster,
        presenceByPubkey: new Map([[PK_A, presence(PK_A, "alive", now)]]),
        turnEventsByPubkey: new Map([[PK_A, events]]),
        channelMessages: [],
        now,
      });

      expect(rows[0]?.state).not.toBe("swallowed");
    });

    it("ignores a reply posted by someone other than the agent (e.g. the owner)", () => {
      const roster: RosterAgent[] = [{ pubkey: PK_A }];
      const events: ObserverEvent[] = [
        turnStarted(T0, 0, "t1", "channel", CHANNEL_ID),
        turnCompleted(T0 + 1_000, 0, "t1", "ok", CHANNEL_ID),
      ];
      const now = T0 + 1_000 + SWALLOWED_CORROBORATION_WINDOW_MS;

      const rows = buildAgentBoard({
        roster,
        presenceByPubkey: new Map([[PK_A, presence(PK_A, "alive", now)]]),
        turnEventsByPubkey: new Map([[PK_A, events]]),
        channelMessages: [channelMessage({ pubkey: PK_B, createdAt: T0 + 2_000 })],
        now,
      });

      expect(rows[0]?.state).toBe("swallowed");
    });

    it("stays fully backward compatible when channelMessages is omitted entirely", () => {
      const roster: RosterAgent[] = [{ pubkey: PK_A, label: "gatekeeper" }];
      const events: ObserverEvent[] = [
        turnStarted(T0, 0, "t1", "channel", CHANNEL_ID),
        turnCompleted(T0 + 1_000, 0, "t1", "ok", CHANNEL_ID),
      ];

      expect(() =>
        buildAgentBoard({
          roster,
          presenceByPubkey: new Map([[PK_A, presence(PK_A, "alive", T0 + 1_000)]]),
          turnEventsByPubkey: new Map([[PK_A, events]]),
          now: T0 + 1_000,
        }),
      ).not.toThrow();
    });
  });
});
