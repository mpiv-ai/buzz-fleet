/** @vitest-environment node */
import { finalizeEvent, generateSecretKey, getPublicKey, kinds as nostrKinds, nip44, verifyEvent } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectTurnsStream,
  isRateLimitNotice,
  type RelayLike,
  type Subscription,
} from "../../src/turns/wsClient";
import type { Event as NostrEvent, EventTemplate, Filter, VerifiedEvent } from "nostr-tools";

// A fully in-memory stand-in for nostr-tools' Relay/AbstractRelay — no real
// sockets anywhere in this file. It's driven explicitly by each test
// (emitAuthChallenge/emitEvent/emitNotice/hardClose) and records everything
// the client under test sends it (subscribed filters, auth attempts), so
// each assertion is about the client's *behavior*, not about a real relay's.
class FakeRelay implements RelayLike {
  connected = false;
  onclose: (() => void) | null = null;
  onnotice: (msg: string) => void = () => {};
  onauth: undefined | ((evt: EventTemplate) => Promise<VerifiedEvent>);
  subscribeCalls: { filters: Filter[]; params: SubscribeParams }[] = [];
  authAttempts: VerifiedEvent[] = [];
  closed = false;
  private activeSub: FakeSubscription | null = null;

  constructor(public url: string) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  subscribe(filters: Filter[], params: SubscribeParams): Subscription {
    this.subscribeCalls.push({ filters, params });
    const sub = new FakeSubscription(params);
    this.activeSub = sub;
    return sub;
  }

  close(): void {
    this.closed = true;
    this.connected = false;
  }

  /** Test helper: simulate the relay demanding NIP-42 auth. Mimics real
   * nostr-tools `AbstractRelay` behavior exactly, trailing slash included
   * (`normalizeURL` always appends one to a root-path URL — see
   * abstract-relay.ts / utils.ts) — the client under test must correct
   * this before signing, not this fake. */
  async emitAuthChallenge(challenge: string): Promise<void> {
    if (!this.onauth) throw new Error("no onauth handler registered");
    const normalizedUrl = this.url.endsWith("/") ? this.url : `${this.url}/`;
    const template: EventTemplate = {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["relay", normalizedUrl],
        ["challenge", challenge],
      ],
      content: "",
    };
    const signed = await this.onauth(template);
    this.authAttempts.push(signed);
  }

  /** Test helper: simulate an incoming EVENT frame on the active subscription. */
  emitEvent(event: NostrEvent): void {
    this.activeSub?.params.onevent?.(event);
  }

  /** Test helper: simulate the relay sending NOTICE. */
  emitNotice(message: string): void {
    this.onnotice(message);
  }

  /** Test helper: simulate the relay sending EOSE — the signal that the
   * subscription is established and past events (if any) are flushed. */
  emitEose(): void {
    this.activeSub?.params.oneose?.();
  }

  /** Test helper: simulate the active subscription receiving CLOSED. */
  emitSubscriptionClosed(reason: string): void {
    this.activeSub?.params.onclose?.(reason);
  }

  /** Test helper: simulate the underlying connection dying. */
  hardClose(): void {
    this.connected = false;
    this.onclose?.();
  }
}

interface SubscribeParams {
  onevent?: (evt: NostrEvent) => void;
  onclose?: (reason: string) => void;
  oneose?: () => void;
}

class FakeSubscription implements Subscription {
  constructor(public params: SubscribeParams) {}
  close(): void {}
}

function buildTelemetryEvent(opts: {
  agentSecretKey: Uint8Array;
  ownerPubkey: string;
  plaintext: string;
  agentTagOverride?: string;
  frameTag?: string;
}): NostrEvent {
  const agentPubkey = getPublicKey(opts.agentSecretKey);
  const conversationKey = nip44.getConversationKey(opts.agentSecretKey, opts.ownerPubkey);
  const content = nip44.v2.encrypt(opts.plaintext, conversationKey);
  return finalizeEvent(
    {
      kind: 24200,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["p", opts.ownerPubkey],
        ["agent", opts.agentTagOverride ?? agentPubkey],
        ["frame", opts.frameTag ?? "telemetry"],
      ],
      content,
    },
    opts.agentSecretKey,
  );
}

