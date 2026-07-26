import { describe, expect, it } from "vitest";
import {
  computeReplySeenAfterLastChannelTurn,
  lastResolvedTurn,
  SWALLOWED_CORROBORATION_WINDOW_MS,
} from "../../src/turns/swallowed";
import type { ChannelMessageRecord } from "../../src/turns/swallowed";
import type { ObserverEvent } from "../../src/turns/types";

const T0 = 1_785_000_000_000;
const AGENT_PUBKEY = "a".repeat(64);
const OWNER_PUBKEY = "b".repeat(64);
const CHANNEL_ID = "5cdc97df-99b0-4d22-86fa-3d1478d697b1";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function turnStarted(opts: { atMs: number; turnId: string; source?: string; channelId?: string | null }): ObserverEvent {
  return {
    seq: 0,
    timestamp: iso(opts.atMs),
    kind: "turn_started",
    agentIndex: 0,
    channelId: opts.channelId ?? CHANNEL_ID,
    sessionId: "s1",
    turnId: opts.turnId,
    payload: opts.source === undefined ? {} : { source: opts.source },
  };
}

function turnCompleted(opts: {
  atMs: number;
  turnId: string;
  outcome: string;
  channelId?: string | null;
}): ObserverEvent {
  return {
    seq: 0,
    timestamp: iso(opts.atMs),
    kind: "turn_completed",
    agentIndex: 0,
    channelId: opts.channelId ?? CHANNEL_ID,
    sessionId: "s1",
    turnId: opts.turnId,
    payload: { outcome: opts.outcome },
  };
}

function message(overrides: Partial<ChannelMessageRecord> = {}): ChannelMessageRecord {
  return {
    pubkey: AGENT_PUBKEY,
    channelId: CHANNEL_ID,
    createdAt: T0 + 5_000,
    ...overrides,
  };
}

describe("SWALLOWED_CORROBORATION_WINDOW_MS", () => {
  it("is a positive, finite duration", () => {
    expect(SWALLOWED_CORROBORATION_WINDOW_MS).toBeGreaterThan(0);
    expect(Number.isFinite(SWALLOWED_CORROBORATION_WINDOW_MS)).toBe(true);
  });

  // Rig-observed reply latencies (fleet-captures-v02,
  // 20260726T045832Z_02_smoke_test_channel_messages.json): 26s and 8s for
  // two real, non-gated smoke-test replies. The window must comfortably
  // exceed both so a merely-slow-but-honest reply is never misclassified.
  it("comfortably exceeds the slowest reply latency observed live on the rig (26s)", () => {
    expect(SWALLOWED_CORROBORATION_WINDOW_MS).toBeGreaterThan(26_000);
  });
});

describe("lastResolvedTurn", () => {
  it("returns null for no events", () => {
    expect(lastResolvedTurn([])).toBeNull();
  });

  it("returns null when a turn is still open (never resolved)", () => {
    expect(lastResolvedTurn([turnStarted({ atMs: T0, turnId: "t1", source: "channel" })])).toBeNull();
  });

  it("captures channelId, source, outcome, and resolvedAt for a resolved channel turn", () => {
    const result = lastResolvedTurn([
      turnStarted({ atMs: T0, turnId: "t1", source: "channel" }),
      turnCompleted({ atMs: T0 + 1_000, turnId: "t1", outcome: "ok" }),
    ]);

    expect(result).toEqual({
      channelId: CHANNEL_ID,
      source: "channel",
      outcome: "ok",
      resolvedAt: T0 + 1_000,
    });
  });

  it("returns the LAST resolved turn, not the first", () => {
    const result = lastResolvedTurn([
      turnStarted({ atMs: T0, turnId: "t1", source: "channel" }),
      turnCompleted({ atMs: T0 + 1_000, turnId: "t1", outcome: "ok" }),
      turnStarted({ atMs: T0 + 2_000, turnId: "t2", source: "heartbeat" }),
      turnCompleted({ atMs: T0 + 3_000, turnId: "t2", outcome: "ok" }),
    ]);

    expect(result?.source).toBe("heartbeat");
    expect(result?.resolvedAt).toBe(T0 + 3_000);
  });

  it("reports source 'unknown' when the resolution has no matching open turn_started", () => {
    const result = lastResolvedTurn([turnCompleted({ atMs: T0, turnId: "orphan", outcome: "ok" })]);

    expect(result?.source).toBe("unknown");
  });

  it("treats turn_error as a resolution too, carrying its outcome", () => {
    const result = lastResolvedTurn([
      turnStarted({ atMs: T0, turnId: "t1", source: "channel" }),
      {
        seq: 0,
        timestamp: iso(T0 + 1_000),
        kind: "turn_error",
        agentIndex: 0,
        channelId: CHANNEL_ID,
        sessionId: "s1",
        turnId: "t1",
        payload: { outcome: "hard_timeout", error: "boom" },
      },
    ]);

    expect(result?.outcome).toBe("hard_timeout");
  });
});

