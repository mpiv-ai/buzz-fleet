import { parse as parseYaml } from "yaml";
import type { FleetConfig, RelayConfig, RosterAgent } from "./types";

/** Comfortably under the harness's 60s presence republish interval. */
export const DEFAULT_POLL_INTERVAL_MS = 20_000;

/** Matches the relay's own presence Redis TTL. */
export const DEFAULT_DEAD_AFTER_MS = 90_000;

const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/i;
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NSEC_RE = /^nsec1[a-z0-9]+$/i;

function fail(message: string): never {
  throw new Error(`fleet.yaml: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePubkey(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEX_PUBKEY_RE.test(value)) {
    fail(`${field} must be a 64-character hex pubkey, got ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}

function parseRosterAgent(raw: unknown, index: number): RosterAgent {
  if (!isRecord(raw)) {
    fail(`relays[].roster[${index}] must be an object`);
  }
  const pubkey = normalizePubkey(raw.pubkey, `relays[].roster[${index}].pubkey`);
  const agent: RosterAgent = { pubkey };
  if (raw.label !== undefined) {
    if (typeof raw.label !== "string" || raw.label.length === 0) {
      fail(`relays[].roster[${index}].label must be a non-empty string when present`);
    }
    agent.label = raw.label;
  }
  return agent;
}

function parseRelay(raw: unknown, index: number): RelayConfig {
  if (!isRecord(raw)) {
    fail(`relays[${index}] must be an object`);
  }

  if (typeof raw.url !== "string" || raw.url.length === 0) {
    fail(`relays[${index}].url must be a non-empty string`);
  }
  // Either the relay's real absolute origin, or a root-relative path
  // reached through a same-origin proxy (some relay builds don't emit
  // browser CORS headers on /query — see README > "Browser CORS").
  if (!raw.url.startsWith("/")) {
    try {
      void new URL(raw.url);
    } catch {
      fail(
        `relays[${index}].url must be an absolute URL or a root-relative path (starting with "/"), got ${JSON.stringify(raw.url)}`,
      );
    }
  }

  const callerPubkey = normalizePubkey(raw.callerPubkey, `relays[${index}].callerPubkey`);

  if (!Array.isArray(raw.roster) || raw.roster.length === 0) {
    fail(`relays[${index}].roster must be a non-empty array`);
  }

  const { ownerKeyFile, ownerKeyEnv } = parseOwnerKeyRef(raw, index);

  return {
    url: raw.url,
    callerPubkey,
    roster: raw.roster.map((entry, i) => parseRosterAgent(entry, i)),
    ...(ownerKeyFile !== undefined ? { ownerKeyFile } : {}),
    ...(ownerKeyEnv !== undefined ? { ownerKeyEnv } : {}),
  };
}

/**
 * Validate the v0.2 `ownerKeyFile`/`ownerKeyEnv` reference pair. Neither
 * field's VALUE is ever key material — `ownerKeyFile` is a path, `ownerKeyEnv`
 * is a variable NAME — so this rejects anything that looks like it might
 * actually be a secret pasted in by mistake (a bare 64-hex string or an
 * `nsec1...` bech32 key), on top of the ordinary shape checks.
 */
function parseOwnerKeyRef(
  raw: Record<string, unknown>,
  index: number,
): { ownerKeyFile?: string; ownerKeyEnv?: string } {
  const hasFile = raw.ownerKeyFile !== undefined;
  const hasEnv = raw.ownerKeyEnv !== undefined;

  if (hasFile && hasEnv) {
    fail(
      `relays[${index}]: set at most one of ownerKeyFile / ownerKeyEnv, got both`,
    );
  }

  if (hasFile) {
    if (typeof raw.ownerKeyFile !== "string" || raw.ownerKeyFile.length === 0) {
      fail(`relays[${index}].ownerKeyFile must be a non-empty string when present`);
    }
    return { ownerKeyFile: raw.ownerKeyFile };
  }

  if (hasEnv) {
    if (typeof raw.ownerKeyEnv !== "string" || raw.ownerKeyEnv.length === 0) {
      fail(`relays[${index}].ownerKeyEnv must be a non-empty string when present`);
    }
    if (HEX_PUBKEY_RE.test(raw.ownerKeyEnv) || NSEC_RE.test(raw.ownerKeyEnv)) {
      fail(
        `relays[${index}].ownerKeyEnv looks like a key itself, not an environment variable name — ` +
          `set the env var elsewhere and reference its NAME here`,
      );
    }
    if (!ENV_VAR_NAME_RE.test(raw.ownerKeyEnv)) {
      fail(
        `relays[${index}].ownerKeyEnv must look like an environment variable name (got ${JSON.stringify(raw.ownerKeyEnv)})`,
      );
    }
    return { ownerKeyEnv: raw.ownerKeyEnv };
  }

  return {};
}

function parsePositiveInt(raw: unknown, field: string, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    fail(`${field} must be a positive number when present, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Parse and validate `fleet.yaml` text into a {@link FleetConfig}.
 *
 * Pure and synchronous — no I/O. Throws a descriptive `Error` on any
 * malformed or missing required field.
 */
export function parseConfig(yamlText: string): FleetConfig {
  const doc: unknown = parseYaml(yamlText);

  if (!isRecord(doc)) {
    fail("document root must be an object");
  }

  if (!Array.isArray(doc.relays) || doc.relays.length === 0) {
    fail("relays must be a non-empty array");
  }

  return {
    relays: doc.relays.map((entry, i) => parseRelay(entry, i)),
    pollIntervalMs: parsePositiveInt(doc.pollIntervalMs, "pollIntervalMs", DEFAULT_POLL_INTERVAL_MS),
    deadAfterMs: parsePositiveInt(doc.deadAfterMs, "deadAfterMs", DEFAULT_DEAD_AFTER_MS),
  };
}

/**
 * Fetch `url` (typically `/fleet.yaml`, served from `public/`) and parse it
 * as a {@link FleetConfig}.
 */
export async function loadConfig(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FleetConfig> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`fleet.yaml: failed to fetch ${url}: HTTP ${response.status}`);
  }
  const text = await response.text();
  return parseConfig(text);
}
