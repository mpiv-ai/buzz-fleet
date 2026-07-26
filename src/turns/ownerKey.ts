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
const LABELED_LINE_RE = /^([A-Za-z_][A-Za-z0-9_ -]*)\s*[:=]\s*(.+)$/;

/** Try to decode a single candidate token as either raw hex or nsec1-bech32.
 * Returns `null` (never throws) so the multi-line scan in {@link
 * parseSecretKey} can keep looking at the next candidate. */
function tryDecodeCandidate(token: string): Uint8Array | null {
  if (HEX_KEY_RE.test(token)) {
    return hexToBytes(token);
  }
  if (token.startsWith("nsec1")) {
    try {
      const decoded = nip19.decode(token);
      return decoded.type === "nsec" ? decoded.data : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Parse a secret key out of `raw`, which may be:
 * - a bare 64-char hex string or nsec1-bech32 string (v0.1-of-this-parser
 *   shape — still the common case for a file/env var holding nothing else);
 * - a small multi-line file with comment lines (`#...`), blank lines, and/or
 *   labeled fields (`private_key: <value>`, `pub: <value>`, etc) — real key
 *   files in the wild are rarely *just* the bare key.
 *
 * Comment and blank lines are skipped outright. A line whose label matches
 * `/pub/i` (`public_key:`, `pubkey =`, …) is skipped too — even though a
 * public key is also a 64-hex-character string, it must never be mistaken
 * for the secret key when both appear in the same file. The first
 * remaining line (or line with no label at all — the bare-value case) that
 * decodes as hex or nsec1 wins.
 */
export function parseSecretKey(raw: string): Uint8Array {
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const labeled = LABELED_LINE_RE.exec(line);
    if (labeled) {
      const [, label, value] = labeled;
      if (label && /pub/i.test(label)) {
        continue; // never treat a publicly-labeled field as the secret
      }
      const decoded = tryDecodeCandidate((value ?? "").trim());
      if (decoded) {
        return decoded;
      }
      continue;
    }

    const decoded = tryDecodeCandidate(line);
    if (decoded) {
      return decoded;
    }
  }

  throw new Error(
    "owner key: no 64-character hex or nsec1-encoded secret key found in the given value",
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
