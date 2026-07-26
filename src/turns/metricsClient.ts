import { finalizeEvent, verifyEvent } from "nostr-tools";
import type { Event as NostrEvent, Filter } from "nostr-tools";
import { safeDecryptTurnMetric } from "./metricsDecrypt";
import {
  AUTH_RETRY_DELAY_MS,
  AUTH_RETRY_LIMIT,
  DEFAULT_BACKOFF_MS,
  canonicalRelayTag,
  defaultRelayFactory,
  isAuthRequiredClose,
  readTag,
} from "./wsClient";
import type { ConnectionStatus, RelayLike } from "./wsClient";
import type { TurnMetricRecord } from "../cost/types";

/**
 * WS ingestion for kind 44200 (NIP-AM turn metrics) — the cost-panel sibling
 * of `wsClient.ts`'s `connectTurnsStream`. Reuses that module's NIP-42
 * auth/backoff/auth-retry machinery verbatim (same exported constants and
 * helpers: `canonicalRelayTag`, `isAuthRequiredClose`, `defaultRelayFactory`,
 * `readTag`, `DEFAULT_BACKOFF_MS`, `AUTH_RETRY_DELAY_MS`,
 * `AUTH_RETRY_LIMIT`) — that machinery is a property of this relay's NIP-42
 * handling, unrelated to which kind is being subscribed to.
 *
 * Deliberately a SEPARATE connect function rather than a branch inside
 * `connectTurnsStream`, because the subscription semantics differ in ways
 * that would otherwise turn one function into two: 44200 is durable/regular
 * (a past `since` is required to recover history — NIP-AM "Client
 * Behavior" — the opposite of 24200's ephemeral "always since=now" rule),
 * and it carries no `frame` tag to gate on (NIP-AM's tag layout mirrors
 * NIP-AO's `p`/`agent` tags only — see `docs/teardown2-claims-map.md` row
 * (g)).
 */

const KIND_AGENT_TURN_METRIC = 44200;

/** Recover this much history on every (re)subscribe. NIP-AM events are
 * durable, so this is a real, meaningful lookback window, not a
 * reconnect-jitter guard — 30 days comfortably covers a cost dashboard's
 * "this month" view while keeping the initial backfill bounded. */
export const DEFAULT_METRICS_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export interface MetricsConnectionOptions {
  relayUrl: string;
  ownerSecretKey: Uint8Array;
  ownerPubkey: string;
  onRecord: (record: TurnMetricRecord) => void;
  onNotice?: (message: string) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  onSubscribed?: () => void;
  /** When given, metrics from an `agent` tag outside this set are dropped
   * before decryption — same allowlist convention as `connectTurnsStream`. */
  trustedAgentPubkeys?: Set<string>;
  now?: () => number;
  /** How far back `since` reaches on every (re)subscribe. Default
   * {@link DEFAULT_METRICS_LOOKBACK_MS}. */
  lookbackMs?: number;
  backoffScheduleMs?: number[];
  relayFactory?: (url: string) => RelayLike;
}

function handleWireEvent(event: NostrEvent, options: MetricsConnectionOptions): void {
  if (!verifyEvent(event)) {
    return; // bad signature — drop silently, never crash the ingestion loop
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

  const record = safeDecryptTurnMetric({
    eventId: event.id,
    content: event.content,
    senderPubkeyHex: event.pubkey,
    createdAt: event.created_at,
    recipientSecretKey: options.ownerSecretKey,
  });
  if (!record) {
    return;
  }

  options.onRecord(record);
}

/**
 * Open (and keep open) a NIP-42-authed WS subscription to one relay's kind
 * 44200 stream for one owner, decrypting and decoding every turn-metric
 * event via nostr-tools (never a hand-rolled cipher). Reconnects with
 * backoff on any hard close; every (re)subscribe recomputes `since` as
 * `now() - lookbackMs` (fresh relative to the current time, but always
 * reaching into the past — see module doc for why this differs from
 * `connectTurnsStream`'s "always now" rule).
 *
 * Returns a handle whose `close()` stops reconnecting and tears the
 * connection down for good.
 */
export function connectMetricsStream(options: MetricsConnectionOptions): { close(): void } {
  const now = options.now ?? Date.now;
  const lookbackMs = options.lookbackMs ?? DEFAULT_METRICS_LOOKBACK_MS;
  const backoffSchedule = options.backoffScheduleMs ?? DEFAULT_BACKOFF_MS;
  const relayFactory = options.relayFactory ?? defaultRelayFactory;

  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let authRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let relay: RelayLike | null = null;

  function subscribeFresh(r: RelayLike, authRetriesLeft = AUTH_RETRY_LIMIT): void {
    const sinceSec = Math.floor((now() - lookbackMs) / 1000);
    const filter: Filter = {
      kinds: [KIND_AGENT_TURN_METRIC],
      "#p": [options.ownerPubkey],
      since: sinceSec,
    };
    r.subscribe([filter], {
      onevent: (event) => handleWireEvent(event, options),
      oneose: () => options.onSubscribed?.(),
      onclose: (reason) => {
        options.onNotice?.(`metrics subscription closed: ${reason}`);
        if (closed || relay !== r) {
          return;
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
