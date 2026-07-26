import { Relay, finalizeEvent, verifyEvent } from "nostr-tools";
import type { Event as NostrEvent, EventTemplate, Filter, VerifiedEvent } from "nostr-tools";
import { safeDecryptObserverFrame } from "./decrypt";
import type { ObserverEvent } from "./types";

/** Kind 24200's ephemeral range means relays never persist it — every
 * (re)subscription MUST use a fresh `since`, never a value from the past
 * (see NIP-AO: "Clients SHOULD subscribe with since=<now>; historical replay
 * is not supported" and "MUST NOT request historical kind 24200 events"). */
const KIND_AGENT_OBSERVER_FRAME = 24200;

/** Mirrors nostr-tools' own AbstractRelay default `resubscribeBackoff` —
 * reused here for consistency even though this module drives its own
 * reconnect loop (rather than the library's built-in one) so every
 * reconnect can compute a genuinely fresh `since`. */
const DEFAULT_BACKOFF_MS = [10_000, 10_000, 10_000, 20_000, 20_000, 30_000, 60_000];

/** A relay that requires NIP-42 auth often closes the very first REQ (sent
 * before AUTH has round-tripped) with `CLOSED <sub> "auth-required: ..."`.
 * `AbstractRelay`'s own `onauth` handling answers the challenge
 * automatically, but nothing resubscribes afterward — that's this client's
 * job. A short, bounded retry (not a full reconnect: the WS connection
 * itself is fine, only this one REQ was rejected) covers the common case
 * without spinning forever if auth genuinely never succeeds. */
const AUTH_RETRY_DELAY_MS = 750;
const AUTH_RETRY_LIMIT = 5;

function isAuthRequiredClose(reason: string): boolean {
  return /auth-required/i.test(reason);
}

/**
 * buzz-relay's NIP-42 verification computes its expected `relay` tag as a
 * bare `scheme://host[:port]` — no path, ever (`nip42_expected_relay_url`
 * in buzz-relay/src/api/bridge.rs, built from `TenantContext::host()`,
 * which explicitly rejects any scheme/path/userinfo component). nostr-tools'
 * own URL normalization (`normalizeURL`) always appends a trailing "/" to a
 * root-path URL — the WHATWG URL spec won't let a special-scheme URL's
 * pathname go below "/". The two disagree byte-for-byte on the most common
 * case (a relay served at its bare origin, e.g. `ws://localhost:3000`), and
 * buzz-relay's `AuthState::Failed` never re-verifies once set — so an
 * uncorrected client fails NIP-42 auth permanently for that connection.
 * Verified against a live `sha-25e7864` relay: every REQ closed with
 * `"auth-required: not authenticated"` regardless of retries, until this
 * correction was added.
 *
 * This corrects the one string field the mismatch affects — signing itself
 * is still 100% `finalizeEvent` (nostr-tools), never hand-rolled.
 */
function canonicalRelayTag(relayUrl: string): string {
  const parsed = new URL(relayUrl);
  return `${parsed.protocol}//${parsed.host}`;
}

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "closed";

export interface WireObserverFrame {
  /** The `agent` tag pubkey this frame belongs to (the subject agent — for
   * telemetry frames this equals the signing `pubkey`; kept as a separate
   * field since callers key ring buffers/classification off it). */
  agentPubkey: string;
  event: ObserverEvent;
}

/** Minimal surface this module needs from a relay connection — deliberately
 * narrower than nostr-tools' full `AbstractRelay` so tests can swap in a
 * fully in-memory fake with no real sockets involved. */
export interface Subscription {
  close(): void;
}

export interface RelayLike {
  readonly url: string;
  readonly connected: boolean;
  onclose: (() => void) | null;
  onnotice: (msg: string) => void;
  onauth: undefined | ((evt: EventTemplate) => Promise<VerifiedEvent>);
  connect(): Promise<void>;
  subscribe(
    filters: Filter[],
    params: {
      onevent?: (evt: NostrEvent) => void;
      onclose?: (reason: string) => void;
    },
  ): Subscription;
  close(): void;
}

/** Wraps a real nostr-tools `Relay` — `enableReconnect: false` because this
 * module drives reconnection itself (see module doc). */
function defaultRelayFactory(url: string): RelayLike {
  return new Relay(url, { enableReconnect: false });
}

/** True if a NOTICE/OK-false message is the relay's own observer-frame rate
 * limiter talking (matches buzz-relay's actual wording, e.g.
 * `"rate-limited: observer frame rate exceeded (100/sec per agent)"`, but
 * matched loosely since this is informational, not something to key
 * behavior off precisely). Frames the agent-side rate limiter silently
 * drops never reach this client at all — see classify.ts's guardrail doc —
 * so this is purely a connection-health signal for callers to surface, and
 * MUST NOT be treated as itself meaningful telemetry. */
export function isRateLimitNotice(message: string): boolean {
  return /rate.?limit/i.test(message);
}

