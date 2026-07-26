/**
 * Turn telemetry types — kind `24200` (NIP-AO, Agent Observability).
 *
 * Wire event: `{ kind: 24200, pubkey, created_at, content: <NIP-44 v2 ciphertext>,
 * tags: [["p", owner], ["agent", agent], ["frame", "telemetry"|"control"]] }`.
 * `content` decrypts to the {@link ObserverEvent} shapes below. See
 * `docs/nips/NIP-AO.md` in block/buzz.
 */

/** The six liveness states this board classifies agents/slots into. */
export type SixState =
  | "alive"
  | "dead"
  | "crashed-mid-turn"
  | "wedged"
  | "deaf"
  | "swallowed";

/**
 * Decrypted telemetry payload (`frame=telemetry`). `kind` is an OPEN string
 * set — the NIP doc lists 4, shipping buzz-acp emits 12+ (see
 * `KNOWN_FRAME_KINDS` below). Unknown kinds MUST be ignored per the NIP,
 * which for this board means: keep the envelope, treat `payload` as opaque.
 */
export interface ObserverEvent {
  /** Monotonic per-session sequence number (drop detection). */
  seq: number;
  /** RFC 3339 datetime string, sub-second precision. */
  timestamp: string;
  /** Frame kind — open string set, e.g. `turn_started`, `turn_liveness`. */
  kind: string;
  /** Slot identifier in multi-agent pools. `null`/absent when not yet known. */
  agentIndex: number | null;
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  /** Kind-specific. MAY be `{}`, MAY be elided (see `decrypt.ts`). */
  payload: unknown;
}

/** Frame kinds this classifier has specific handling for. Everything else is
 * default pass-through: envelope kept, payload untouched, no state impact. */
export const KNOWN_FRAME_KINDS = [
  "acp_read",
  "acp_write",
  "turn_started",
  "turn_liveness",
  "turn_completed",
  "turn_error",
  "agent_panic",
  "harness_started",
  "agent_initialized",
  "managed_agent_runtime_lifecycle",
  "control_result",
  "session_resolved",
  // Observed live on the demo rig 2026-07-26, in neither the NIP's list of
  // four nor the v0.2 contract's list of twelve — recorded here as evidence
  // that `kind` really is an open set. Handled by default pass-through, same
  // as anything else unrecognised.
  "session_config_captured",
] as const;

/** `payload.source` on a `turn_started` frame. Open string set — unrecognized
 * values are tolerated and reported as `"unknown"` by the classifier. */
export type TurnSource = "channel" | "heartbeat";

export interface TurnStartedPayload {
  source?: string;
}

/**
 * `outcome` field on `turn_completed`/`turn_error` payloads. Consumed AS-IS
 * per the v0.2 contract — never re-derived. Matches buzz-acp's
 * `outcome_label` match arms exactly (buzz-acp/src/lib.rs:3138-3146).
 */
export type OutcomeLabel =
  | "ok"
  | "error"
  | "idle_timeout"
  | "hard_timeout"
  | "exited"
  | "cancelled"
  | "cancel_drain_timeout";

/** Outcomes that unambiguously mean the harness respawned the slot
 * (buzz-acp/src/lib.rs: `AgentExited | Timeout(_)` and `CancelDrainTimeout(_)`
 * arms always take the fatal/respawn branch). Bare `"error"` is deliberately
 * excluded — it covers both transport-fatal and pipe-intact application
 * errors and outcome_label alone can't tell them apart. Distinguishing them
 * needs `error_class`, gated behind block/buzz#2240/#2289 (both OPEN,
 * unmerged as of this writing) — per the contract, read that field only once
 * those land, so bare `"error"` is treated as non-fatal here for now. */
export const FATAL_OUTCOMES: ReadonlySet<string> = new Set([
  "exited",
  "hard_timeout",
  "cancel_drain_timeout",
]);

export interface TurnCompletedPayload {
  outcome?: string;
}

export interface TurnErrorPayload {
  outcome?: string;
  error?: string;
  code?: number;
}

