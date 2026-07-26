/** @vitest-environment node */
import { getPublicKey } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { createTurnsDaemon } from "../../src/server/turnsDaemon";
import type { ConnectTurnsStreamFn } from "../../src/server/turnsDaemon";
import type { FleetConfig } from "../../src/config/types";
import type { ObserverEvent } from "../../src/turns/types";

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

function ownerKeyFor(seed: number): Uint8Array {
  // Deterministic 32-byte "secret key" for test wiring only — never a real
  // owner key, and this module doesn't touch nostr-tools' curve math at all
  // (that's proven in wsClient.test.ts / decrypt.test.ts); it only needs
  // *some* Uint8Array plus a getPublicKey-derivable pubkey for wiring checks.
  const bytes = new Uint8Array(32);
  bytes.fill(seed % 251 || 1);
  return bytes;
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
      loadOwnerSecretKey: () => ownerKeyFor(1),
      connectTurnsStream: connectTurnsStream as unknown as ConnectTurnsStreamFn,
    });

    daemon.start();
    daemon.stop();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("getSnapshot returns an empty relay list before start() is called", () => {
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
      loadOwnerSecretKey: () => ownerKeyFor(1),
      connectTurnsStream: vi.fn().mockReturnValue({ close: vi.fn() }) as unknown as ConnectTurnsStreamFn,
    });

    expect(daemon.getSnapshot().relays).toEqual([]);
  });
});
