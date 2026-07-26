/**
 * Turn cost/usage metric types — kind `44200` (NIP-AM, Agent Turn Metrics).
 *
 * Wire event: `{ kind: 44200, pubkey: <agent>, created_at, content: <NIP-44
 * v2 ciphertext>, tags: [["p", owner], ["agent", agent]] }`. `content`
 * decrypts to {@link TurnMetricPayload}. See `docs/nips/NIP-AM.md` in
 * block/buzz (verified at commit `384c72d` — see
 * `docs/teardown2-claims-map.md` row (g) for the pinned citation).
 *
 * Unlike kind 24200 (NIP-AO), 44200 is a REGULAR (stored, durable) event —
 * "append-only, never replaced" per the NIP — so a `since` in the past is
 * both allowed and the documented way to recover usage history (NIP-AM
 * "Client Behavior"). It also has NO `frame` tag: the NIP-AO envelope's
 * `frame=telemetry|control` gate does not apply here, and code that reuses
 * `wsClient.ts`'s auth/decrypt machinery for this kind must not carry that
 * gate over (see `metricsDecrypt.ts` / `metricsClient.ts`).
 */

/** The five `stopReason` values NIP-AM enumerates. `"unknown"` is both a
 * legal wire value in its own right AND the fold target for anything else —
 * folding must never fail parsing (NIP-AM: "Consumers MUST treat
 * unrecognized stopReason values as unknown; the token counts remain
 * valid."). */
export const KNOWN_STOP_REASONS = ["end_turn", "max_tokens", "cancelled", "error", "unknown"] as const;

export type StopReason = (typeof KNOWN_STOP_REASONS)[number];

const KNOWN_STOP_REASON_SET: ReadonlySet<string> = new Set(KNOWN_STOP_REASONS);

/** Fold any wire value into a valid {@link StopReason}, defaulting to
 * `"unknown"` for anything absent, non-string, or not one of the five
 * canonical values (including values NIP-AM itself hasn't defined yet).
 * Never throws — this is a parsing boundary, not a validator. */
export function foldStopReason(value: unknown): StopReason {
  return typeof value === "string" && KNOWN_STOP_REASON_SET.has(value)
    ? (value as StopReason)
    : "unknown";
}

/** One usage bucket (either a per-turn delta or a session-cumulative
 * snapshot). Every field is independently nullable because the harness may
 * not report it — per NIP-AM, "a null MUST NOT be recorded or summed as
 * zero", so callers must treat `null` as "unknown", never as `0`. */
export interface TokenCounts {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

/** A real all-null bucket — the value used when the harness reported no
 * `turn`/`cumulative` object at all on the wire. Distinct from "all zeros";
 * see {@link TokenCounts} doc. */
export const ZERO_TOKEN_COUNTS: TokenCounts = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  costUsd: null,
};

/** Decrypted `content` of a kind-44200 event, per NIP-AM's "Decrypted
 * Payload" section. `harness` and `timestamp` are the only REQUIRED fields;
 * everything else defaults per-field (see `metricsDecrypt.ts`). */
export interface TurnMetricPayload {
  harness: string;
  model: string | null;
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  turnSeq: number | null;
  /** RFC 3339, end of turn. */
  timestamp: string;
  turn: TokenCounts;
  cumulative: TokenCounts;
  deltaReliable: boolean;
  stopReason: StopReason;
}

/** One decoded, persistence-ready turn metric record: the decrypted
 * {@link TurnMetricPayload} plus the envelope fields (`eventId`,
 * `agentPubkey`) that only exist on the outer Nostr event, not inside the
 * ciphertext. This is the shape both `metricsClient.ts` emits and
 * `src/cost/store.ts` persists/reads — aggregation (`aggregate.ts`) is pure
 * over arrays of this type, with no SQLite dependency. */
export interface TurnMetricRecord {
  /** The kind-44200 event's own `id` — the natural dedup key (durable +
   * regular kind, so a daemon restart re-subscribing with a past `since`
   * will see the same event again). */
  eventId: string;
  /** `event.pubkey` / the `agent` tag — the publishing agent. */
  agentPubkey: string;
  harness: string;
  model: string | null;
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  turnSeq: number | null;
  /** ms epoch, parsed from the payload's `timestamp` (falls back to the
   * envelope's `created_at * 1000` if `timestamp` fails to parse — see
   * `metricsDecrypt.ts`). */
  timestampMs: number;
  turn: TokenCounts;
  cumulative: TokenCounts;
  deltaReliable: boolean;
  stopReason: StopReason;
}

/** One agent's rolled-up cost summary over whatever record set was given. */
export interface AgentCostSummary {
  agentPubkey: string;
  label: string | undefined;
  turnCount: number;
  /** Sum of `turn.totalTokens` across records where it was non-null. */
  totalTokens: number;
  /** Sum of `turn.costUsd` across records where it was non-null. */
  totalCostUsd: number;
  /** The most recent record's `cumulative` bucket — the harness's own
   * running total as of the latest turn seen, not re-derived. `null` when
   * no record carried a non-null cumulative. */
  latestCumulative: TokenCounts | null;
}

/** Fleet-wide rollup — the sum of every agent's summary. */
export interface FleetCostSummary {
  agentCount: number;
  turnCount: number;
  totalTokens: number;
  totalCostUsd: number;
}

/** One point in a cost/usage trend, bucketed by time. */
export interface CostTrendPoint {
  /** Start of this bucket, ms epoch (floor of each record's `timestampMs`
   * to the bucket width). */
  bucketStartMs: number;
  turnCount: number;
  totalTokens: number;
  totalCostUsd: number;
}