// Elided payloads ({elided, originalBytes} whole-payload stubs, or inline
// "…[elided N bytes]…" markers spliced into an oversized string leaf — see
// buzz-acp/src/lib.rs) are deliberately NOT modeled as a distinct type here.
// classify.ts treats `payload` as opaque for every kind except reading
// `source`/`outcome`, so an elided payload never needs detecting — it's
// just JSON the classifier doesn't look inside. See
// test/turns/classify.test.ts's "elided payloads parse defensively" suite.

// ---------------------------------------------------------------------------
// Classifier inputs/outputs
// ---------------------------------------------------------------------------

/** v0.1 presence classification for the whole roster agent (process-wide —
 * there is no per-slot presence heartbeat on the wire, only per-process). */
export interface PresenceSignal {
  liveness: "alive" | "dead";
}

/** One channel message observed for deaf/swallowed corroboration. Sourced
 * outside kind 24200 (channel stream + reactions) — see README non-goals for
 * why this board does not itself ingest that feed live in v0.2; the field
 * exists so the classifier is ready for a future feed without inventing a
 * 7th state or reshaping the return type. */
export interface ChannelMessageSignal {
  /** ms epoch the message was posted. */
  postedAt: number;
  /** Whether the harness's eyes-emoji pickup reaction was ever seen on it. */
  reactionSeen: boolean;
}

/** Corroboration a classify call MAY be given, beyond telemetry + presence. */
export interface ChannelActivity {
  /** Recent messages in the agent's channel (any sender), for deaf detection. */
  recentMessages: ChannelMessageSignal[];
  /** Whether the most recently *resolved* channel-sourced turn got a reply
   * message afterward, for swallowed detection. `null` when unknown/not
   * applicable (e.g. last turn wasn't channel-sourced, or no completed turn). */
  replySeenAfterLastChannelTurn: boolean | null;
}

export interface ClassifyThresholds {
  /** Open turn + ticking longer than this becomes "wedged" instead of
   * "alive". Not specified by the NIP or the v0.2 contract — implementation
   * choice, ~6x the ~10s liveness cadence, tunable via fleet.yaml. */
  wedgedAfterMs: number;
  /** How long since the last liveness tick before a gap is even considered
   * "stale" for corroboration purposes. NEVER sufficient alone to flip state
   * — see `classifySlot` guardrail. */
  tickStaleMs: number;
  /** Matches buzz-acp's `idle_timeout` (no ACP wire activity bound). */
  idleTimeoutMs: number;
  /** Matches buzz-acp's hard turn-duration cap (force-resolve bound). */
  hardCapMs: number;
  /** How long a slot can go fully silent after a fatal outcome before its
   * own (slot-local) liveness reads "dead", independent of process-wide
   * presence. Matches the circuit breaker's 300s cooldown — the one
   * ticket-grounded number available for "how long is a slot allowed to be
   * quiet on purpose". */
  slotQuietMs: number;
}

export const DEFAULT_THRESHOLDS: ClassifyThresholds = {
  wedgedAfterMs: 60_000,
  tickStaleMs: 30_000,
  idleTimeoutMs: 900_000,
  hardCapMs: 7_200_000,
  slotQuietMs: 300_000,
};

export interface OpenTurnDetail {
  turnId: string | null;
  source: TurnSource | "unknown";
  startedAt: number;
  lastTickAt: number;
}

export interface SlotLivenessResult {
  state: SixState;
  /** ms epoch of the last state *change* (carried forward unchanged across
   * calls that don't change `state`). */
  lastTransitionAt: number;
  openTurn: OpenTurnDetail | null;
}

export interface SlotClassifyInput {
  /** ms epoch "now" for this evaluation — injected for testability. */
  now: number;
  presence: PresenceSignal;
  /** This slot's (single `agentIndex`) decoded telemetry, chronological. */
  events: ObserverEvent[];
  channelActivity?: ChannelActivity;
  /** Prior result from the last call, for `lastTransitionAt` hysteresis and
   * the frame-gap guardrail (§ "stay put" fallback). `undefined` on first
   * classification for this slot. */
  previous?: SlotLivenessResult;
  thresholds?: Partial<ClassifyThresholds>;
}
