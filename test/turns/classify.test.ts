import { describe, expect, it } from "vitest";
import { classifySlot, rollupAgentState } from "../../src/turns/classify";
import type {
  ChannelActivity,
  ObserverEvent,
  SlotLivenessResult,
} from "../../src/turns/types";

// Fixture timelines model a single slot's (agentIndex-scoped) decoded
// telemetry stream, chronological. Times are ms epoch throughout; event
// `timestamp` is RFC3339 (matching the wire format) but classify.ts reads
// wall-clock via the `now` it's given plus these events' *offsets*, so tests
// pick a fixed T0 and build events at T0 + Nms for readability.

const T0 = 1_785_000_000_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function turnStarted(opts: {
  atMs: number;
  turnId: string;
  agentIndex?: number;
  source?: string;
  seq?: number;
}): ObserverEvent {
  return {
    seq: opts.seq ?? 0,
    timestamp: iso(opts.atMs),
    kind: "turn_started",
    agentIndex: opts.agentIndex ?? 0,
    channelId: null,
    sessionId: "session-1",
    turnId: opts.turnId,
    payload: opts.source === undefined ? {} : { source: opts.source },
  };
}

function turnLiveness(opts: {
  atMs: number;
  turnId: string;
  agentIndex?: number;
  seq?: number;
}): ObserverEvent {
  return {
    seq: opts.seq ?? 0,
    timestamp: iso(opts.atMs),
    kind: "turn_liveness",
    agentIndex: opts.agentIndex ?? 0,
    channelId: null,
    sessionId: "session-1",
    turnId: opts.turnId,
    payload: {},
  };
}

function turnCompleted(opts: {
  atMs: number;
  turnId: string;
  outcome: string;
  agentIndex?: number;
  seq?: number;
}): ObserverEvent {
  return {
    seq: opts.seq ?? 0,
    timestamp: iso(opts.atMs),
    kind: "turn_completed",
    agentIndex: opts.agentIndex ?? 0,
    channelId: null,
    sessionId: "session-1",
    turnId: opts.turnId,
    payload: { outcome: opts.outcome },
  };
}

function turnError(opts: {
  atMs: number;
  turnId: string;
  outcome: string;
  agentIndex?: number;
  seq?: number;
}): ObserverEvent {
  return {
    seq: opts.seq ?? 0,
    timestamp: iso(opts.atMs),
    kind: "turn_error",
    agentIndex: opts.agentIndex ?? 0,
    channelId: null,
    sessionId: "session-1",
    turnId: opts.turnId,
    payload: { outcome: opts.outcome, error: "boom" },
  };
}

describe("classifySlot — alive", () => {
  it("is alive with no telemetry at all when presence is alive (idle baseline)", () => {
    const result = classifySlot({
      now: T0,
      presence: { liveness: "alive" },
      events: [],
    });

    expect(result.state).toBe("alive");
    expect(result.openTurn).toBeNull();
  });

  it("stays alive for a freshly-opened, normally-ticking turn under the wedged threshold", () => {
    const result = classifySlot({
      now: T0 + 5_000,
      presence: { liveness: "alive" },
      events: [
        turnStarted({ atMs: T0, turnId: "t1", source: "channel" }),
        turnLiveness({ atMs: T0 + 5_000, turnId: "t1" }),
      ],
    });

    expect(result.state).toBe("alive");
    expect(result.openTurn).toMatchObject({ turnId: "t1", source: "channel" });
  });

  it("returns to alive once an open turn resolves ok", () => {
    const result = classifySlot({
      now: T0 + 10_000,
      presence: { liveness: "alive" },
      events: [
        turnStarted({ atMs: T0, turnId: "t1", source: "heartbeat" }),
        turnCompleted({ atMs: T0 + 8_000, turnId: "t1", outcome: "ok" }),
      ],
    });

    expect(result.state).toBe("alive");
    expect(result.openTurn).toBeNull();
  });
});

