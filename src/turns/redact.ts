/**
 * Secret redaction for opaque observer-frame payloads.
 *
 * kind-24200 payloads are pass-through by contract — the classifier reads only
 * `source`/`outcome` and treats the rest as opaque JSON. "Opaque" cannot mean
 * "stored verbatim", because buzz-acp's `acp_write` frames carry the ACP
 * `session/new` request, whose `mcpServers[].env` block contains the agent's
 * own `BUZZ_PRIVATE_KEY` as a plaintext nsec (observed live, 2026-07-26).
 * The frame is NIP-44 encrypted to the owner, so the relay never sees it — but
 * once decrypted it would otherwise flow straight into the ring buffer,
 * `/turns-state.json`, the board UI, and any capture file taken from them.
 *
 * This runs at the decrypt boundary (see `decrypt.ts`) so no downstream
 * consumer can hold key material. It is deliberately conservative: it redacts
 * by field NAME and by unambiguous secret FORMAT, never by "looks like hex",
 * because pubkeys, event ids and turn ids are hex too and are public.
 */

/** Replacement written in place of any redacted value. */
export const REDACTED = "[REDACTED]";

/**
 * Field names whose values are secrets. Matched case-insensitively as a
 * substring, so `BUZZ_PRIVATE_KEY`, `privateKey` and `client_secret` all hit.
 * `key` alone is deliberately NOT here — it collides with public fields like
 * `pubkey`, `conversationKey` and plain `key` map entries.
 */
const SECRET_NAME_PATTERN =
  /(private[_-]?key|secret|password|passwd|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|\btoken\b|credential|nsec)/i;

/**
 * Bech32 nsec (NIP-19 private key). Unambiguously secret wherever it appears,
 * including under an innocuous field name or bare inside an argv array.
 * `npub`/`note`/`nprofile` share the bech32 shape but are public, so the
 * prefix is anchored.
 */
const NSEC_PATTERN = /\bnsec1[02-9ac-hj-np-z]{20,}\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

function redactString(value: string): string {
  return NSEC_PATTERN.test(value) ? REDACTED : value;
}

/**
 * `{ name, value }` pairs are how ACP passes environment variables, so the
 * secret indicator sits in a sibling field rather than in the key. Detect that
 * shape explicitly: a record whose `name` is a string matching a secret name
 * and which carries a `value`.
 */
function isSecretNameValuePair(record: Record<string, unknown>): boolean {
  return typeof record.name === "string" && "value" in record && isSecretName(record.name);
}

/**
 * Deep-copy `value`, replacing secret-bearing leaves with {@link REDACTED}.
 * Structure, arrays, and non-string leaves are preserved exactly; the input is
 * never mutated. Safe on elided payload stubs and on `{}`.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  const pairIsSecret = isSecretNameValuePair(value);
  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (pairIsSecret && key === "value") {
      result[key] = REDACTED;
      continue;
    }
    if (isSecretName(key)) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = redactSecrets(entry);
  }

  return result;
}
