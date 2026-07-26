/** @vitest-environment node */
import { getPublicKey } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { createTurnsDaemon } from "../../src/server/turnsDaemon";
import type {
  ConnectChannelMessagesStreamFn,
  ConnectMetricsStreamFn,
  ConnectTurnsStreamFn,
} from "../../src/server/turnsDaemon";
import type { FleetConfig } from "../../src/config/types";
import type { ObserverEvent } from "../../src/turns/types";
import type { TurnMetricRecord } from "../../src/cost/types";
import type { ChannelMessageRecord } from "../../src/turns/swallowed";

const AGENT_A_PK = "a".repeat(64);
const AGENT_B_PK = "b".repeat(64);

function makeEvent(overrides: Partial<ObserverEvent> = {}): ObserverEvent {
  return {
    seq: 1,
    timestamp: "2026-04-29T12:00:00.000Z",
    kind: "turn_started",
    agentIndex: 0,
    channelId: null,
    sessionId: null,
    turnId: null,
    payload: {},
    ...overrides,
  };
}

function metricRecord(overrides: Partial<TurnMetricRecord> = {}): TurnMetricRecord {
  return {
    eventId: "evt-" + Math.random().toString(36).slice(2),
    agentPubkey: AGENT_A_PK,
    harness: "goose",
    model: "claude-sonnet-4-5",
    channelId: null,
    sessionId: "s1",
    turnId: null,
    turnSeq: 1,
    timestampMs: 1_785_000_000_000,
    turn: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.01 },
    cumulative: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.01 },
    deltaReliable: true,
    stopReason: "end_turn",
    ...overrides,
  };
}

function channelMessageRecord(overrides: Partial<ChannelMessageRecord> = {}): ChannelMessageRecord {
  return {
    pubkey: AGENT_A_PK,
    channelId: "chan-1",
    createdAt: 1_785_000_000_000,
    ...overrides,
  };
}

function ownerKeyFor(seed: number): Uint8Array {
  // Deterministic 32-byte "secret key" for test wiring only — never a real
  // owner key, and this module doesn't touch nostr-tools' curve math at all
  // (that's proven in wsClient.test.ts / decrypt.test.ts); it only needs
  // *some* Uint8Array plus a getPublicKey-derivable pubkey for wiring checks.
  const bytes = new Uint8Array(32);
  bytes.fill(seed % 251 || 1);
  return bytes;
}

/** Every relay in these tests configures an owner key, so v0.3 also opens a
 * metrics (44200) and a channel-messages (kind 9) connection alongside the
 * turns (24200) one. Tests that don't care about those two streams still
 * need a harmless double for them (production defaults to the REAL network
 * clients — see turnsMiddleware.ts calling createTurnsDaemon with no deps
 * override), plus an isolated in-memory cost store so no test touches disk
 * or another test's data. */
function baseDeps() {
  return {
    connectMetricsStream: vi
      .fn()
      .mockReturnValue({ close: vi.fn() }) as unknown as ConnectMetricsStreamFn,
    connectChannelMessagesStream: vi
      .fn()
      .mockReturnValue({ close: vi.fn() }) as unknown as ConnectChannelMessagesStreamFn,
    costStorePath: ":memory:",
  };
}

