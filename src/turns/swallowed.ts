import { readOutcome, readSource, toMs } from "./classify";
import type { ObserverEvent, TurnSource } from "./types";

/**
 * Swallowed-reply correlation (v0.3) — completes the piece the v0.2 README
 * flagged as "classified but not yet live-fed": `classifySlot`'s
 * `channelActivity.replySeenAfterLastChannelTurn` input has been
 * fixture-tested since v0.2 (see classify.test.ts's "swallowed" suite), but
 * nothing computed it from a real channel-message feed. This module is that
 * computation — pure, transport-agnostic, fed by `channelMessagesClient.ts`
 * (kind 9) upstream and consumed by `buildBoard.ts` downstream.
 *
 * The correlation itself, per block/buzz#2698/#2459: a channel-sourced turn
 * completes with `outcome=ok` (the agent believes it succeeded), but no
 * reply message from the agent ever shows up in that channel afterward —
 * the "silently swallowed" class, distinct from `deaf` (never picked up the
 * mention at all) and from `dead`/`crashed-mid-turn` (the process itself is
 * down or stuck).
 */

/** One channel (kind 9) message, already parsed down to what the correlator
 * needs — see `channelMessages.ts` for the wire-to-record parser. */
export interface ChannelMessageRecord {
  /** The message author's pubkey. Only messages authored by the AGENT
   * itself count as a "reply" here — a message from the owner or anyone
   * else in the channel doesn't corroborate that the agent replied. */
  pubkey: string;
  channelId: string;
  /** ms epoch. */
  createdAt: number;
}

/**
 * How long after a channel-sourced turn resolves `ok` this board waits for
 * the agent's own reply before calling it swallowed, rather than merely
 * slow. Chosen from real rig timing, not a guess:
 *
 * - Two non-gated smoke-test replies captured live (fleet-captures-v02,
 *   `20260726T045832Z_02_smoke_test_channel_messages.json`) landed 8s and
 *   26s after the triggering mention.
 * - `DEFAULT_THRESHOLDS.wedgedAfterMs` (types.ts) is 60_000ms — "if an OPEN
 *   turn is still ticking this long after starting, call it wedged".
 *
 * This window is 2x `wedgedAfterMs`: if a turn that merely stayed open this
 * long would already read `wedged`, then a turn that reported itself
 * COMPLETE this long ago with total silence afterward is at least as
 * suspect — comfortably above both observed real latencies, with margin
 * for a legitimately slower model/turn. Documented here and in README.md >
 * "The six-state model (v0.2)" (swallowed row).
 */
export const SWALLOWED_CORROBORATION_WINDOW_MS = 120_000;

export interface LastResolvedTurn {
  channelId: string | null;
  source: TurnSource | "unknown";
  outcome: string | undefined;
  /** ms epoch. */
  resolvedAt: number;
}

/**
 * Walk one slot's chronological telemetry to find the most recently
 * *resolved* turn (by `turn_completed`/`turn_error`), regardless of source —
 * mirroring classify.ts's own internal `buildTimeline` walk exactly (same
 * "unmatched resolution reads source unknown" fallback), but additionally
 * surfacing `channelId`, which classify.ts keeps as an implementation
 * detail. Returns `null` when no turn in `events` has resolved yet.
 */
export function lastResolvedTurn(events: ObserverEvent[]): LastResolvedTurn | null {
  let openSource: TurnSource | "unknown" | undefined;
  let result: LastResolvedTurn | null = null;

  for (const event of events) {
    switch (event.kind) {
      case "turn_started":
        openSource = readSource(event.payload);
        break;
      case "turn_completed":
      case "turn_error":
        result = {
          channelId: event.channelId,
          source: openSource ?? "unknown",
          outcome: readOutcome(event.payload),
          resolvedAt: toMs(event.timestamp),
        };
        openSource = undefined;
        break;
      default:
        break;
    }
  }

  return result;
}

export interface ComputeReplySeenInput {
  /** The agent whose own reply we're looking for — a message from anyone
   * else does not corroborate a reply. */
  agentPubkey: string;
  /** This slot's chronological telemetry (same input classifySlot takes). */
  events: ObserverEvent[];
  /** Channel messages to search for a matching reply — need not be
   * pre-filtered by channel or author; this function does both. */
  channelMessages: ChannelMessageRecord[];
  /** ms epoch "now" — injected for testability, same convention as
   * classify.ts's `SlotClassifyInput.now`. */
  now: number;
  windowMs?: number;
}

/**
 * Compute the `replySeenAfterLastChannelTurn` input `classifySlot` expects
 * (see `types.ts`'s `ChannelActivity`), from a slot's own telemetry plus a
 * channel-message feed:
 *
 * - `null` — not applicable (no resolved turn yet, the last resolved turn
 *   wasn't channel-sourced, or it didn't complete `ok`) or not yet decided
 *   (the corroboration window is still open and nothing has arrived — a
 *   legitimately slow reply must not be misread as swallowed early).
 * - `true` — the agent posted into the same channel within the window.
 * - `false` — the window fully elapsed with no matching reply from the
 *   agent.
 */
export function computeReplySeenAfterLastChannelTurn(
  input: ComputeReplySeenInput,
): boolean | null {
  const windowMs = input.windowMs ?? SWALLOWED_CORROBORATION_WINDOW_MS;
  const last = lastResolvedTurn(input.events);

  if (!last || last.source !== "channel" || last.outcome !== "ok" || last.channelId === null) {
    return null;
  }

  const channelId = last.channelId;
  const replySeen = input.channelMessages.some(
    (m) =>
      m.pubkey === input.agentPubkey &&
      m.channelId === channelId &&
      m.createdAt >= last.resolvedAt &&
      m.createdAt <= last.resolvedAt + windowMs,
  );
  if (replySeen) {
    return true;
  }

  return input.now < last.resolvedAt + windowMs ? null : false;
}