describe("computeReplySeenAfterLastChannelTurn", () => {
  it("returns null when there is no resolved turn at all", () => {
    const result = computeReplySeenAfterLastChannelTurn({
      agentPubkey: AGENT_PUBKEY,
      events: [],
      channelMessages: [],
      now: T0,
    });

    expect(result).toBeNull();
  });

  it("returns null when the last resolved turn was heartbeat-sourced (nothing to reply to)", () => {
    const events = [
      turnStarted({ atMs: T0, turnId: "t1", source: "heartbeat" }),
      turnCompleted({ atMs: T0 + 1_000, turnId: "t1", outcome: "ok" }),
    ];

    const result = computeReplySeenAfterLastChannelTurn({
      agentPubkey: AGENT_PUBKEY,
      events,
      channelMessages: [],
      now: T0 + 1_000,
    });

    expect(result).toBeNull();
  });

  it("returns null when the last resolved channel turn did not complete ok", () => {
    const events = [
      turnStarted({ atMs: T0, turnId: "t1", source: "channel" }),
      turnCompleted({ atMs: T0 + 1_000, turnId: "t1", outcome: "error" }),
    ];

    const result = computeReplySeenAfterLastChannelTurn({
      agentPubkey: AGENT_PUBKEY,
      events,
      channelMessages: [],
      now: T0 + 1_000,
    });

    expect(result).toBeNull();
  });

  it("returns true when the agent posted into the same channel within the window", () => {
    const events = [
      turnStarted({ atMs: T0, turnId: "t1", source: "channel" }),
      turnCompleted({ atMs: T0 + 1_000, turnId: "t1", outcome: "ok" }),
    ];
    const channelMessages = [message({ createdAt: T0 + 1_000 + 8_000 })]; // 8s reply, like the rig

    const result = computeReplySeenAfterLastChannelTurn({
      agentPubkey: AGENT_PUBKEY,
      events,
      channelMessages,
      now: T0 + 1_000 + 9_000,
    });

    expect(result).toBe(true);
  });

  it("ignores a message from someone other than the agent (e.g. the owner)", () => {
    const events = [
      turnStarted({ atMs: T0, turnId: "t1", source: "channel" }),
      turnCompleted({ atMs: T0 + 1_000, turnId: "t1", outcome: "ok" }),
    ];
    const channelMessages = [message({ pubkey: OWNER_PUBKEY, createdAt: T0 + 2_000 })];

    const result = computeReplySeenAfterLastChannelTurn({
      agentPubkey: AGENT_PUBKEY,
      events,
      channelMessages,
      now: T0 + 1_000 + SWALLOWED_CORROBORATION_WINDOW_MS + 1,
    });

    expect(result).toBe(false);
  });

  it("ignores a message in a different channel", () => {
    const events = [
      turnStarted({ atMs: T0, turnId: "t1", source: "channel" }),
      turnCompleted({ atMs: T0 + 1_000, turnId: "t1", outcome: "ok" }),
    ];
    const channelMessages = [message({ channelId: "some-other-channel", createdAt: T0 + 2_000 })];

    const result = computeReplySeenAfterLastChannelTurn({
      agentPubkey: AGENT_PUBKEY,
      events,
      channelMessages,
      now: T0 + 1_000 + SWALLOWED_CORROBORATION_WINDOW_MS + 1,
    });

    expect(result).toBe(false);
  });

  it("ignores a message posted BEFORE the turn resolved (a stale/earlier reply)", () => {
    const events = [
      turnStarted({ atMs: T0, turnId: "t1", source: "channel" }),
      turnCompleted({ atMs: T0 + 10_000, turnId: "t1", outcome: "ok" }),
    ];
    const channelMessages = [message({ createdAt: T0 + 1_000 })]; // before resolvedAt

    const result = computeReplySeenAfterLastChannelTurn({
      agentPubkey: AGENT_PUBKEY,
      events,
      channelMessages,
      now: T0 + 10_000 + SWALLOWED_CORROBORATION_WINDOW_MS + 1,
    });

    expect(result).toBe(false);
  });

  it("returns null (not yet decided) while the corroboration window is still open and nothing has arrived", () => {
    const events = [
      turnStarted({ atMs: T0, turnId: "t1", source: "channel" }),
      turnCompleted({ atMs: T0 + 1_000, turnId: "t1", outcome: "ok" }),
    ];

    const result = computeReplySeenAfterLastChannelTurn({
      agentPubkey: AGENT_PUBKEY,
      events,
      channelMessages: [],
      now: T0 + 1_000 + SWALLOWED_CORROBORATION_WINDOW_MS - 1,
    });

    expect(result).toBeNull();
  });

  it("returns false once the corroboration window has fully elapsed with no reply", () => {
    const events = [
      turnStarted({ atMs: T0, turnId: "t1", source: "channel" }),
      turnCompleted({ atMs: T0 + 1_000, turnId: "t1", outcome: "ok" }),
    ];

    const result = computeReplySeenAfterLastChannelTurn({
      agentPubkey: AGENT_PUBKEY,
      events,
      channelMessages: [],
      now: T0 + 1_000 + SWALLOWED_CORROBORATION_WINDOW_MS,
    });

    expect(result).toBe(false);
  });

  it("accepts a custom windowMs override", () => {
    const events = [
      turnStarted({ atMs: T0, turnId: "t1", source: "channel" }),
      turnCompleted({ atMs: T0 + 1_000, turnId: "t1", outcome: "ok" }),
    ];

    const result = computeReplySeenAfterLastChannelTurn({
      agentPubkey: AGENT_PUBKEY,
      events,
      channelMessages: [],
      now: T0 + 1_000 + 5_000,
      windowMs: 5_000,
    });

    expect(result).toBe(false);
  });
});
