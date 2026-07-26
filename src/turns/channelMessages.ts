import type { Event as NostrEvent } from "nostr-tools";
import { readTag } from "./wsClient";
import type { ChannelMessageRecord } from "./swallowed";

/**
 * Pure parsing for kind 9 (channel chat message) events — the corroboration
 * feed `swallowed.ts` needs. Unlike kind 24200/44200, these are plain
 * unencrypted Nostr events: `content` is the message text, and the channel
 * is named by an `h` tag (no NIP-44 decrypt, no owner key involved at all).
 * Shape confirmed against a real capture — see `channelMessagesClient.ts`
 * module doc and `docs/teardown2-claims-map.md` row (d).
 */

/** Parse one kind-9 event into a {@link ChannelMessageRecord}. Returns
 * `null` for a non-kind-9 event or one missing its `h` (channel) tag — both
 * silently skipped by the ingestion loop, same "drop the bad one, keep the
 * batch" discipline as `decrypt.ts`/`metricsDecrypt.ts`. Does not verify the
 * signature itself — that happens once at the transport boundary in
 * `channelMessagesClient.ts`, same split as `wsClient.ts`/`decrypt.ts`. */
export function parseChannelMessageEvent(event: NostrEvent): ChannelMessageRecord | null {
  if (event.kind !== 9) {
    return null;
  }
  const channelId = readTag(event, "h");
  if (!channelId) {
    return null;
  }
  return {
    pubkey: event.pubkey,
    channelId,
    createdAt: event.created_at * 1000,
  };
}
