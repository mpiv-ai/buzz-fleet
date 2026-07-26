import { nip44 } from "nostr-tools";
import { redactSecrets } from "./redact";
import type { ObserverEvent } from "./types";

// Matches buzz-core/src/observer.rs's own NIP-44 v2 ciphertext length
// envelope (NIP44_MIN_CONTENT_LEN / NIP44_MAX_CONTENT_LEN) — failing fast on
// an obviously-wrong length gives a clearer error than letting nip44.decrypt
// throw its own (correct, but less specific) parse error.
const NIP44_MIN_CONTENT_LEN = 132;
const NIP44_MAX_CONTENT_LEN = 87_472;

export interface DecryptObserverFrameInput {
  /** The wire event's `content` field — NIP-44 v2 ciphertext. */
  content: string;
  /** The wire event's `pubkey` (telemetry: the agent; control: the owner). */
  senderPubkeyHex: string;
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
    throw new Error(`observer frame: missing or non-string required field "${field}"`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number") {
    throw new Error(`observer frame: missing or non-number required field "${field}"`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function optionalInteger(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === "number" ? value : null;
}

/**
 * NIP-44 v2 decrypt one kind-24200 event's `content` and parse it into an
 * {@link ObserverEvent}. Throws on any failure — bad ciphertext, wrong
 * recipient, malformed JSON, or a missing REQUIRED envelope field (`seq`,
 * `timestamp`, `kind`; `payload` is required but may be `{}`).
 * `agentIndex`/`channelId`/`sessionId`/`turnId` are OPTIONAL per the NIP and
 * default to `null`. `payload` is returned opaque apart from secret redaction
 * (see `redact.ts` — buzz-acp ships the agent's own private key inside
 * `acp_write` frames); it may be elided (`{elided,originalBytes}` or inline
 * `…[elided N bytes]…` markers), so callers that need it defensively should
 * read only the specific fields they expect (see `classify.ts`), never assume
 * its full shape.
 *
 * Uses nostr-tools' `nip44` module exclusively — never a hand-rolled cipher.
 */
export function decryptObserverFrame(input: DecryptObserverFrameInput): ObserverEvent {
  if (!contentLooksLikeNip44(input.content)) {
    throw new Error(
      `observer frame: content does not look like NIP-44 v2 ciphertext (length ${input.content.length}, expected ${NIP44_MIN_CONTENT_LEN}-${NIP44_MAX_CONTENT_LEN})`,
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
    throw new Error("observer frame: decrypted payload is not valid JSON", { cause });
  }

  if (!isRecord(parsed)) {
    throw new Error("observer frame: decrypted payload must be a JSON object");
  }

  if (!("payload" in parsed)) {
    throw new Error('observer frame: missing required field "payload"');
  }

  return {
    seq: requireNumber(parsed, "seq"),
    timestamp: requireString(parsed, "timestamp"),
    kind: requireString(parsed, "kind"),
    agentIndex: optionalInteger(parsed, "agentIndex"),
    channelId: optionalString(parsed, "channelId"),
    sessionId: optionalString(parsed, "sessionId"),
    turnId: optionalString(parsed, "turnId"),
    // Opaque, but never verbatim: buzz-acp's acp_write frames embed the
    // agent's own BUZZ_PRIVATE_KEY in the ACP session/new request. Redacting
    // here keeps key material out of the ring buffer, /turns-state.json, the
    // board UI, and any capture taken from them. See `redact.ts`.
    payload: redactSecrets(parsed.payload),
  };
}

/**
 * Same as {@link decryptObserverFrame} but never throws — returns `null` on
 * any failure. This is what the WS ingestion loop calls: one malformed or
 * mis-encrypted frame must not take the whole subscription down, mirroring
 * `presence/bridge.ts`'s `parseBridgeResponse` (drop the bad entry, keep the
 * batch).
 */
export function safeDecryptObserverFrame(
  input: DecryptObserverFrameInput,
): ObserverEvent | null {
  try {
    return decryptObserverFrame(input);
  } catch {
    return null;
  }
}