const TELEMETRY_PLAINTEXT = JSON.stringify({
  seq: 1,
  timestamp: "2026-04-29T12:00:00.000Z",
  kind: "turn_started",
  agentIndex: 0,
  channelId: null,
  sessionId: "s1",
  turnId: "t1",
  payload: { source: "channel" },
});

describe("connectTurnsStream", () => {
  let ownerSecretKey: Uint8Array;
  let ownerPubkey: string;
  let fakeRelay: FakeRelay;

  beforeEach(() => {
    ownerSecretKey = generateSecretKey();
    ownerPubkey = getPublicKey(ownerSecretKey);
    fakeRelay = new FakeRelay("wss://fake.example/relay");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function connect(overrides: Partial<Parameters<typeof connectTurnsStream>[0]> = {}) {
    const onFrame = vi.fn();
    const onNotice = vi.fn();
    const onStatusChange = vi.fn();
    const onSubscribed = vi.fn();
    const handle = connectTurnsStream({
      relayUrl: fakeRelay.url,
      ownerSecretKey,
      ownerPubkey,
      onFrame,
      onNotice,
      onStatusChange,
      onSubscribed,
      relayFactory: () => fakeRelay,
      ...overrides,
    });
    return { handle, onFrame, onNotice, onStatusChange, onSubscribed };
  }

  it("subscribes with kinds=[24200], #p=[ownerPubkey], and a fresh since — never a past since", async () => {
    const fixedNow = 1_785_000_000_000;
    connect({ now: () => fixedNow });
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    const filter = fakeRelay.subscribeCalls[0]?.filters[0];
    expect(filter).toEqual({
      kinds: [24200],
      "#p": [ownerPubkey],
      since: Math.floor(fixedNow / 1000),
    });
  });

  it("answers a NIP-42 AUTH challenge with a validly-signed kind-22242 event", async () => {
    connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    await fakeRelay.emitAuthChallenge("challenge-abc");

    expect(fakeRelay.authAttempts).toHaveLength(1);
    const authEvent = fakeRelay.authAttempts[0];
    expect(authEvent).toBeDefined();
    if (!authEvent) return;
    expect(authEvent.kind).toBe(nostrKinds.ClientAuth);
    expect(authEvent.pubkey).toBe(ownerPubkey);
    expect(verifyEvent(authEvent)).toBe(true);
    expect(authEvent.tags).toContainEqual(["challenge", "challenge-abc"]);
  });

  it("signs the AUTH event with a bare scheme://host relay tag, not nostr-tools' trailing-slash normalization", async () => {
    // Verified against a live buzz-relay (sha-25e7864): its NIP-42 check
    // computes the expected `relay` tag as bare `scheme://host[:port]` with
    // NO path (buzz-relay/src/api/bridge.rs `nip42_expected_relay_url`,
    // built from `TenantContext::host()`, which explicitly rejects any
    // scheme/path/userinfo component — see tenant.rs). nostr-tools'
    // AbstractRelay normalizes a root-path URL to always end in "/" (the
    // WHATWG URL spec won't let a special-scheme URL's pathname go below
    // "/"), so the un-corrected relay tag mismatches byte-for-byte and
    // buzz-relay's auth verification fails every time — permanently for
    // that connection, since AuthState::Failed never re-verifies. This
    // must fix the string field the library's own template already
    // produced, not rebuild the event: finalizeEvent (nostr-tools) still
    // does 100% of the actual signing.
    fakeRelay = new FakeRelay("ws://localhost:3000");
    connect({ relayFactory: () => fakeRelay });
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    await fakeRelay.emitAuthChallenge("challenge-xyz");

    const authEvent = fakeRelay.authAttempts[0];
    expect(authEvent).toBeDefined();
    if (!authEvent) return;
    expect(verifyEvent(authEvent)).toBe(true);
    expect(authEvent.tags).toContainEqual(["relay", "ws://localhost:3000"]);
    expect(authEvent.tags).not.toContainEqual(["relay", "ws://localhost:3000/"]);
  });

  it("decodes a valid telemetry frame end to end and calls onFrame", async () => {
    const agentSecretKey = generateSecretKey();
    const agentPubkey = getPublicKey(agentSecretKey);
    const { onFrame } = connect({ trustedAgentPubkeys: new Set([agentPubkey]) });
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    fakeRelay.emitEvent(
      buildTelemetryEvent({ agentSecretKey, ownerPubkey, plaintext: TELEMETRY_PLAINTEXT }),
    );

    expect(onFrame).toHaveBeenCalledTimes(1);
    const frame = onFrame.mock.calls[0]?.[0];
    expect(frame).toBeDefined();
    expect(frame?.agentPubkey).toBe(agentPubkey);
    expect(frame?.event.kind).toBe("turn_started");
    expect(frame?.event.turnId).toBe("t1");
  });

  it("drops a telemetry frame from an agent pubkey not in the trusted set", async () => {
    const agentSecretKey = generateSecretKey();
    const untrustedPubkey = getPublicKey(generateSecretKey());
    const { onFrame } = connect({ trustedAgentPubkeys: new Set([untrustedPubkey]) });
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    fakeRelay.emitEvent(
      buildTelemetryEvent({ agentSecretKey, ownerPubkey, plaintext: TELEMETRY_PLAINTEXT }),
    );

    expect(onFrame).not.toHaveBeenCalled();
  });

  it("does not drop a telemetry frame when no trusted-set allowlist was configured", async () => {
    const agentSecretKey = generateSecretKey();
    const { onFrame } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    fakeRelay.emitEvent(
      buildTelemetryEvent({ agentSecretKey, ownerPubkey, plaintext: TELEMETRY_PLAINTEXT }),
    );

    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it("ignores a control-frame event (frame=control) — this board only reads telemetry", async () => {
    const agentSecretKey = generateSecretKey();
    const { onFrame } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    fakeRelay.emitEvent(
      buildTelemetryEvent({
        agentSecretKey,
        ownerPubkey,
        plaintext: TELEMETRY_PLAINTEXT,
        frameTag: "control",
      }),
    );

    expect(onFrame).not.toHaveBeenCalled();
  });

  it("drops an event with a bad signature without calling onFrame or throwing", async () => {
    const agentSecretKey = generateSecretKey();
    const { onFrame } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    const tampered = buildTelemetryEvent({
      agentSecretKey,
      ownerPubkey,
      plaintext: TELEMETRY_PLAINTEXT,
    });
    tampered.content = tampered.content.slice(0, -4) + "abcd"; // corrupt without re-signing

    expect(() => fakeRelay.emitEvent(tampered)).not.toThrow();
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("drops an event that fails to decrypt (wrong key) without calling onFrame or throwing", async () => {
    const agentSecretKey = generateSecretKey();
    const someoneElse = generateSecretKey();
    const { onFrame } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    const wrongRecipientEvent = buildTelemetryEvent({
      agentSecretKey,
      ownerPubkey: getPublicKey(someoneElse),
      plaintext: TELEMETRY_PLAINTEXT,
    });

    expect(() => fakeRelay.emitEvent(wrongRecipientEvent)).not.toThrow();
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("forwards NOTICE messages via onNotice without crashing the connection", async () => {
    const { onNotice } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    fakeRelay.emitNotice("rate-limited: observer frame rate exceeded (100/sec per agent)");

    expect(onNotice).toHaveBeenCalledWith(
      "rate-limited: observer frame rate exceeded (100/sec per agent)",
    );
  });

  it("retries the subscription after an auth-required CLOSED, and delivers frames once the retry succeeds", async () => {
    vi.useFakeTimers();
    const agentSecretKey = generateSecretKey();
    const agentPubkey = getPublicKey(agentSecretKey);
    const { onFrame } = connect({ trustedAgentPubkeys: new Set([agentPubkey]) });
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeRelay.subscribeCalls).toHaveLength(1);

    fakeRelay.emitSubscriptionClosed("auth-required: we need you to authenticate");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fakeRelay.subscribeCalls).toHaveLength(2);

    fakeRelay.emitEvent(
      buildTelemetryEvent({ agentSecretKey, ownerPubkey, plaintext: TELEMETRY_PLAINTEXT }),
    );
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it("does not retry the subscription on a non-auth-required CLOSED reason", async () => {
    vi.useFakeTimers();
    connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeRelay.subscribeCalls).toHaveLength(1);

    fakeRelay.emitSubscriptionClosed("restricted: not a member of this community");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fakeRelay.subscribeCalls).toHaveLength(1);
  });

  it("gives up retrying an auth-required CLOSED after a bounded number of attempts", async () => {
    vi.useFakeTimers();
    connect();
    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 10; i++) {
      fakeRelay.emitSubscriptionClosed("auth-required: still not authenticated");
      await vi.advanceTimersByTimeAsync(1_000);
    }

    const totalCalls = fakeRelay.subscribeCalls.length;
    fakeRelay.emitSubscriptionClosed("auth-required: still not authenticated");
    await vi.advanceTimersByTimeAsync(5_000);

    // Bounded: retrying stopped well short of 10 further attempts.
    expect(fakeRelay.subscribeCalls.length).toBeLessThan(10);
    expect(fakeRelay.subscribeCalls.length).toBe(totalCalls);
  });

  it("reconnects with backoff after a hard close, using a NEW relay from the factory and a fresh since", async () => {
    vi.useFakeTimers();
    const relays = [fakeRelay, new FakeRelay(fakeRelay.url)];
    let callIndex = 0;
    const relayFactory = vi.fn((): FakeRelay => {
      const next = relays[callIndex] ?? relays[relays.length - 1];
      callIndex++;
      if (!next) throw new Error("test setup error: no fake relay configured");
      return next;
    });

    let nowMs = 1_785_000_000_000;
    const { onStatusChange } = connect({
      relayFactory,
      now: () => nowMs,
      backoffScheduleMs: [5_000],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeRelay.subscribeCalls).toHaveLength(1);
    expect(fakeRelay.subscribeCalls[0]?.filters[0]?.since).toBe(Math.floor(nowMs / 1000));

    nowMs += 60_000; // time passes before the connection dies
    fakeRelay.hardClose();
    expect(onStatusChange).toHaveBeenCalledWith("reconnecting");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(relayFactory).toHaveBeenCalledTimes(2);
    const secondRelay = relays[1];
    expect(secondRelay).toBeDefined();
    if (!secondRelay) return;
    expect(secondRelay.subscribeCalls).toHaveLength(1);
    expect(secondRelay.subscribeCalls[0]?.filters[0]?.since).toBe(Math.floor(nowMs / 1000));
    expect(secondRelay.subscribeCalls[0]?.filters[0]?.since).toBeGreaterThan(
      fakeRelay.subscribeCalls[0]?.filters[0]?.since as number,
    );
    expect(onStatusChange).toHaveBeenCalledWith("connected");
  });

  it("stops reconnecting once close() is called", async () => {
    vi.useFakeTimers();
    const relayFactory = vi.fn(() => fakeRelay);
    const { handle } = connect({ relayFactory, backoffScheduleMs: [5_000] });
    await vi.advanceTimersByTimeAsync(0);

    handle.close();
    fakeRelay.hardClose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(relayFactory).toHaveBeenCalledTimes(1);
  });

  // The board showed "auth-required: not authenticated" against a relay that
  // was demonstrably healthy and decoding frames, because a NOTICE from the
  // pre-AUTH subscription attempt stuck forever with nothing to clear it.
  // EOSE is the relay's own "this subscription is live" signal, and it fires
  // again after every auth-retry resubscribe.
  it("reports onSubscribed when the relay sends EOSE", async () => {
    const { onSubscribed } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));
    expect(onSubscribed).not.toHaveBeenCalled();

    fakeRelay.emitEose();

    expect(onSubscribed).toHaveBeenCalledTimes(1);
  });

  it("reports onSubscribed again after an auth-retry resubscribe", async () => {
    const { onSubscribed } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));
    fakeRelay.emitEose();
    expect(onSubscribed).toHaveBeenCalledTimes(1);

    fakeRelay.emitSubscriptionClosed("auth-required: not authenticated");
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(2));

    fakeRelay.emitEose();

    expect(onSubscribed).toHaveBeenCalledTimes(2);
  });
});

describe("isRateLimitNotice", () => {
  it("matches the relay's actual rate-limit OK/NOTICE wording", () => {
    expect(isRateLimitNotice("rate-limited: observer frame rate exceeded (100/sec per agent)")).toBe(
      true,
    );
  });

  it("is case-insensitive", () => {
    expect(isRateLimitNotice("RATE-LIMITED: slow down")).toBe(true);
  });

  it("does not match unrelated notices", () => {
    expect(isRateLimitNotice("restricted: observer frame is not authorized for this agent owner")).toBe(
      false,
    );
  });
});
