import {
  DEFAULT_THRESHOLDS,
  FATAL_OUTCOMES,
  type ChannelActivity,
  type ClassifyThresholds,
  type ObserverEvent,
  type OpenTurnDetail,
  type PresenceSignal,
  type SixState,
  type SlotClassifyInput,
  type SlotLivenessResult,
  type TurnCompletedPayload,
  type TurnErrorPayload,
  type TurnSource,
  type TurnStartedPayload,
} from "./types";

// toMs/readSource/readOutcome are exported for reuse by swallowed.ts, which
// needs to walk the exact same turn-resolution semantics (including the
// unmatched-open-turn "unknown" source fallback) to surface `channelId` on
// the last resolved turn — a field this module deliberately doesn't expose
// on SlotLivenessResult (see swallowed.ts's module doc). Behavior here is
// unchanged; only the `export` keyword was added.
export function toMs(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? 0 : ms;
}

export function readSource(payload: unknown): TurnSource | "unknown" {
  if (typeof payload !== "object" || payload === null) {
    return "unknown";
  }
  const source = (payload as TurnStartedPayload).source;
  return source === "channel" || source === "heartbeat" ? source : "unknown";
}

export function readOutcome(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const outcome = (payload as TurnCompletedPayload | TurnErrorPayload).outcome;
  return typeof outcome === "string" ? outcome : undefined;
}

interface TurnTimeline {
  /** The last turn_started not yet matched by a turn_completed/turn_error,
   * or null if the slot is between turns. */
  open: null | {
    turnId: string | null;
    source: TurnSource | "unknown";
    startedAt: number;
    lastTickAt: number;
  };
  /** Outcome of the most recently *resolved* turn, if any have resolved. */
  lastResolved: null | {
    turnId: string | null;
    source: TurnSource | "unknown";
    outcome: string | undefined;
    resolvedAt: number;
  };
  /** ms epoch of this slot's most recent event of any kind (open or not). */
  lastEventAt: number | null;
}

/**
 * Walk one slot's chronological telemetry into "is there an open turn right
 * now, and what happened to the last one that resolved". Unknown frame
 * kinds are default pass-through (ignored here; the NIP requires clients to
 * ignore unrecognized `kind`s). Elided payloads (`{elided,originalBytes}` or
 * inline `…[elided N bytes]…` markers) never break this walk — only
 * `payload.source`/`payload.outcome` are read, both defensively.
 */
function buildTimeline(events: ObserverEvent[]): TurnTimeline {
  let open: TurnTimeline["open"] = null;
  let lastResolved: TurnTimeline["lastResolved"] = null;
  let lastEventAt: number | null = null;

  for (const event of events) {
    const atMs = toMs(event.timestamp);
    lastEventAt = lastEventAt === null ? atMs : Math.max(lastEventAt, atMs);

    switch (event.kind) {
      case "turn_started": {
        open = {
          turnId: event.turnId,
          source: readSource(event.payload),
          startedAt: atMs,
          lastTickAt: atMs,
        };
        break;
      }
      case "turn_liveness": {
        if (open && (event.turnId === null || event.turnId === open.turnId)) {
          open.lastTickAt = Math.max(open.lastTickAt, atMs);
        }
        break;
      }
      case "turn_completed":
      case "turn_error": {
        const resolvedTurnId = open?.turnId ?? event.turnId;
        const resolvedSource = open?.source ?? "unknown";
        lastResolved = {
          turnId: resolvedTurnId,
          source: resolvedSource,
          outcome: readOutcome(event.payload),
          resolvedAt: atMs,
        };
        if (!open || event.turnId === null || event.turnId === open.turnId) {
          open = null;
        }
        break;
      }
      default:
        // Default pass-through: acp_read/acp_write/agent_panic/harness_started/
        // agent_initialized/managed_agent_runtime_lifecycle/control_result/
        // session_resolved, and any future unknown kind — none of them
        // change open-turn tracking for this classifier.
        break;
    }
  }

  return { open, lastResolved, lastEventAt };
}

function openTurnDetail(open: TurnTimeline["open"]): OpenTurnDetail | null {
  if (!open) {
    return null;
  }
  return {
    turnId: open.turnId,
    source: open.source,
    startedAt: open.startedAt,
    lastTickAt: open.lastTickAt,
  };
}

function classifyOpenTurn(
  open: NonNullable<TurnTimeline["open"]>,
  now: number,
  presence: PresenceSignal,
  thresholds: ClassifyThresholds,
  previousState: SixState | undefined,
): SixState {
  const turnOpenDuration = now - open.startedAt;
  const sinceLastTick = now - open.lastTickAt;

  // Turn-timeout corroboration path A: exceeding the harness's own hard cap
  // is itself sufficient corroboration (a resolution frame should have
  // already landed) — this does not depend on presence or tick recency.
  if (turnOpenDuration >= thresholds.hardCapMs) {
    return "crashed-mid-turn";
  }

  const ticksCurrent = sinceLastTick < thresholds.tickStaleMs;

  if (ticksCurrent) {
    return turnOpenDuration >= thresholds.wedgedAfterMs ? "wedged" : "alive";
  }

  // Ticks have gapped. Per the v0.2 guardrail, a gap is NEVER sufficient
  // alone — it must be corroborated by presence going dead, or by the
  // turn-timeout (idle_timeout) corroboration path.
  if (presence.liveness === "dead") {
    return "crashed-mid-turn";
  }
  if (sinceLastTick >= thresholds.idleTimeoutMs) {
    return "crashed-mid-turn";
  }

  // Gap observed, no corroboration yet — stay put. Fall back to whatever
  // this slot's turn-duration alone would justify (never worse), rather
  // than inventing a flip from the gap itself.
  if (previousState === "wedged" || previousState === "crashed-mid-turn") {
    return previousState;
  }
  return turnOpenDuration >= thresholds.wedgedAfterMs ? "wedged" : "alive";
}

