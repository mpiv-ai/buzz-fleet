import type {
  AgentCostSummary,
  CostTrendPoint,
  FleetCostSummary,
  TurnMetricRecord,
} from "./types";

/**
 * Pure aggregation over decoded {@link TurnMetricRecord}s — no SQLite, no
 * Node dependency, so these run the same in `src/cost/store.ts` (daemon,
 * reading persisted rows) and in a test file (in-memory fixtures). Every sum
 * here treats a `null` per-record field as "excluded from the sum", never as
 * `0` — per NIP-AM, "a null MUST NOT be recorded or summed as zero". A
 * summary's own `totalTokens`/`totalCostUsd` ARE plain numbers (0 when no
 * record contributed any non-null usage) — that's a deliberate, coarser
 * choice at the aggregate level: "how many tokens did we account for" is a
 * more useful dashboard number than propagating "unknown" up from a single
 * incomplete turn among many.
 */

function sumNonNull(values: (number | null)[]): number {
  return values.reduce<number>((total, v) => (v === null ? total : total + v), 0);
}

/** Roll per-record usage up into one summary per `agentPubkey`. Order of the
 * returned array is not significant to callers; `records` need not be
 * sorted. `labelByPubkey` supplies the roster display label, when known. */
export function aggregatePerAgent(
  records: TurnMetricRecord[],
  labelByPubkey: Map<string, string | undefined>,
): AgentCostSummary[] {
  const byAgent = new Map<string, TurnMetricRecord[]>();
  for (const record of records) {
    const bucket = byAgent.get(record.agentPubkey);
    if (bucket) {
      bucket.push(record);
    } else {
      byAgent.set(record.agentPubkey, [record]);
    }
  }

  return Array.from(byAgent.entries()).map(([agentPubkey, agentRecords]) => {
    const latest = agentRecords.reduce((newest, r) =>
      newest === null || r.timestampMs > newest.timestampMs ? r : newest,
    agentRecords[0] ?? null);

    return {
      agentPubkey,
      label: labelByPubkey.get(agentPubkey),
      turnCount: agentRecords.length,
      totalTokens: sumNonNull(agentRecords.map((r) => r.turn.totalTokens)),
      totalCostUsd: sumNonNull(agentRecords.map((r) => r.turn.costUsd)),
      latestCumulative: latest ? latest.cumulative : null,
    };
  });
}

/** Fleet-wide rollup — the sum of every agent's usage, regardless of roster
 * labels (unlike {@link aggregatePerAgent}, this needs no label map). */
export function aggregateFleetTotal(records: TurnMetricRecord[]): FleetCostSummary {
  const agentPubkeys = new Set(records.map((r) => r.agentPubkey));
  return {
    agentCount: agentPubkeys.size,
    turnCount: records.length,
    totalTokens: sumNonNull(records.map((r) => r.turn.totalTokens)),
    totalCostUsd: sumNonNull(records.map((r) => r.turn.costUsd)),
  };
}

/** Fleet-wide (all agents combined) usage trend, bucketed into fixed-width,
 * floor-aligned time windows of `bucketMs`. Returned points are sorted
 * ascending by `bucketStartMs`; empty input yields an empty trend, not a
 * zero-filled range (there is no natural "start" to fill from without a
 * caller-supplied window). */
export function aggregateTrend(records: TurnMetricRecord[], bucketMs: number): CostTrendPoint[] {
  const byBucket = new Map<number, TurnMetricRecord[]>();
  for (const record of records) {
    const bucketStartMs = Math.floor(record.timestampMs / bucketMs) * bucketMs;
    const bucket = byBucket.get(bucketStartMs);
    if (bucket) {
      bucket.push(record);
    } else {
      byBucket.set(bucketStartMs, [record]);
    }
  }

  return Array.from(byBucket.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucketStartMs, bucketRecords]) => ({
      bucketStartMs,
      turnCount: bucketRecords.length,
      totalTokens: sumNonNull(bucketRecords.map((r) => r.turn.totalTokens)),
      totalCostUsd: sumNonNull(bucketRecords.map((r) => r.turn.costUsd)),
    }));
}
