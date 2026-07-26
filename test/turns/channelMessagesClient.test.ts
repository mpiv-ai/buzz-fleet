/** @vitest-environment node */
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event as NostrEvent, EventTemplate, Filter, VerifiedEvent } from "nostr-tools";
import { connectChannelMessagesStream } from "../../src/turns/channelMessagesClient";
import type { RelayLike, Subscription } from "../../src/turns/wsClient";

// Same fully in-memory FakeRelay pattern as wsClient.test.ts/metricsClient.test.ts.
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

function buildChannelEvent(opts: { secretKey: Uint8Array; channelId?: string; content?: string }): NostrEvent {
  return finalizeEvent(
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      tags: opts.channelId === undefined ? [] : [["h", opts.channelId]],
      content: opts.content ?? "hi",
    },
    opts.secretKey,
  );
}

describe("connectChannelMessagesStream", () => {
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

  function connect(overrides: Partial<Parameters<typeof connectChannelMessagesStream>[0]> = {}) {
    const onMessage = vi.fn();
    const onNotice = vi.fn();
    const onStatusChange = vi.fn();
    const onSubscribed = vi.fn();
    const handle = connectChannelMessagesStream({
      relayUrl: fakeRelay.url,
      ownerSecretKey,
      ownerPubkey,
      onMessage,
      onNotice,
      onStatusChange,
      onSubscribed,
      relayFactory: () => fakeRelay,
      ...overrides,
    });
    return { handle, onMessage, onNotice, onStatusChange, onSubscribed };
  }

  it("subscribes with kinds=[9] and a since reaching into the past", async () => {
    const fixedNow = 1_785_000_000_000;
    connect({ now: () => fixedNow, lookbackMs: 60_000 });
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    const filter = fakeRelay.subscribeCalls[0]?.filters[0];
    expect(filter?.kinds).toEqual([9]);
    expect(filter?.since).toBe(Math.floor((fixedNow - 60_000) / 1000));
  });

  it("answers a NIP-42 AUTH challenge if the relay demands one", async () => {
    connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    await fakeRelay.emitAuthChallenge("challenge-xyz");

    expect(fakeRelay.authAttempts).toHaveLength(1);
    const authEvent = fakeRelay.authAttempts[0];
    expect(authEvent).toBeDefined();
    if (!authEvent) return;
    expect(authEvent.pubkey).toBe(ownerPubkey);
    expect(verifyEvent(authEvent)).toBe(true);
  });

  it("decodes a valid channel message and calls onMessage", async () => {
    const authorKey = generateSecretKey();
    const { onMessage } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    fakeRelay.emitEvent(buildChannelEvent({ secretKey: authorKey, channelId: "chan-1" }));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({
      pubkey: getPublicKey(authorKey),
      channelId: "chan-1",
    });
  });

  it("drops an event with a bad signature without calling onMessage or throwing", async () => {
    const authorKey = generateSecretKey();
    const { onMessage } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    const signed = buildChannelEvent({ secretKey: authorKey, channelId: "chan-1" });
    // finalizeEvent caches a "verified" flag (nostr-tools' `verifiedSymbol`)
    // on the object it just signed, as an optimization for the common case
    // of immediately re-verifying your own freshly-signed event. Mutating
    // that same object in place would make `verifyEvent` short-circuit to
    // the STALE cached `true` rather than re-checking — a real wire event
    // never carries that flag (it arrives as freshly-parsed JSON, and
    // symbol-keyed properties never survive JSON serialization), so a
    // JSON round-trip here both strips the cache and matches reality.
    const tampered = JSON.parse(JSON.stringify(signed)) as NostrEvent;
    tampered.content = "tampered content, signature now invalid";

    expect(() => fakeRelay.emitEvent(tampered)).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("drops an event missing the 'h' (channel) tag without calling onMessage or throwing", async () => {
    const authorKey = generateSecretKey();
    const { onMessage } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    expect(() => fakeRelay.emitEvent(buildChannelEvent({ secretKey: authorKey }))).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("forwards NOTICE messages via onNotice", async () => {
    const { onNotice } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));

    fakeRelay.emitNotice("rate-limited: slow down");

    expect(onNotice).toHaveBeenCalledWith("rate-limited: slow down");
  });

  it("retries the subscription after an auth-required CLOSED", async () => {
    vi.useFakeTimers();
    connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeRelay.subscribeCalls).toHaveLength(1);

    fakeRelay.emitSubscriptionClosed("auth-required: we need you to authenticate");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fakeRelay.subscribeCalls).toHaveLength(2);
  });

  it("reconnects with backoff after a hard close", async () => {
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

  it("reports onSubscribed when the relay sends EOSE", async () => {
    const { onSubscribed } = connect();
    await vi.waitFor(() => expect(fakeRelay.subscribeCalls).toHaveLength(1));
    expect(onSubscribed).not.toHaveBeenCalled();

    fakeRelay.emitEose();

    expect(onSubscribed).toHaveBeenCalledTimes(1);
  });
});