function deafSignal(now: number, channelActivity: ChannelActivity | undefined): boolean {
  if (!channelActivity || channelActivity.recentMessages.length === 0) {
    return false;
  }
  return channelActivity.recentMessages.some((m) => !m.reactionSeen) && now >= 0;
}

function classifyIdleSlot(
  timeline: TurnTimeline,
  now: number,
  presence: PresenceSignal,
  thresholds: ClassifyThresholds,
  channelActivity: ChannelActivity | undefined,
  channelSourcedTurnStartsInWindow: boolean,
): SixState {
  if (presence.liveness === "dead") {
    return "dead";
  }

  // swallowed: the last turn that resolved was channel-sourced, completed
  // ok, and no reply was ever seen in that channel afterward.
  if (
    timeline.lastResolved &&
    timeline.lastResolved.source === "channel" &&
    timeline.lastResolved.outcome === "ok" &&
    channelActivity?.replySeenAfterLastChannelTurn === false
  ) {
    return "swallowed";
  }

  // deaf: channel has unreacted activity but nothing channel-sourced ever
  // started a turn in that window.
  if (!channelSourcedTurnStartsInWindow && deafSignal(now, channelActivity)) {
    return "deaf";
  }

  // Slot-local liveness: process-wide presence is alive (other slots may be
  // keeping it up), but THIS slot went silent after a fatal outcome for
  // longer than the circuit breaker's own cooldown — report it as dead at
  // the slot level rather than borrowing the process's health.
  if (
    timeline.lastEventAt !== null &&
    timeline.lastResolved &&
    FATAL_OUTCOMES.has(timeline.lastResolved.outcome ?? "") &&
    now - timeline.lastEventAt >= thresholds.slotQuietMs
  ) {
    return "dead";
  }

  return "alive";
}

/**
 * Classify one slot (a single `agentIndex` on one roster agent) from its own
 * decoded telemetry plus process-wide presence and optional channel
 * corroboration. Pure and synchronous — transport-agnostic, fixture-testable.
 *
 * The one hard rule: **no state may flip on a bare telemetry frame gap.**
 * Frames drop silently while the relay's rate-limit gate is active (harness
 * self-paces 6/s, 90/rolling-60s cap) — a gap always needs corroboration
 * from presence (this slot's process going dead) or a turn timeout
 * (idle_timeout/hard cap) before it can move the state, never the gap alone.
 */
export function classifySlot(input: SlotClassifyInput): SlotLivenessResult {
  const thresholds: ClassifyThresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const timeline = buildTimeline(input.events);

  let channelSourcedTurnStartsInWindow = false;
  for (const event of input.events) {
    if (event.kind === "turn_started" && readSource(event.payload) === "channel") {
      channelSourcedTurnStartsInWindow = true;
      break;
    }
  }

  const state = timeline.open
    ? classifyOpenTurn(
        timeline.open,
        input.now,
        input.presence,
        thresholds,
        input.previous?.state,
      )
    : classifyIdleSlot(
        timeline,
        input.now,
        input.presence,
        thresholds,
        input.channelActivity,
        channelSourcedTurnStartsInWindow,
      );

  const lastTransitionAt =
    input.previous && input.previous.state === state ? input.previous.lastTransitionAt : input.now;

  return {
    state,
    lastTransitionAt,
    openTurn: openTurnDetail(timeline.open),
  };
}

/** Priority order for rolling per-slot results up into the single badge
 * shown on an agent's board row. Most-actionable-first, EXCEPT "dead" sits
 * last: at the agent (process) level, "dead" only means anything when every
 * slot agrees — one slot reading dead while a sibling is alive/wedged/etc
 * just means that slot is quiet (e.g. mid circuit-breaker cooldown) while
 * the process plainly isn't, so any other observed state outranks it. */
const ROLLUP_PRIORITY: SixState[] = [
  "crashed-mid-turn",
  "wedged",
  "swallowed",
  "deaf",
  "alive",
  "dead",
];

/**
 * Roll multiple slot results up into one aggregate state for an agent's main
 * board row. Falls back to plain presence alive/dead when there are no
 * slots yet (no owner key configured for this relay, or no agentIndex-
 * bearing telemetry observed) — the v0.1 board never breaks for a relay
 * that isn't wired for turn telemetry.
 */
export function rollupAgentState(
  slots: SlotLivenessResult[],
  presence: PresenceSignal,
): SixState {
  if (slots.length === 0) {
    return presence.liveness;
  }

  const states = new Set(slots.map((s) => s.state));
  for (const candidate of ROLLUP_PRIORITY) {
    if (states.has(candidate)) {
      return candidate;
    }
  }
  // Unreachable: ROLLUP_PRIORITY is exhaustive over SixState, and `states`
  // is built from valid SixState values with at least one member.
  return "alive";
}