describe("createTurnsDaemon", () => {
  it("only opens connections for relays with an owner key configured", () => {
    const config: FleetConfig = {
      pollIntervalMs: 20_000,
      deadAfterMs: 90_000,
      relays: [
        {
          url: "http://localhost:3000",
          callerPubkey: AGENT_A_PK,
          roster: [{ pubkey: AGENT_A_PK, label: "a" }],
          ownerKeyEnv: "TEST_OWNER_KEY",
        },
        {
          url: "http://localhost:3001",
          callerPubkey: AGENT_B_PK,
          roster: [{ pubkey: AGENT_B_PK, label: "b" }],
          // no owner key — v0.1 presence-only relay
        },
      ],
    };

    const connectTurnsStream = vi.fn().mockReturnValue({ close: vi.fn() });
    const daemon = createTurnsDaemon(config, {
      ...baseDeps(),
      loadOwnerSecretKey: () => ownerKeyFor(1),
      connectTurnsStream: connectTurnsStream as unknown as ConnectTurnsStreamFn,
    });

    daemon.start();

    expect(connectTurnsStream).toHaveBeenCalledTimes(1);
    expect(connectTurnsStream.mock.calls[0]?.[0]).toMatchObject({
      relayUrl: "ws://localhost:3000",
    });
  });

  it("passes the relay's roster pubkeys as the trusted-agent set", () => {
    const config: FleetConfig = {
      pollIntervalMs: 20_000,
      deadAfterMs: 90_000,
      relays: [
        {
          url: "http://localhost:3000",
          callerPubkey: AGENT_A_PK,
          roster: [
            { pubkey: AGENT_A_PK, label: "a" },
            { pubkey: AGENT_B_PK, label: "b" },
          ],
          ownerKeyEnv: "TEST_OWNER_KEY",
        },
      ],
    };

    const connectTurnsStream = vi.fn().mockReturnValue({ close: vi.fn() });
    const daemon = createTurnsDaemon(config, {
      ...baseDeps(),
      loadOwnerSecretKey: () => ownerKeyFor(1),
      connectTurnsStream: connectTurnsStream as unknown as ConnectTurnsStreamFn,
    });

    daemon.start();

    expect(connectTurnsStream.mock.calls[0]?.[0]?.trustedAgentPubkeys).toEqual(
      new Set([AGENT_A_PK, AGENT_B_PK]),
    );
  });

  it("routes incoming frames into a per-agent-pubkey ring buffer, exposed by getSnapshot", () => {
    const config: FleetConfig = {
      pollIntervalMs: 20_000,
      deadAfterMs: 90_000,
      relays: [
        {
          url: "http://localhost:3000",
          callerPubkey: AGENT_A_PK,
          roster: [{ pubkey: AGENT_A_PK, label: "a" }],
          ownerKeyEnv: "TEST_OWNER_KEY",
        },
      ],
    };

    let capturedOnFrame: ((frame: { agentPubkey: string; event: ObserverEvent }) => void) | undefined;
    const connectTurnsStream = vi.fn((opts) => {
      capturedOnFrame = opts.onFrame;
      return { close: vi.fn() };
    });
    const daemon = createTurnsDaemon(config, {
      ...baseDeps(),
      loadOwnerSecretKey: () => ownerKeyFor(1),
      connectTurnsStream: connectTurnsStream as unknown as ConnectTurnsStreamFn,
    });

    daemon.start();
    capturedOnFrame?.({ agentPubkey: AGENT_A_PK, event: makeEvent({ turnId: "t1" }) });
    capturedOnFrame?.({ agentPubkey: AGENT_A_PK, event: makeEvent({ turnId: "t1", seq: 2, kind: "turn_liveness" }) });

    const snapshot = daemon.getSnapshot();
    expect(snapshot.relays).toHaveLength(1);
    const relaySnapshot = snapshot.relays[0];
    expect(relaySnapshot?.configuredUrl).toBe("http://localhost:3000");
    expect(relaySnapshot?.ownerPubkey).toBe(getPublicKey(ownerKeyFor(1)));
    expect(relaySnapshot?.agents).toHaveLength(1);
    expect(relaySnapshot?.agents[0]?.pubkey).toBe(AGENT_A_PK);
    expect(relaySnapshot?.agents[0]?.events.map((e) => e.kind)).toEqual([
      "turn_started",
      "turn_liveness",
    ]);
  });

  it("tracks connection status and the last notice via the callbacks passed to connectTurnsStream", () => {
    const config: FleetConfig = {
      pollIntervalMs: 20_000,
      deadAfterMs: 90_000,
      relays: [
        {
          url: "http://localhost:3000",
          callerPubkey: AGENT_A_PK,
          roster: [{ pubkey: AGENT_A_PK, label: "a" }],
          ownerKeyEnv: "TEST_OWNER_KEY",
        },
      ],
    };

    let onStatusChange: ((status: string) => void) | undefined;
    let onNotice: ((message: string) => void) | undefined;
    const connectTurnsStream = vi.fn((opts) => {
      onStatusChange = opts.onStatusChange;
      onNotice = opts.onNotice;
      return { close: vi.fn() };
    });
    const daemon = createTurnsDaemon(config, {
      ...baseDeps(),
      loadOwnerSecretKey: () => ownerKeyFor(1),
      connectTurnsStream: connectTurnsStream as unknown as ConnectTurnsStreamFn,
    });

    daemon.start();
    onStatusChange?.("connected");
    onNotice?.("rate-limited: observer frame rate exceeded (100/sec per agent)");

    const snapshot = daemon.getSnapshot();
    expect(snapshot.relays[0]?.status).toBe("connected");
    expect(snapshot.relays[0]?.lastNotice).toBe(
      "rate-limited: observer frame rate exceeded (100/sec per agent)",
    );
  });

  // Live-rig regression: the pre-AUTH subscription attempt emits
  // "auth-required: not authenticated", and with nothing to clear it the board
  // kept displaying that error against a relay that was authenticated and
  // decoding frames. EOSE (onSubscribed) means the subscription is live.
  it("clears a stale notice once the subscription is re-established", () => {
    const config: FleetConfig = {
      pollIntervalMs: 20_000,
      deadAfterMs: 90_000,
      relays: [
        {
          url: "http://localhost:3000",
          callerPubkey: AGENT_A_PK,
          roster: [{ pubkey: AGENT_A_PK, label: "a" }],
          ownerKeyEnv: "TEST_OWNER_KEY",
        },
      ],
    };

    let onNotice: ((message: string) => void) | undefined;
    let onSubscribed: (() => void) | undefined;
    const connectTurnsStream = vi.fn((opts) => {
      onNotice = opts.onNotice;
      onSubscribed = opts.onSubscribed;
      return { close: vi.fn() };
    });
    const daemon = createTurnsDaemon(config, {
      ...baseDeps(),
      loadOwnerSecretKey: () => ownerKeyFor(1),
      connectTurnsStream: connectTurnsStream as unknown as ConnectTurnsStreamFn,
    });

    daemon.start();
    onNotice?.("turns subscription closed: auth-required: not authenticated");
    expect(daemon.getSnapshot().relays[0]?.lastNotice).toBe(
      "turns subscription closed: auth-required: not authenticated",
    );

    onSubscribed?.();

    expect(daemon.getSnapshot().relays[0]?.lastNotice).toBeNull();
  });

  it("isolates a per-relay owner-key load failure — other relays still connect", () => {
    const config: FleetConfig = {
      pollIntervalMs: 20_000,
      deadAfterMs: 90_000,
      relays: [
        {
          url: "http://localhost:3000",
          callerPubkey: AGENT_A_PK,
          roster: [{ pubkey: AGENT_A_PK, label: "a" }],
          ownerKeyEnv: "TEST_OWNER_KEY_BROKEN",
        },
        {
          url: "http://localhost:3001",
          callerPubkey: AGENT_B_PK,
          roster: [{ pubkey: AGENT_B_PK, label: "b" }],
          ownerKeyEnv: "TEST_OWNER_KEY_OK",
        },
      ],
    };

    const connectTurnsStream = vi.fn().mockReturnValue({ close: vi.fn() });
    const daemon = createTurnsDaemon(config, {
      ...baseDeps(),
      loadOwnerSecretKey: (ref) => {
        if (ref.ownerKeyEnv === "TEST_OWNER_KEY_BROKEN") {
          throw new Error("simulated: env var not set");
        }
        return ownerKeyFor(2);
      },
      connectTurnsStream: connectTurnsStream as unknown as ConnectTurnsStreamFn,
    });

    expect(() => daemon.start()).not.toThrow();

    expect(connectTurnsStream).toHaveBeenCalledTimes(1);
    const snapshot = daemon.getSnapshot();
    expect(snapshot.relays).toHaveLength(2);
    const broken = snapshot.relays.find((r) => r.configuredUrl === "http://localhost:3000");
    const ok = snapshot.relays.find((r) => r.configuredUrl === "http://localhost:3001");
    expect(broken?.status).toBe("error");
    expect(broken?.lastNotice).toMatch(/simulated: env var not set/);
    expect(ok?.status).not.toBe("error");
  });

  it("stop() closes every open connection", () => {
    const config: FleetConfig = {
      pollIntervalMs: 20_000,
      deadAfterMs: 90_000,
      relays: [
        {
          url: "http://localhost:3000",
          callerPubkey: AGENT_A_PK,
          roster: [{ pubkey: AGENT_A_PK, label: "a" }],
          ownerKeyEnv: "TEST_OWNER_KEY",
        },
      ],
    };

    const close = vi.fn();
    const connectTurnsStream = vi.fn().mockReturnValue({ close });
    const daemon = createTurnsDaemon(config, {
      ...baseDeps(),
      loadOwnerSecretKey: () => ownerKeyFor(1),
      connectTurnsStream: connectTurnsStream as unknown as ConnectTurnsStreamFn,
    });

    daemon.start();
    daemon.stop();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("getSnapshot returns an empty relay list and all-zero cost before start() is called", () => {
    const config: FleetConfig = {
      pollIntervalMs: 20_000,
      deadAfterMs: 90_000,
      relays: [
        {
          url: "http://localhost:3000",
          callerPubkey: AGENT_A_PK,
          roster: [{ pubkey: AGENT_A_PK }],
          ownerKeyEnv: "TEST_OWNER_KEY",
        },
      ],
    };

    const daemon = createTurnsDaemon(config, {
      ...baseDeps(),
      loadOwnerSecretKey: () => ownerKeyFor(1),
      connectTurnsStream: vi.fn().mockReturnValue({ close: vi.fn() }) as unknown as ConnectTurnsStreamFn,
    });

    const snapshot = daemon.getSnapshot();
    expect(snapshot.relays).toEqual([]);
    expect(snapshot.cost).toEqual({
      perAgent: [],
      fleetTotal: { agentCount: 0, turnCount: 0, totalTokens: 0, totalCostUsd: 0 },
      trend: [],
    });
  });

  describe("v0.3: cost (kind 44200) and channel-messages (kind 9) wiring", () => {
    function singleRelayConfig(ownerKeyEnv = "TEST_OWNER_KEY"): FleetConfig {
      return {
        pollIntervalMs: 20_000,
        deadAfterMs: 90_000,
        relays: [
          {
            url: "http://localhost:3000",
            callerPubkey: AGENT_A_PK,
            roster: [{ pubkey: AGENT_A_PK, label: "gatekeeper" }],
            ownerKeyEnv,
          },
        ],
      };
    }

    it("opens a metrics stream and a channel-messages stream for every relay with an owner key configured", () => {
      const connectMetricsStream = vi.fn().mockReturnValue({ close: vi.fn() });
      const connectChannelMessagesStream = vi.fn().mockReturnValue({ close: vi.fn() });
      const daemon = createTurnsDaemon(singleRelayConfig(), {
        loadOwnerSecretKey: () => ownerKeyFor(1),
        connectTurnsStream: vi.fn().mockReturnValue({ close: vi.fn() }) as unknown as ConnectTurnsStreamFn,
        connectMetricsStream: connectMetricsStream as unknown as ConnectMetricsStreamFn,
        connectChannelMessagesStream:
          connectChannelMessagesStream as unknown as ConnectChannelMessagesStreamFn,
        costStorePath: ":memory:",
      });

      daemon.start();

      expect(connectMetricsStream).toHaveBeenCalledTimes(1);
      expect(connectMetricsStream.mock.calls[0]?.[0]).toMatchObject({ relayUrl: "ws://localhost:3000" });
      expect(connectChannelMessagesStream).toHaveBeenCalledTimes(1);
      expect(connectChannelMessagesStream.mock.calls[0]?.[0]).toMatchObject({
        relayUrl: "ws://localhost:3000",
      });
    });

    it("persists incoming metric records into the cost store, exposed via getSnapshot().cost", () => {
      let capturedOnRecord: ((record: TurnMetricRecord) => void) | undefined;
      const connectMetricsStream = vi.fn((opts) => {
        capturedOnRecord = opts.onRecord;
        return { close: vi.fn() };
      });
      const daemon = createTurnsDaemon(singleRelayConfig(), {
        loadOwnerSecretKey: () => ownerKeyFor(1),
        connectTurnsStream: vi.fn().mockReturnValue({ close: vi.fn() }) as unknown as ConnectTurnsStreamFn,
        connectMetricsStream: connectMetricsStream as unknown as ConnectMetricsStreamFn,
        connectChannelMessagesStream: vi
          .fn()
          .mockReturnValue({ close: vi.fn() }) as unknown as ConnectChannelMessagesStreamFn,
        costStorePath: ":memory:",
      });

      daemon.start();
      capturedOnRecord?.(metricRecord({ eventId: "evt-1", agentPubkey: AGENT_A_PK }));
      capturedOnRecord?.(metricRecord({ eventId: "evt-2", agentPubkey: AGENT_A_PK }));

      const { cost } = daemon.getSnapshot();
      expect(cost.perAgent).toHaveLength(1);
      expect(cost.perAgent[0]).toMatchObject({
        agentPubkey: AGENT_A_PK,
        label: "gatekeeper",
        turnCount: 2,
        totalTokens: 300,
      });
      expect(cost.fleetTotal).toMatchObject({ agentCount: 1, turnCount: 2, totalTokens: 300 });
    });

    it("is idempotent when the same durable event is delivered twice (e.g. a resubscribe re-crossing history)", () => {
      let capturedOnRecord: ((record: TurnMetricRecord) => void) | undefined;
      const connectMetricsStream = vi.fn((opts) => {
        capturedOnRecord = opts.onRecord;
        return { close: vi.fn() };
      });
      const deps = {
        loadOwnerSecretKey: () => ownerKeyFor(1),
        connectTurnsStream: vi.fn().mockReturnValue({ close: vi.fn() }) as unknown as ConnectTurnsStreamFn,
        connectMetricsStream: connectMetricsStream as unknown as ConnectMetricsStreamFn,
        connectChannelMessagesStream: vi
          .fn()
          .mockReturnValue({ close: vi.fn() }) as unknown as ConnectChannelMessagesStreamFn,
        costStorePath: ":memory:",
      };

      const daemon = createTurnsDaemon(singleRelayConfig(), deps);
      daemon.start();
      capturedOnRecord?.(metricRecord({ eventId: "evt-1" }));
      // Re-delivering the SAME event id (a real resubscribe with a past
      // `since` does this for a durable kind) must not double-count.
      capturedOnRecord?.(metricRecord({ eventId: "evt-1" }));

      expect(daemon.getSnapshot().cost.fleetTotal.turnCount).toBe(1);
    });

    it("aggregates cost fleet-wide, combining records from multiple relays into one summary", () => {
      const config: FleetConfig = {
        pollIntervalMs: 20_000,
        deadAfterMs: 90_000,
        relays: [
          {
            url: "http://localhost:3000",
            callerPubkey: AGENT_A_PK,
            roster: [{ pubkey: AGENT_A_PK, label: "a" }],
            ownerKeyEnv: "TEST_OWNER_KEY_A",
          },
          {
            url: "http://localhost:3001",
            callerPubkey: AGENT_B_PK,
            roster: [{ pubkey: AGENT_B_PK, label: "b" }],
            ownerKeyEnv: "TEST_OWNER_KEY_B",
          },
        ],
      };

      const onRecordByRelay: ((record: TurnMetricRecord) => void)[] = [];
      const connectMetricsStream = vi.fn((opts) => {
        onRecordByRelay.push(opts.onRecord);
        return { close: vi.fn() };
      });
      const daemon = createTurnsDaemon(config, {
        loadOwnerSecretKey: () => ownerKeyFor(1),
        connectTurnsStream: vi.fn().mockReturnValue({ close: vi.fn() }) as unknown as ConnectTurnsStreamFn,
        connectMetricsStream: connectMetricsStream as unknown as ConnectMetricsStreamFn,
        connectChannelMessagesStream: vi
          .fn()
          .mockReturnValue({ close: vi.fn() }) as unknown as ConnectChannelMessagesStreamFn,
        costStorePath: ":memory:",
      });

      daemon.start();
      expect(onRecordByRelay).toHaveLength(2);
      onRecordByRelay[0]?.(metricRecord({ eventId: "evt-a", agentPubkey: AGENT_A_PK }));
      onRecordByRelay[1]?.(metricRecord({ eventId: "evt-b", agentPubkey: AGENT_B_PK }));

      const { cost } = daemon.getSnapshot();
      expect(cost.fleetTotal).toMatchObject({ agentCount: 2, turnCount: 2, totalTokens: 300 });
      expect(cost.perAgent.map((s) => s.agentPubkey).sort()).toEqual([AGENT_A_PK, AGENT_B_PK].sort());
    });

    it("buffers incoming channel messages per relay, exposed via getSnapshot().relays[].channelMessages", () => {
      let capturedOnMessage: ((message: ChannelMessageRecord) => void) | undefined;
      const connectChannelMessagesStream = vi.fn((opts) => {
        capturedOnMessage = opts.onMessage;
        return { close: vi.fn() };
      });
      const daemon = createTurnsDaemon(singleRelayConfig(), {
        loadOwnerSecretKey: () => ownerKeyFor(1),
        connectTurnsStream: vi.fn().mockReturnValue({ close: vi.fn() }) as unknown as ConnectTurnsStreamFn,
        connectMetricsStream: vi
          .fn()
          .mockReturnValue({ close: vi.fn() }) as unknown as ConnectMetricsStreamFn,
        connectChannelMessagesStream:
          connectChannelMessagesStream as unknown as ConnectChannelMessagesStreamFn,
        costStorePath: ":memory:",
      });

      daemon.start();
      capturedOnMessage?.(channelMessageRecord({ channelId: "chan-1" }));
      capturedOnMessage?.(channelMessageRecord({ channelId: "chan-2" }));

      const relaySnapshot = daemon.getSnapshot().relays[0];
      expect(relaySnapshot?.channelMessages).toHaveLength(2);
      expect(relaySnapshot?.channelMessages.map((m) => m.channelId).sort()).toEqual([
        "chan-1",
        "chan-2",
      ]);
    });

    it("stop() also closes the metrics and channel-messages connections", () => {
      const metricsClose = vi.fn();
      const channelMessagesClose = vi.fn();
      const daemon = createTurnsDaemon(singleRelayConfig(), {
        loadOwnerSecretKey: () => ownerKeyFor(1),
        connectTurnsStream: vi.fn().mockReturnValue({ close: vi.fn() }) as unknown as ConnectTurnsStreamFn,
        connectMetricsStream: vi
          .fn()
          .mockReturnValue({ close: metricsClose }) as unknown as ConnectMetricsStreamFn,
        connectChannelMessagesStream: vi
          .fn()
          .mockReturnValue({ close: channelMessagesClose }) as unknown as ConnectChannelMessagesStreamFn,
        costStorePath: ":memory:",
      });

      daemon.start();
      daemon.stop();

      expect(metricsClose).toHaveBeenCalledTimes(1);
      expect(channelMessagesClose).toHaveBeenCalledTimes(1);
    });
  });
});
