import type { BridgePresenceEvent } from "./types";

/** kind:20001 — ephemeral presence update. Requesting kind:40902 (the
 * presence snapshot kind) returns the same synthesized events through the
 * same relay code path, so buzz-fleet always requests 20001 directly. */
const PRESENCE_KIND = 20001;

export interface NostrFilter {
  kinds: number[];
  authors: string[];
}

/** Build the single explicit-authors filter the bridge's `synthesize_presence` intercepts. */
export function buildPresenceFilter(pubkeys: string[]): NostrFilter[] {
  return [{ kinds: [PRESENCE_KIND], authors: pubkeys }];
}

/** Read the subject pubkey from a synthesized event's `["p", <hex>]` tag. */
export function subjectPubkeyOf(event: BridgePresenceEvent): string | null {
  const pTag = event.tags.find((tag) => tag[0] === "p");
  return pTag?.[1] ?? null;
}

function isBridgePresenceEvent(value: unknown): value is BridgePresenceEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.pubkey === "string" &&
    typeof v.kind === "number" &&
    typeof v.created_at === "number" &&
    typeof v.content === "string" &&
    typeof v.sig === "string" &&
    Array.isArray(v.tags)
  );
}

/**
 * Validate a decoded `/query` response body into well-formed presence
 * events. Malformed individual entries are dropped rather than failing the
 * whole batch — one bad event shouldn't take the board down.
 */
export function parseBridgeResponse(json: unknown): BridgePresenceEvent[] {
  if (!Array.isArray(json)) {
    throw new Error("buzz relay /query response: expected a JSON array");
  }
  return json.filter(isBridgePresenceEvent);
}

/**
 * Bulk-read presence for `pubkeys` from one relay in a single HTTP round
 * trip (`POST <relayUrl>/query`), keyed by each event's subject pubkey.
 *
 * `callerPubkey` is the bridge's dev-mode `X-Pubkey` identity — a
 * self-declared, unsigned label, not a credential. See README > "Auth model".
 */
export async function fetchPresence(
  relayUrl: string,
  callerPubkey: string,
  pubkeys: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, BridgePresenceEvent>> {
  const response = await fetchImpl(`${relayUrl}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pubkey": callerPubkey,
    },
    body: JSON.stringify(buildPresenceFilter(pubkeys)),
  });

  if (!response.ok) {
    throw new Error(`buzz relay ${relayUrl}/query: HTTP ${response.status}`);
  }

  const json: unknown = await response.json();
  const events = parseBridgeResponse(json);

  const bySubject = new Map<string, BridgePresenceEvent>();
  for (const event of events) {
    const subject = subjectPubkeyOf(event);
    if (subject) {
      bySubject.set(subject, event);
    }
  }
  return bySubject;
}