describe("classifySlot — dead", () => {
  it("is dead when presence is absent and there is no open turn", () => {
    const result = classifySlot({
      now: T0,
      presence: { liveness: "dead" },
      events: [],
    });

    expect(result.state).toBe("dead");
  });

  it("is dead when presence is absent even if the last turn resolved cleanly", () => {
    const result = classifySlot({
      now: T0 + 100_000,
      presence: { liveness: "dead" },
      events: [
        turnStarted({ atMs: T0, turnId: "t1" }),
        turnCompleted({ atMs: T0 + 5_000, turnId: "t1", outcome: "ok" }),
      ],
    });

    expect(result.state).toBe("dead");
  });
});

describe("classifySlot — wedged", () => {
  it("goes wedged once an open turn tickets past the wedged threshold", () => {
    const events: ObserverEvent[] = [turnStarted({ atMs: T0, turnId: "t1" })];
    for (let t = 10_000; t <= 70_000; t += 10_000) {
      events.push(turnLiveness({ atMs: T0 + t, turnId: "t1" }));
    }

    const result = classifySlot({
      now: T0 + 70_000,
      presence: { liveness: "alive" },
      events,
    });

    expect(result.state).toBe("wedged");
    expect(result.openTurn?.turnId).toBe("t1");
  });

  it("stays wedged right up to (but not past) the 7200s hard cap", () => {
    const events: ObserverEvent[] = [turnStarted({ atMs: T0, turnId: "t1" })];
    events.push(turnLiveness({ atMs: T0 + 7_190_000, turnId: "t1" }));

    const result = classifySlot({
      now: T0 + 7_195_000,
      presence: { liveness: "alive" },
      events,
    });

    expect(result.state).toBe("wedged");
  });
});

describe("classifySlot — crashed-mid-turn", () => {
  it("corroborates via presence: open turn + presence goes dead => crashed-mid-turn", () => {
    const result = classifySlot({
      now: T0 + 95_000,
      presence: { liveness: "dead" },
      events: [
        turnStarted({ atMs: T0, turnId: "t1" }),
        turnLiveness({ atMs: T0 + 10_000, turnId: "t1" }),
      ],
    });

    expect(result.state).toBe("crashed-mid-turn");
    expect(result.openTurn?.turnId).toBe("t1");
  });

  it("corroborates via turn timeout: ticks stopped and idle_timeout (900s since the last tick) elapsed, even if presence hasn't caught up", () => {
    const result = classifySlot({
      now: T0 + 10_000 + 900_000,
      presence: { liveness: "alive" },
      events: [
        turnStarted({ atMs: T0, turnId: "t1" }),
        turnLiveness({ atMs: T0 + 10_000, turnId: "t1" }),
      ],
    });

    expect(result.state).toBe("crashed-mid-turn");
  });

  it("corroborates via turn timeout: turn open past the 7200s hard cap with no resolution", () => {
    const result = classifySlot({
      now: T0 + 7_200_001,
      presence: { liveness: "alive" },
      events: [
        turnStarted({ atMs: T0, turnId: "t1" }),
        turnLiveness({ atMs: T0 + 7_190_000, turnId: "t1" }),
      ],
    });

    expect(result.state).toBe("crashed-mid-turn");
  });
});

