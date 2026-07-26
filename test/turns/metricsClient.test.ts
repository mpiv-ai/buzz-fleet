/** @vitest-environment node */
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, verifyEvent } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event as NostrEvent, EventTemplate, Filter, VerifiedEvent } from "nostr-tools";
import { connectMetricsStream } from "../../src/turns/metricsClient";
import type { RelayLike, Subscription } from "../../src/turns/wsClient";
import type { TurnMetricRecord } from "../../src/cost/types";

// Same fully in-memory FakeRelay pattern as wsClient.test.ts — no real
// sockets. connectMetricsStream is built on the SAME RelayLike contract, so
// this fake is interchangeable between both test files.
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

  emitEvent(event: NostrEvent): void {
    this.activeSub?.params.onevent?.(event);
  }

  emitNotice(message: string): void {
    this.onnotice(message);
  }

  emitEose(): void {
    this.activeSub?.params.oneose?.();
  }

  emitSubscriptionClosed(reason: string): void {
    this.activeSub?.params.onclose?.(reason);
  }

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

function buildMetricEvent(opts: {
  agentSecretKey: Uint8Array;
  ownerPubkey: string;
  plaintext: string;
  agentTagOverride?: string;
}): NostrEvent {
  const agentPubkey = getPublicKey(opts.agentSecretKey);
  const conversationKey = nip44.getConversationKey(opts.agentSecretKey, opts.ownerPubkey);
  const content = nip44.v2.encrypt(opts.plaintext, conversationKey);
  return finalizeEvent(
    {
      kind: 44200,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["p", opts.ownerPubkey],
        ["agent", opts.agentTagOverride ?? agentPubkey],
        // Deliberately NO "frame" tag — NIP-AM defines none (unlike NIP-AO's
        // 24200 telemetry envelope). This is the case that would silently
        // break if this client reused wsClient's frame-gated handler as-is.
      ],
      content,
    },
    opts.agentSecretKey,
  );
}

const METRIC_PLAINTEXT = JSON.stringify({
  harness: "goose",
  model: "claude-sonnet-4-5",
  timestamp: "2026-07-01T20:11:03.213Z",
  turn: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.01 },
  stopReason: "end_turn",
});

