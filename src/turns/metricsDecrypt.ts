import { nip44 } from "nostr-tools";
import { redactSecrets } from "./redact";
import { foldStopReason, ZERO_TOKEN_COUNTS } from "../cost/types";
import type { TokenCounts, TurnMetricRecord } from "../cost/types";

/**
 * NIP-44 v2 decrypt + parse one kind-44200 (NIP-AM) event into a
 * {@link TurnMetricRecord}. Mirrors `decrypt.ts`'s conventions exactly
 * (same length-envelope pre-check, same required/optional field philosophy,
 * same redaction boundary) — deliberately a SEPARATE parser rather than a
 * branch inside `decryptObserverFrame`, because the two envelopes differ:
 * 44200 has no `frame` tag and no `seq`/`kind`/`payload` wrapper — the
 * decrypted JSON IS the payload, with its own required fields (`harness`,
 * `timestamp`) per NIP-AM.
 */

// Same NIP-44 v2 ciphertext length envelope as decrypt.ts (buzz-core's
// NIP44_MIN_CONTENT_LEN / NIP44_MAX_CONTENT_LEN) — this is a property of
// NIP-44 itself, not of NIP-AO specifically, so it applies unchanged here.
const NIP44_MIN_CONTENT_LEN = 132;
const NIP44_MAX_CONTENT_LEN = 87_472;

export interface DecryptTurnMetricInput {
  /** The kind-44200 event's own `id` — carried through as
   * {@link TurnMetricRecord.eventId}, the SQLite dedup key (see
   * `src/cost/store.ts`). */
  eventId: string;
  /** The wire event's `content` field — NIP-44 v2 ciphertext. */
  content: string;
  /** The wire event's `pubkey` (== the `agent` tag; the publishing agent). */
  senderPubkeyHex: string;
  /** The wire event's `created_at`, unix seconds — used only as a fallback
   * for `timestampMs` when the payload's own `timestamp` fails to parse. */
  createdAt: number;
  /** This client's own secret key — the recipient side of the ECDH. */
  recipientSecretKey: Uint8Array;
}

function contentLooksLikeNip44(content: string): boolean {
  return content.length >= NIP44_MIN_CONTENT_LEN && content.length <= NIP44_MAX_CONTENT_LEN;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Error(`turn metric: missing or non-string required field "${field}"`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function optionalNumber(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === "number" ? value : null;
}

function optionalBoolean(record: Record<string, unknown>, field: string): boolean {
  return record[field] === true;
}

/** Parse a `turn`/`cumulative` bucket. Absent or non-object stays
 * {@link ZERO_TOKEN_COUNTS} (a real all-null bucket, never zeros) — NIP-AM
 * allows either object to be omitted entirely. */
function parseTokenCounts(value: unknown): TokenCounts {
  if (!isRecord(value)) {
    return ZERO_TOKEN_COUNTS;
  }
  return {
    inputTokens: optionalNumber(value, "inputTokens"),
    outputTokens: optionalNumber(value, "outputTokens"),
    totalTokens: optionalNumber(value, "totalTokens"),
    costUsd: optionalNumber(value, "costUsd"),
  };
}

/** Parse `timestamp` (RFC 3339, REQUIRED) into ms epoch. Falls back to the
 * envelope's `created_at` (seconds) when the string is present but doesn't
 * parse as a real date — a malformed timestamp shouldn't discard an
 * otherwise-valid cost record, unlike a genuinely MISSING timestamp, which
 * is a hard parse failure (see `requireString` above). */
function parseTimestampMs(payloadTimestamp: string, createdAtSec: number): number {
  const parsed = Date.parse(payloadTimestamp);
  return Number.isNaN(parsed) ? createdAtSec * 1000 : parsed;
}

/**
 * NIP-44 v2 decrypt one kind-44200 event's `content` and parse it into a
 * {@link TurnMetricRecord}. Throws on any failure — bad ciphertext, wrong
 * recipient, malformed JSON, a missing required field (`harness`,
 * `timestamp`), or `cumulative` present without its NIP-AM-required
 * `sessionId`/`turnSeq` companions. Every other field defaults per NIP-AM's
 * "OPTIONAL or nullable" contract. `stopReason` is folded via
 * {@link foldStopReason} — never a parse failure on its own.
 *
 * Uses nostr-tools' `nip44` module exclusively — never a hand-rolled cipher.
 */
export function decryptTurnMetric(input: DecryptTurnMetricInput): TurnMetricRecord {
  if (!contentLooksLikeNip44(input.content)) {
    throw new Error(
      `turn metric: content does not look like NIP-44 v2 ciphertext (length ${input.content.length}, expected ${NIP44_MIN_CONTENT_LEN}-${NIP44_MAX_CONTENT_LEN})`,
    );
  }

  const conversationKey = nip44.getConversationKey(
    input.recipientSecretKey,
    input.senderPubkeyHex,
  );
  const plaintext = nip44.v2.decrypt(input.content, conversationKey);

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (cause) {
    throw new Error("turn metric: decrypted payload is not valid JSON", { cause });
  }

  if (!isRecord(parsed)) {
    throw new Error("turn metric: decrypted payload must be a JSON object");
  }

  // Redact defensively before reading any field — see module doc. NIP-AM
  // defines no secret-bearing field, but this parser never assumes that
  // holds for every harness that will ever publish this kind.
  const redacted = redactSecrets(parsed) as Record<string, unknown>;

  const harness = requireString(redacted, "harness");
  const timestamp = requireString(redacted, "timestamp");

  const hasCumulative = isRecord(redacted.cumulative);
  const sessionId = optionalString(redacted, "sessionId");
  const turnSeq = optionalNumber(redacted, "turnSeq");
  if (hasCumulative && sessionId === null) {
    throw new Error(
      'turn metric: "cumulative" is present but "sessionId" is missing (NIP-AM requires both together)',
    );
  }
  if (hasCumulative && turnSeq === null) {
    throw new Error(
      'turn metric: "cumulative" is present but "turnSeq" is missing (NIP-AM requires both together)',
    );
  }

  return {
    eventId: input.eventId,
    agentPubkey: input.senderPubkeyHex,
    harness,
    model: optionalString(redacted, "model"),
    channelId: optionalString(redacted, "channelId"),
    sessionId,
    turnId: optionalString(redacted, "turnId"),
    turnSeq,
    timestampMs: parseTimestampMs(timestamp, input.createdAt),
    turn: parseTokenCounts(redacted.turn),
    cumulative: parseTokenCounts(redacted.cumulative),
    deltaReliable: optionalBoolean(redacted, "deltaReliable"),
    stopReason: foldStopReason(redacted.stopReason),
  };
}

/**
 * Same as {@link decryptTurnMetric} but never throws — returns `null` on any
 * failure. This is what the WS ingestion loop calls: one malformed or
 * mis-encrypted metric event must not take the whole subscription down,
 * mirroring `decrypt.ts`'s `safeDecryptObserverFrame`.
 */
export function safeDecryptTurnMetric(input: DecryptTurnMetricInput): TurnMetricRecord | null {
  try {
    return decryptTurnMetric(input);
  } catch {
    return null;
  }
}