describe("classifySlot — the silent-drop guardrail (hard rule, dedicated tests)", () => {
  it("does NOT flip an alive, freshly-opened turn to crashed-mid-turn on a bare tick gap with presence still alive", () => {
    // Turn opened 5s ago, exactly one tick, then a 40s gap — well under both
    // wedgedAfterMs-then-idle math and the 900s idle_timeout corroboration
    // bound. Presence is alive throughout. This must stay put, not flip.
    const result = classifySlot({
      now: T0 + 45_000,
      presence: { liveness: "alive" },
      events: [
        turnStarted({ atMs: T0, turnId: "t1" }),
        turnLiveness({ atMs: T0 + 5_000, turnId: "t1" }),
      ],
    });

    expect(result.state).not.toBe("crashed-mid-turn");
    expect(result.state).not.toBe("dead");
  });

  it("does NOT flip an already-wedged turn to crashed-mid-turn on a bare tick gap with presence still alive", () => {
    const events: ObserverEvent[] = [turnStarted({ atMs: T0, turnId: "t1" })];
    for (let t = 10_000; t <= 70_000; t += 10_000) {
      events.push(turnLiveness({ atMs: T0 + t, turnId: "t1" }));
    }
    // Ticks then go silent for 40s (a plausible rate-limiter silent-drop
    // window) while presence stays alive and we're nowhere near the 900s
    // idle_timeout corroboration bound.
    const previous = classifySlot({
      now: T0 + 70_000,
      presence: { liveness: "alive" },
      events,
    });
    expect(previous.state).toBe("wedged");

    const result = classifySlot({
      now: T0 + 110_000,
      presence: { liveness: "alive" },
      events,
      previous,
    });

    expect(result.state).toBe("wedged");
    expect(result.state).not.toBe("crashed-mid-turn");
  });

  it("does NOT flip to dead on a presence-poll-shaped gap alone when telemetry keeps ticking (presence lagging, not absent)", () => {
    // Regression guard for the inverse direction: telemetry says the turn is
    // healthy; a stale-but-not-yet-dead presence read must not force a
    // worse state than the telemetry supports.
    const result = classifySlot({
      now: T0 + 20_000,
      presence: { liveness: "alive" },
      events: [
        turnStarted({ atMs: T0, turnId: "t1" }),
        turnLiveness({ atMs: T0 + 10_000, turnId: "t1" }),
        turnLiveness({ atMs: T0 + 20_000, turnId: "t1" }),
      ],
    });

    expect(result.state).toBe("alive");
  });
});

describe("classifySlot — heartbeat vs channel turn sources", () => {
  it("attributes a channel-sourced turn_started to openTurn.source", () => {
    const result = classifySlot({
      now: T0,
      presence: { liveness: "alive" },
      events: [turnStarted({ atMs: T0, turnId: "t1", source: "channel" })],
    });

    expect(result.openTurn?.source).toBe("channel");
  });

  it("attributes a heartbeat-sourced turn_started to openTurn.source", () => {
    const result = classifySlot({
      now: T0,
      presence: { liveness: "alive" },
      events: [turnStarted({ atMs: T0, turnId: "t1", source: "heartbeat" })],
    });

    expect(result.openTurn?.source).toBe("heartbeat");
  });

  it("falls back to 'unknown' for a missing or unrecognized source rather than throwing", () => {
    const result = classifySlot({
      now: T0,
      presence: { liveness: "alive" },
      events: [turnStarted({ atMs: T0, turnId: "t1" })],
    });

    expect(result.openTurn?.source).toBe("unknown");
  });
});

