import { finalizeEvent, verifyEvent } from "nostr-tools";
import type { Event as NostrEvent, Filter } from "nostr-tools";
import { parseChannelMessageEvent } from "./channelMessages";
import type { ChannelMessageRecord } from "./swallowed";
import {
  AUTH_RETRY_DELAY_MS,
  AUTH_RETRY_LIMIT,
  DEFAULT_BACKOFF_MS,
  canonicalRelayTag,
  defaultRelayFactory,
  isAuthRequiredClose,
} from "./wsClient";
import type { ConnectionStatus, RelayLike } from "./wsClient";

/**
 * WS ingestion for kind 9 (channel chat message) events — the swallowed-
 * detection corroboration feed. Same NIP-42/reconnect/backoff machinery as
 * `wsClient.ts`/`metricsClient.ts`, reused via the same exported helpers.
 *
 * Unlike telemetry (24200) and turn metrics (44200), channel messages are
 * NOT owner-scoped or encrypted — no `#p` filter, no NIP-44 decrypt, no
 * `trustedAgentPubkeys` allowlist at ingestion time (a message claiming to
 * be from the agent can only carry a valid signature if it really is the
 * agent — `verifyEvent` already guarantees that; `swallowed.ts`'s
 * `computeReplySeenAfterLastChannelTurn` does the actual agent-pubkey match
 * at read time). This connects broadly (`{kinds:[9], since}`, no `#h`
 * filter) since the set of channels worth watching is discovered
 * dynamically from live turn telemetry, not known up front; filtering by
 * channel happens downstream in `swallowed.ts`.
 *
 * Still built on the SAME authed-connection pattern as the other streams —
 * if this relay build happens to gate kind 9 reads behind NIP-42 (some
 * builds require community membership; this rig's does not), the `onauth`
 * handler answers it exactly like the telemetry/metrics streams; if it
 * doesn't, that handler is simply never invoked. Either way this client is
 * correct without needing to know the relay's specific policy in advance.
 */

const KIND_CHANNEL_MESSAGE = 9;

/** Recover this much channel-message history on every (re)subscribe — wide
 * enough to catch a reply to a turn that resolved slightly before this
 * connection was (re)established. Matches `SWALLOWED_CORROBORATION_WINDOW_MS`
 * with generous headroom rather than being pinned to it exactly, since a
 * reconnect can legitimately happen well after a turn resolved. */
export const DEFAULT_CHANNEL_MESSAGES_LOOKBACK_MS = 30 * 60 * 1000;

export interface ChannelMessagesConnectionOptions {
  relayUrl: string;
  /** Used only to answer a NIP-42 AUTH challenge, if this relay issues one
   * for kind-9 reads — see module doc. Channel message content itself is
   * never encrypted, so no key is needed to read it. */
  ownerSecretKey: Uint8Array;
  ownerPubkey: string;
  onMessage: (message: ChannelMessageRecord) => void;
  onNotice?: (message: string) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  onSubscribed?: () => void;
  now?: () => number;
  /** Default {@link DEFAULT_CHANNEL_MESSAGES_LOOKBACK_MS}. */
  lookbackMs?: number;
  backoffScheduleMs?: number[];
  relayFactory?: (url: string) => RelayLike;
}

function handleWireEvent(event: NostrEvent, options: ChannelMessagesConnectionOptions): void {
  if (!verifyEvent(event)) {
    return; // bad signature — drop silently, never crash the ingestion loop
  }
  const record = parseChannelMessageEvent(event);
  if (!record) {
    return;
  }
  options.onMessage(record);
}

/**
 * Open (and keep open) a WS subscription to one relay's kind-9 channel
 * message stream, answering NIP-42 AUTH if challenged. Reconnects with
 * backoff on any hard close; every (re)subscribe recomputes `since` as
 * `now() - lookbackMs`.
 *
 * Returns a handle whose `close()` stops reconnecting and tears the
 * connection down for good.
 */
export function connectChannelMessagesStream(
  options: ChannelMessagesConnectionOptions,
): { close(): void } {
  const now = options.now ?? Date.now;
  const lookbackMs = options.lookbackMs ?? DEFAULT_CHANNEL_MESSAGES_LOOKBACK_MS;
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
      kinds: [KIND_CHANNEL_MESSAGE],
      since: sinceSec,
    };
    r.subscribe([filter], {
      onevent: (event) => handleWireEvent(event, options),
      oneose: () => options.onSubscribed?.(),
      onclose: (reason) => {
        options.onNotice?.(`channel-messages subscription closed: ${reason}`);
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