describe("connectMetricsStream", () => {
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

  function connect(overrides: Partial<Parameters<typeof connectMetricsStream>[0]> = {}) {
    const onRecord = vi.fn();
    const onNotice = vi.fn();
    const onStatusChange = vi.fn();
    const onSubscribed = vi.fn();
    const handle = connectMetricsStream({
      relayUrl: fakeRelay.url,
      ownerSecretKey,
      ownerPubkey,
      onRecord,
      onNotice,
      onStatusChange,
      onSubscribed,
      relayFactory: () => fakeRelay,
      ...overrides,
    });
    return { handle, onRecord, onNotice, onStatusChange, onSubscribed };
  }

  it("subscribes with kinds=[44200] and #p=[ownerPubkey]", async () => {
    connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    const filter = fakeRelay.subscribeCalls[0]?.filters[0];
    expect(filter?.kinds).toEqual([44200]);
    expect(filter?.["#p"]).toEqual([ownerPubkey]);
  });

  it("uses a since in the PAST (now - lookbackMs) — unlike kind 24200, historical is allowed and wanted", async () => {
    const fixedNow = 1_785_000_000_000;
    connect({ now: () => fixedNow, lookbackMs: 30 * 24 * 60 * 60 * 1000 });
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    const filter = fakeRelay.subscribeCalls[0]?.filters[0];
    const expectedSince = Math.floor((fixedNow - 30 * 24 * 60 * 60 * 1000) / 1000);
    expect(filter?.since).toBe(expectedSince);
    expect(filter?.since).toBeLessThan(Math.floor(fixedNow / 1000));
  });

  it("answers a NIP-42 AUTH challenge with a validly-signed event, same as the turns stream", async () => {
    connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    await fakeRelay.emitAuthChallenge("challenge-abc");

    expect(fakeRelay.authAttempts).toHaveLength(1);
    const authEvent = fakeRelay.authAttempts[0];
    expect(authEvent).toBeDefined();
    if (!authEvent) return;
    expect(authEvent.pubkey).toBe(ownerPubkey);
    expect(verifyEvent(authEvent)).toBe(true);
    expect(authEvent.tags).toContainEqual(["challenge", "challenge-abc"]);
  });

  it("decodes a valid metric event with NO frame tag and calls onRecord", async () => {
    const agentSecretKey = generateSecretKey();
    const agentPubkey = getPublicKey(agentSecretKey);
    const { onRecord } = connect({ trustedAgentPubkeys: new Set([agentPubkey]) });
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    fakeRelay.emitEvent(
      buildMetricEvent({ agentSecretKey, ownerPubkey, plaintext: METRIC_PLAINTEXT }),
    );

    expect(onRecord).toHaveBeenCalledTimes(1);
    const record = onRecord.mock.calls[0]?.[0] as TurnMetricRecord;
    expect(record.agentPubkey).toBe(agentPubkey);
    expect(record.harness).toBe("goose");
    expect(record.turn.totalTokens).toBe(150);
  });

  it("drops a metric event from an agent pubkey not in the trusted set", async () => {
    const agentSecretKey = generateSecretKey();
    const untrustedPubkey = getPublicKey(generateSecretKey());
    const { onRecord } = connect({ trustedAgentPubkeys: new Set([untrustedPubkey]) });
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    fakeRelay.emitEvent(
      buildMetricEvent({ agentSecretKey, ownerPubkey, plaintext: METRIC_PLAINTEXT }),
    );

    expect(onRecord).not.toHaveBeenCalled();
  });

  it("does not drop a metric event when no trusted-set allowlist was configured", async () => {
    const agentSecretKey = generateSecretKey();
    const { onRecord } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    fakeRelay.emitEvent(
      buildMetricEvent({ agentSecretKey, ownerPubkey, plaintext: METRIC_PLAINTEXT }),
    );

    expect(onRecord).toHaveBeenCalledTimes(1);
  });

  it("drops an event with a bad signature without calling onRecord or throwing", async () => {
    const agentSecretKey = generateSecretKey();
    const { onRecord } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    const tampered = buildMetricEvent({ agentSecretKey, ownerPubkey, plaintext: METRIC_PLAINTEXT });
    tampered.content = tampered.content.slice(0, -4) + "abcd";

    expect(() => fakeRelay.emitEvent(tampered)).not.toThrow();
    expect(onRecord).not.toHaveBeenCalled();
  });

  it("drops an event that fails to decrypt (wrong key) without calling onRecord or throwing", async () => {
    const agentSecretKey = generateSecretKey();
    const someoneElse = generateSecretKey();
    const { onRecord } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    const wrongRecipientEvent = buildMetricEvent({
      agentSecretKey,
      ownerPubkey: getPublicKey(someoneElse),
      plaintext: METRIC_PLAINTEXT,
    });

    expect(() => fakeRelay.emitEvent(wrongRecipientEvent)).not.toThrow();
    expect(onRecord).not.toHaveBeenCalled();
  });

  it("forwards NOTICE messages via onNotice without crashing the connection", async () => {
    const { onNotice } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    fakeRelay.emitNotice("rate-limited: slow down");

    expect(onNotice).toHaveBeenCalledWith("rate-limited: slow down");
  });

  it("retries the subscription after an auth-required CLOSED, and delivers records once the retry succeeds", async () => {
    vi.useFakeTimers();
    const agentSecretKey = generateSecretKey();
    const agentPubkey = getPublicKey(agentSecretKey);
    const { onRecord } = connect({ trustedAgentPubkeys: new Set([agentPubkey]) });
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeRelay.subscribeCalls).toHaveLength(1);

    fakeRelay.emitSubscriptionClosed("auth-required: we need you to authenticate");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fakeRelay.subscribeCalls).toHaveLength(2);

    fakeRelay.emitEvent(
      buildMetricEvent({ agentSecretKey, ownerPubkey, plaintext: METRIC_PLAINTEXT }),
    );
    expect(onRecord).toHaveBeenCalledTimes(1);
  });

  it("reconnects with backoff after a hard close, using a NEW relay from the factory", async () => {
    vi.useFakeTimers();
    const relays = [fakeRelay, new FakeRelay(fakeRelay.url)];
    let callIndex = 0;
    const relayFactory = vi.fn((): FakeRelay => {
      const next = relays[callIndex] ?? relays[relays.length - 1];
      callIndex++;
      if (!next) throw new Error("test setup error: no fake relay configured");
      return next;
    });

    const { onStatusChange } = connect({ relayFactory, backoffScheduleMs: [5_000] });
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeRelay.subscribeCalls).toHaveLength(1);

    fakeRelay.hardClose();
    expect(onStatusChange).toHaveBeenCalledWith("reconnecting");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(relayFactory).toHaveBeenCalledTimes(2);
    const secondRelay = relays[1];
    expect(secondRelay).toBeDefined();
    if (!secondRelay) return;
    expect(secondRelay.subscribeCalls).toHaveLength(1);
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

  it("reports onSubscribed when the relay sends EOSE, and again after an auth-retry resubscribe", async () => {
    const { onSubscribed } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));
    expect(onSubscribed).not.toHaveBeenCalled();

    fakeRelay.emitEose();
    expect(onSubscribed).toHaveBeenCalledTimes(1);

    fakeRelay.emitSubscriptionClosed("auth-required: not authenticated");
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(2));
    fakeRelay.emitEose();

    expect(onSubscribed).toHaveBeenCalledTimes(2);
  });
});
