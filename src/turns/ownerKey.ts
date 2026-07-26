import { readFileSync } from "node:fs";
import { nip19 } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";

/**
 * Loads an owner secret key for NIP-44 decrypt + the NIP-42 `#p` filter.
 *
 * Node-only by design — this is the "daemon" side of the v0.2 auth model
 * (see README > "Auth model (v0.2)" and fleet.yaml's `ownerKeyFile`/
 * `ownerKeyEnv` doc comments). It reads a real file or a real environment
 * variable at runtime; nothing upstream of this module (config parsing, the
 * agent authoring this code) ever sees the key's value. Callers must not
 * log, print, or otherwise surface the returned bytes — treat them exactly
 * like the file/env var they came from.
 */

const HEX_KEY_RE = /^[0-9a-f]{64}$/i;

/** Parse a secret key given as either raw 64-char hex or nsec1-bech32.
 * Trims incidental whitespace (files commonly end in a trailing newline). */
export function parseSecretKey(raw: string): Uint8Array {
  const trimmed = raw.trim();

  if (HEX_KEY_RE.test(trimmed)) {
    return hexToBytes(trimmed);
  }

  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") {
      throw new Error(`owner key: expected an nsec1 secret key, got type "${decoded.type}"`);
    }
    return decoded.data;
  }

  throw new Error(
    "owner key: value is neither a 64-character hex secret key nor an nsec1-encoded one",
  );
}

export interface OwnerKeyRef {
  ownerKeyFile?: string;
  ownerKeyEnv?: string;
}

/**
 * Resolve an {@link OwnerKeyRef} (from `fleet.yaml`) to the actual secret
 * key bytes, reading a file path or an environment variable NAME — exactly
 * one of which must be set. Throws with a message naming the file path or
 * env var (never the key value) on any failure.
 */
export function loadOwnerSecretKey(ref: OwnerKeyRef): Uint8Array {
  if (ref.ownerKeyFile !== undefined && ref.ownerKeyEnv !== undefined) {
    throw new Error("owner key: set at most one of ownerKeyFile / ownerKeyEnv, got both");
  }

  if (ref.ownerKeyFile !== undefined) {
    let raw: string;
    try {
      raw = readFileSync(ref.ownerKeyFile, "utf8");
    } catch (cause) {
      throw new Error(`owner key: failed to read ownerKeyFile "${ref.ownerKeyFile}"`, { cause });
    }
    return parseSecretKey(raw);
  }

  if (ref.ownerKeyEnv !== undefined) {
    const raw = process.env[ref.ownerKeyEnv];
    if (raw === undefined || raw.length === 0) {
      throw new Error(`owner key: environment variable "${ref.ownerKeyEnv}" is not set`);
    }
    return parseSecretKey(raw);
  }

  throw new Error("owner key: neither ownerKeyFile nor ownerKeyEnv was given");
}