export interface TurnsConnectionOptions {
  relayUrl: string;
  /** This board's owner secret key for the relay — used both for the
   * NIP-42 AUTH challenge response and the NIP-44 decrypt of every incoming
   * telemetry frame. */
  ownerSecretKey: Uint8Array;
  ownerPubkey: string;
  onFrame: (frame: WireObserverFrame) => void;
  onNotice?: (message: string) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  /** When given, telemetry from an `agent` tag outside this set is dropped
   * before decryption — the NIP's "verify the agent tag matches a
   * known/trusted agent pubkey" recommendation. Omit to accept any agent
   * this owner key can decrypt for (still authorization-gated by the relay
   * itself via `is_agent_owner`). */
  trustedAgentPubkeys?: Set<string>;
  /** ms epoch "now" — injected for testability; every (re)subscribe reads
   * this fresh, never caching a value across reconnects. */
  now?: () => number;
  backoffScheduleMs?: number[];
  /** Injection seam for tests — defaults to a real nostr-tools `Relay`. */
  relayFactory?: (url: string) => RelayLike;
}

function readTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function handleWireEvent(event: NostrEvent, options: TurnsConnectionOptions): void {
  if (!verifyEvent(event)) {
    return; // bad signature — drop silently, never crash the ingestion loop
  }

  const frameTag = readTag(event, "frame");
  if (frameTag !== "telemetry") {
    // Control frames (owner→agent) and any unrecognized frame value are not
    // this board's concern — "Clients MUST ignore events with unrecognized
    // frame values" (NIP-AO), and telemetry is the only direction a
    // read-only observer board ever consumes.
    return;
  }

  const pTag = readTag(event, "p");
  if (pTag !== options.ownerPubkey) {
    return; // defense in depth — the subscription filter should already guarantee this
  }

  const agentTag = readTag(event, "agent");
  if (!agentTag) {
    return;
  }
  if (options.trustedAgentPubkeys && !options.trustedAgentPubkeys.has(agentTag)) {
    return;
  }

  const decoded = safeDecryptObserverFrame({
    content: event.content,
    senderPubkeyHex: event.pubkey,
    recipientSecretKey: options.ownerSecretKey,
  });
  if (!decoded) {
    return;
  }

  options.onFrame({ agentPubkey: agentTag, event: decoded });
}

/**
 * Open (and keep open) a NIP-42-authed WS subscription to one relay's kind
 * 24200 stream for one owner, decrypting and decoding every telemetry frame
 * via nostr-tools (never a hand-rolled cipher). Reconnects with backoff on
 * any hard close, always resubscribing with a fresh `since` — kind 24200 is
 * unreplayable, so a stale `since` would be both pointless and a violation
 * of the NIP's "never request history" rule.
 *
 * Returns a handle whose `close()` stops reconnecting and tears the
 * connection down for good.
 */
export function connectTurnsStream(options: TurnsConnectionOptions): { close(): void } {
  const now = options.now ?? Date.now;
  const backoffSchedule = options.backoffScheduleMs ?? DEFAULT_BACKOFF_MS;
  const relayFactory = options.relayFactory ?? defaultRelayFactory;

  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let authRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let relay: RelayLike | null = null;

  function subscribeFresh(r: RelayLike, authRetriesLeft = AUTH_RETRY_LIMIT): void {
    const sinceSec = Math.floor(now() / 1000);
    const filter: Filter = {
      kinds: [KIND_AGENT_OBSERVER_FRAME],
      "#p": [options.ownerPubkey],
      since: sinceSec,
    };
    r.subscribe([filter], {
      onevent: (event) => handleWireEvent(event, options),
      onclose: (reason) => {
        options.onNotice?.(`turns subscription closed: ${reason}`);
        if (closed || relay !== r) {
          return; // superseded by a hard reconnect or an external close()
        }
        if (isAuthRequiredClose(reason) && authRetriesLeft > 0) {
          authRetryTimer = setTimeout(() => {
            authRetryTimer = null;
            subscribeFresh(r, authRetriesLeft - 1);
          }, AUTH_RETRY_DELAY_MS);
        }
      },
    });
  }

  function scheduleReconnect(): void {
    if (closed) {
      return;
    }
    options.onStatusChange?.("reconnecting");
    const delay = backoffSchedule[Math.min(attempt, backoffSchedule.length - 1)] ?? 60_000;
    attempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectOnce();
    }, delay);
  }

  function connectOnce(): void {
    if (closed) {
      return;
    }
    const r = relayFactory(options.relayUrl);
    relay = r;
    r.onauth = async (template) => {
      const tags = template.tags.map((tag) =>
        tag[0] === "relay" ? ["relay", canonicalRelayTag(options.relayUrl)] : tag,
      );
      return finalizeEvent({ ...template, tags }, options.ownerSecretKey);
    };
    r.onnotice = (msg) => options.onNotice?.(msg);
    r.onclose = () => {
      if (closed) {
        return;
      }
      scheduleReconnect();
    };

    r.connect()
      .then(() => {
        if (closed) {
          return;
        }
        attempt = 0;
        options.onStatusChange?.("connected");
        subscribeFresh(r);
      })
      .catch(() => {
        if (!closed) {
          scheduleReconnect();
        }
      });
  }

  connectOnce();

  return {
    close(): void {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (authRetryTimer) {
        clearTimeout(authRetryTimer);
        authRetryTimer = null;
      }
      relay?.close();
      options.onStatusChange?.("closed");
    },
  };
}