describe("classifySlot — elided payloads parse defensively", () => {
  it("keeps tracking an open turn whose liveness payload is a whole-payload elision stub", () => {
    const result = classifySlot({
      now: T0 + 10_000,
      presence: { liveness: "alive" },
      events: [
        turnStarted({ atMs: T0, turnId: "t1", source: "channel" }),
        {
          seq: 1,
          timestamp: iso(T0 + 10_000),
          kind: "turn_liveness",
          agentIndex: 0,
          channelId: null,
          sessionId: "session-1",
          turnId: "t1",
          payload: { elided: "turn_liveness payload too large", originalBytes: 120_000 },
        },
      ],
    });

    expect(result.state).toBe("alive");
    expect(result.openTurn?.turnId).toBe("t1");
  });

  it("does not throw on an inline elision marker nested in a turn_error payload", () => {
    expect(() =>
      classifySlot({
        now: T0 + 10_000,
        presence: { liveness: "alive" },
        events: [
          turnStarted({ atMs: T0, turnId: "t1" }),
          {
            seq: 1,
            timestamp: iso(T0 + 10_000),
            kind: "turn_error",
            agentIndex: 0,
            channelId: null,
            sessionId: "session-1",
            turnId: "t1",
            payload: {
              outcome: "error",
              error: "tool output …[elided 900000 bytes]… tail bytes here",
            },
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe("classifySlot — unknown frame kinds are default pass-through", () => {
  it("ignores an unrecognized kind without affecting open-turn tracking", () => {
    const result = classifySlot({
      now: T0 + 5_000,
      presence: { liveness: "alive" },
      events: [
        turnStarted({ atMs: T0, turnId: "t1" }),
        {
          seq: 1,
          timestamp: iso(T0 + 2_000),
          kind: "some_future_frame_kind_v3",
          agentIndex: 0,
          channelId: null,
          sessionId: "session-1",
          turnId: "t1",
          payload: { anything: "goes" },
        },
        turnLiveness({ atMs: T0 + 5_000, turnId: "t1" }),
      ],
    });

    expect(result.state).toBe("alive");
    expect(result.openTurn?.turnId).toBe("t1");
  });
});

describe("classifySlot — circuit breaker is per-slot (agentIndex-scoped)", () => {
  // Slot 0: three crash/respawn cycles inside 60s (threshold from
  // buzz-acp/src/lib.rs CIRCUIT_BREAKER_THRESHOLD=3, WINDOW=60s), the third
  // resolving fatally, then total silence for the 300s cooldown
  // (CIRCUIT_BREAKER_COOLDOWN) while sibling slot 1 keeps working normally.
  const slot0Events: ObserverEvent[] = [
    turnStarted({ atMs: T0, turnId: "t1", agentIndex: 0 }),
    turnCompleted({ atMs: T0 + 1_000, turnId: "t1", outcome: "exited", agentIndex: 0 }),
    turnStarted({ atMs: T0 + 2_000, turnId: "t2", agentIndex: 0 }),
    turnCompleted({ atMs: T0 + 3_000, turnId: "t2", outcome: "exited", agentIndex: 0 }),
    turnStarted({ atMs: T0 + 4_000, turnId: "t3", agentIndex: 0 }),
    turnCompleted({ atMs: T0 + 5_000, turnId: "t3", outcome: "hard_timeout", agentIndex: 0 }),
    // circuit opens here — silence for 300s follows.
  ];

  const slot1Events: ObserverEvent[] = [
    turnStarted({ atMs: T0, turnId: "s1", agentIndex: 1 }),
    turnCompleted({ atMs: T0 + 4_000, turnId: "s1", outcome: "ok", agentIndex: 1 }),
    turnStarted({ atMs: T0 + 60_000, turnId: "s2", agentIndex: 1 }),
    turnCompleted({ atMs: T0 + 64_000, turnId: "s2", outcome: "ok", agentIndex: 1 }),
  ];

  it("reads the tripped slot as dead once it has been silent past the 300s cooldown", () => {
    const result = classifySlot({
      now: T0 + 5_000 + 300_000 + 1,
      presence: { liveness: "alive" }, // process-wide presence stays alive — slot 1 keeps it up
      events: slot0Events,
    });

    expect(result.state).toBe("dead");
  });

  it("does not punish the sibling slot for slot 0's crash streak", () => {
    const result = classifySlot({
      now: T0 + 5_000 + 300_000 + 1,
      presence: { liveness: "alive" },
      events: slot1Events,
    });

    expect(result.state).toBe("alive");
  });

  it("does not yet call the tripped slot dead before the cooldown has elapsed", () => {
    const result = classifySlot({
      now: T0 + 5_000 + 10_000, // well inside the 300s cooldown
      presence: { liveness: "alive" },
      events: slot0Events,
    });

    expect(result.state).toBe("alive");
  });
});

describe("classifySlot — deaf", () => {
  it("flags deaf when the channel is active with zero channel-sourced turn_starts and an unreacted message", () => {
    const channelActivity: ChannelActivity = {
      recentMessages: [
        { postedAt: T0 - 30_000, reactionSeen: false },
        { postedAt: T0 - 20_000, reactionSeen: false },
      ],
      replySeenAfterLastChannelTurn: null,
    };

    const result = classifySlot({
      now: T0,
      presence: { liveness: "alive" },
      events: [],
      channelActivity,
    });

    expect(result.state).toBe("deaf");
  });

  it("does not flag deaf when a channel-sourced turn_started exists in the window", () => {
    const channelActivity: ChannelActivity = {
      recentMessages: [{ postedAt: T0 - 10_000, reactionSeen: false }],
      replySeenAfterLastChannelTurn: null,
    };

    const result = classifySlot({
      now: T0,
      presence: { liveness: "alive" },
      events: [
        turnStarted({ atMs: T0 - 5_000, turnId: "t1", source: "channel" }),
        turnCompleted({ atMs: T0 - 1_000, turnId: "t1", outcome: "ok" }),
      ],
      channelActivity,
    });

    expect(result.state).not.toBe("deaf");
  });

  it("does not flag deaf when every recent message already has a reaction", () => {
    const channelActivity: ChannelActivity = {
      recentMessages: [{ postedAt: T0 - 10_000, reactionSeen: true }],
      replySeenAfterLastChannelTurn: null,
    };

    const result = classifySlot({
      now: T0,
      presence: { liveness: "alive" },
      events: [],
      channelActivity,
    });

    expect(result.state).not.toBe("deaf");
  });
});

describe("classifySlot — swallowed", () => {
  it("flags swallowed when a channel-sourced turn completed ok with no reply seen after", () => {
    const channelActivity: ChannelActivity = {
      recentMessages: [],
      replySeenAfterLastChannelTurn: false,
    };

    const result = classifySlot({
      now: T0 + 5_000,
      presence: { liveness: "alive" },
      events: [
        turnStarted({ atMs: T0, turnId: "t1", source: "channel" }),
        turnCompleted({ atMs: T0 + 1_000, turnId: "t1", outcome: "ok" }),
      ],
      channelActivity,
    });

    expect(result.state).toBe("swallowed");
  });

  it("does not flag swallowed when the reply was seen", () => {
    const channelActivity: ChannelActivity = {
      recentMessages: [],
      replySeenAfterLastChannelTurn: true,
    };

    const result = classifySlot({
      now: T0 + 5_000,
      presence: { liveness: "alive" },
      events: [
        turnStarted({ atMs: T0, turnId: "t1", source: "channel" }),
        turnCompleted({ atMs: T0 + 1_000, turnId: "t1", outcome: "ok" }),
      ],
      channelActivity,
    });

    expect(result.state).not.toBe("swallowed");
  });

  it("does not flag swallowed for a heartbeat-sourced turn (nothing to reply to)", () => {
    const channelActivity: ChannelActivity = {
      recentMessages: [],
      replySeenAfterLastChannelTurn: false,
    };

    const result = classifySlot({
      now: T0 + 5_000,
      presence: { liveness: "alive" },
      events: [
        turnStarted({ atMs: T0, turnId: "t1", source: "heartbeat" }),
        turnCompleted({ atMs: T0 + 1_000, turnId: "t1", outcome: "ok" }),
      ],
      channelActivity,
    });

    expect(result.state).not.toBe("swallowed");
  });
});

describe("classifySlot — turn_error carries outcome/error/code as-is", () => {
  it("does not treat a bare application-class 'error' outcome as fatal-silence material", () => {
    // Matches lib.rs: PromptOutcome::Error(pipe-intact) returns the agent to
    // the pool — no respawn, no slot silence. outcome_label alone can't tell
    // this apart from a transport-fatal error (error_class would, but
    // block/buzz#2240/#2289 are unmerged) so bare "error" must not trigger
    // the fatal-quiet-slot path.
    const events: ObserverEvent[] = [
      turnStarted({ atMs: T0, turnId: "t1" }),
      turnError({ atMs: T0 + 1_000, turnId: "t1", outcome: "error" }),
    ];

    const result = classifySlot({
      now: T0 + 1_000 + 300_000 + 1,
      presence: { liveness: "alive" },
      events,
    });

    expect(result.state).toBe("alive");
  });
});

describe("classifySlot — lastTransitionAt hysteresis", () => {
  it("stamps lastTransitionAt at first classification", () => {
    const result = classifySlot({
      now: T0,
      presence: { liveness: "alive" },
      events: [],
    });

    expect(result.lastTransitionAt).toBe(T0);
  });

  it("carries lastTransitionAt forward unchanged across calls that don't change state", () => {
    const first = classifySlot({
      now: T0,
      presence: { liveness: "alive" },
      events: [],
    });

    const second = classifySlot({
      now: T0 + 30_000,
      presence: { liveness: "alive" },
      events: [],
      previous: first,
    });

    expect(second.state).toBe("alive");
    expect(second.lastTransitionAt).toBe(T0);
  });

  it("updates lastTransitionAt to the evaluation time a genuine transition is observed", () => {
    const first = classifySlot({
      now: T0,
      presence: { liveness: "alive" },
      events: [],
    });

    const second = classifySlot({
      now: T0 + 90_000,
      presence: { liveness: "dead" },
      events: [],
      previous: first,
    });

    expect(second.state).toBe("dead");
    expect(second.lastTransitionAt).toBe(T0 + 90_000);
  });
});

describe("rollupAgentState", () => {
  const alive: SlotLivenessResult = { state: "alive", lastTransitionAt: T0, openTurn: null };
  const dead: SlotLivenessResult = { state: "dead", lastTransitionAt: T0, openTurn: null };
  const wedged: SlotLivenessResult = { state: "wedged", lastTransitionAt: T0, openTurn: null };
  const crashed: SlotLivenessResult = {
    state: "crashed-mid-turn",
    lastTransitionAt: T0,
    openTurn: null,
  };
  const deaf: SlotLivenessResult = { state: "deaf", lastTransitionAt: T0, openTurn: null };
  const swallowed: SlotLivenessResult = {
    state: "swallowed",
    lastTransitionAt: T0,
    openTurn: null,
  };

  it("falls back to presence alone when there are no slots (no owner key / no telemetry yet)", () => {
    expect(rollupAgentState([], { liveness: "alive" })).toBe("alive");
    expect(rollupAgentState([], { liveness: "dead" })).toBe("dead");
  });

  it("surfaces crashed-mid-turn over every other slot state", () => {
    expect(rollupAgentState([alive, crashed, wedged], { liveness: "alive" })).toBe(
      "crashed-mid-turn",
    );
  });

  it("surfaces wedged over swallowed/deaf/dead/alive", () => {
    expect(rollupAgentState([alive, wedged, deaf], { liveness: "alive" })).toBe("wedged");
  });

  it("surfaces swallowed over deaf/dead/alive", () => {
    expect(rollupAgentState([alive, swallowed, deaf], { liveness: "alive" })).toBe("swallowed");
  });

  it("surfaces deaf over dead/alive", () => {
    expect(rollupAgentState([alive, dead, deaf], { liveness: "alive" })).toBe("deaf");
  });

  it("is alive if any slot is alive and nothing worse is present", () => {
    expect(rollupAgentState([alive, dead], { liveness: "alive" })).toBe("alive");
  });

  it("is dead only when every slot is dead", () => {
    expect(rollupAgentState([dead, dead], { liveness: "dead" })).toBe("dead");
  });
});
