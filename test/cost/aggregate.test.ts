import { describe, expect, it } from "vitest";
import { aggregateFleetTotal, aggregatePerAgent, aggregateTrend } from "../../src/cost/aggregate";
import type { TurnMetricRecord } from "../../src/cost/types";
import liveCapture44200 from "../fixtures/live-capture-44200-turn-metrics.json";

const AGENT_A = "a".repeat(64);
const AGENT_B = "b".repeat(64);

function record(overrides: Partial<TurnMetricRecord> = {}): TurnMetricRecord {
  return {
    eventId: "evt-" + Math.random().toString(36).slice(2),
    agentPubkey: AGENT_A,
    harness: "goose",
    model: "claude-sonnet-4-5",
    channelId: null,
    sessionId: "s1",
    turnId: null,
    turnSeq: 1,
    timestampMs: 1_785_000_000_000,
    turn: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.01 },
    cumulative: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.01 },
    deltaReliable: true,
    stopReason: "end_turn",
    ...overrides,
  };
}

describe("aggregatePerAgent", () => {
  it("returns an empty array for no records", () => {
    expect(aggregatePerAgent([], new Map())).toEqual([]);
  });

  it("sums turnCount, totalTokens, and totalCostUsd for one agent across multiple turns", () => {
    const records = [
      record({ turn: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.01 } }),
      record({ turn: { inputTokens: 200, outputTokens: 100, totalTokens: 300, costUsd: 0.02 } }),
    ];

    const [summary] = aggregatePerAgent(records, new Map());

    expect(summary).toMatchObject({
      agentPubkey: AGENT_A,
      turnCount: 2,
      totalTokens: 450,
      totalCostUsd: 0.03,
    });
  });

  it("never treats a null turn.totalTokens/costUsd as zero — it's excluded from the sum, not added as 0", () => {
    const records = [
      record({ turn: { inputTokens: 100, outputTokens: null, totalTokens: null, costUsd: null } }),
      record({ turn: { inputTokens: 200, outputTokens: 100, totalTokens: 300, costUsd: 0.02 } }),
    ];

    const [summary] = aggregatePerAgent(records, new Map());

    expect(summary?.totalTokens).toBe(300);
    expect(summary?.totalCostUsd).toBe(0.02);
    expect(summary?.turnCount).toBe(2); // still counts as a turn even with unknown usage
  });

  it("reports latestCumulative from the most recent record by timestampMs, not array order", () => {
    const older = record({
      timestampMs: 1_785_000_000_000,
      cumulative: { inputTokens: 10, outputTokens: 10, totalTokens: 20, costUsd: 0.001 },
    });
    const newer = record({
      timestampMs: 1_785_000_050_000,
      cumulative: { inputTokens: 500, outputTokens: 500, totalTokens: 1000, costUsd: 0.5 },
    });

    const [summary] = aggregatePerAgent([older, newer], new Map()); // older listed first

    expect(summary?.latestCumulative).toEqual({
      inputTokens: 500,
      outputTokens: 500,
      totalTokens: 1000,
      costUsd: 0.5,
    });
  });

  it("splits records into separate per-agent summaries, keyed by agentPubkey", () => {
    const records = [
      record({ agentPubkey: AGENT_A, turn: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.01 } }),
      record({ agentPubkey: AGENT_B, turn: { inputTokens: 3, outputTokens: 3, totalTokens: 6, costUsd: 0.02 } }),
    ];

    const summaries = aggregatePerAgent(records, new Map());

    expect(summaries).toHaveLength(2);
    const a = summaries.find((s) => s.agentPubkey === AGENT_A);
    const b = summaries.find((s) => s.agentPubkey === AGENT_B);
    expect(a?.totalTokens).toBe(2);
    expect(b?.totalTokens).toBe(6);
  });

  it("attaches a display label from the given roster map, when present", () => {
    const records = [record({ agentPubkey: AGENT_A })];
    const labels = new Map([[AGENT_A, "gatekeeper"]]);

    const [summary] = aggregatePerAgent(records, labels);

    expect(summary?.label).toBe("gatekeeper");
  });

  it("leaves label undefined for an agent with no roster entry", () => {
    const records = [record({ agentPubkey: AGENT_A })];

    const [summary] = aggregatePerAgent(records, new Map());

    expect(summary?.label).toBeUndefined();
  });
});

describe("aggregateFleetTotal", () => {
  it("is all-zero for no records", () => {
    expect(aggregateFleetTotal([])).toEqual({
      agentCount: 0,
      turnCount: 0,
      totalTokens: 0,
      totalCostUsd: 0,
    });
  });

  it("sums every agent's usage into one fleet-wide total", () => {
    const records = [
      record({ agentPubkey: AGENT_A, turn: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.01 } }),
      record({ agentPubkey: AGENT_A, turn: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.01 } }),
      record({ agentPubkey: AGENT_B, turn: { inputTokens: 3, outputTokens: 3, totalTokens: 6, costUsd: 0.02 } }),
    ];

    expect(aggregateFleetTotal(records)).toEqual({
      agentCount: 2,
      turnCount: 3,
      totalTokens: 10,
      totalCostUsd: 0.04,
    });
  });
});

describe("aggregateTrend", () => {
  const HOUR_MS = 60 * 60 * 1000;

  it("returns no points for no records", () => {
    expect(aggregateTrend([], HOUR_MS)).toEqual([]);
  });

  it("buckets records into fixed-width, floor-aligned time buckets", () => {
    const bucketStart = Math.floor(1_785_000_000_000 / HOUR_MS) * HOUR_MS;
    const records = [
      record({ timestampMs: bucketStart + 1_000, turn: { inputTokens: 1, outputTokens: 1, totalTokens: 100, costUsd: 0.1 } }),
      record({ timestampMs: bucketStart + 2_000, turn: { inputTokens: 1, outputTokens: 1, totalTokens: 50, costUsd: 0.05 } }),
      record({ timestampMs: bucketStart + HOUR_MS + 500, turn: { inputTokens: 1, outputTokens: 1, totalTokens: 10, costUsd: 0.01 } }),
    ];

    const trend = aggregateTrend(records, HOUR_MS);

    expect(trend).toHaveLength(2);
    expect(trend[0]).toMatchObject({ bucketStartMs: bucketStart, turnCount: 2, totalTokens: 150 });
    expect(trend[0]?.totalCostUsd).toBeCloseTo(0.15, 10);
    expect(trend[1]).toMatchObject({
      bucketStartMs: bucketStart + HOUR_MS,
      turnCount: 1,
      totalTokens: 10,
    });
    expect(trend[1]?.totalCostUsd).toBeCloseTo(0.01, 10);
  });

  it("returns buckets sorted ascending by bucketStartMs regardless of input order", () => {
    const b0 = 0;
    const records = [
      record({ timestampMs: b0 + HOUR_MS * 3 }),
      record({ timestampMs: b0 }),
      record({ timestampMs: b0 + HOUR_MS }),
    ];

    const trend = aggregateTrend(records, HOUR_MS);

    expect(trend.map((p) => p.bucketStartMs)).toEqual([b0, b0 + HOUR_MS, b0 + HOUR_MS * 3]);
  });

  it("combines records across all agents into the same fleet-wide trend buckets", () => {
    const records = [
      record({ agentPubkey: AGENT_A, timestampMs: 0, turn: { inputTokens: 1, outputTokens: 1, totalTokens: 10, costUsd: 0.01 } }),
      record({ agentPubkey: AGENT_B, timestampMs: 100, turn: { inputTokens: 1, outputTokens: 1, totalTokens: 20, costUsd: 0.02 } }),
    ];

    const trend = aggregateTrend(records, HOUR_MS);

    expect(trend).toHaveLength(1);
    expect(trend[0]).toMatchObject({ turnCount: 2, totalTokens: 30 });
  });
});

// AC1: modeled fixtures above PLUS at least one REAL kind-44200 capture —
// see live-capture-44200-turn-metrics.meta.md for full provenance (queried
// live from the local relay through the real daemon code path, not an ad
// hoc script). Real-world signal these synthetic fixtures alone wouldn't
// force: a harness ("buzz-agent") other than the NIP-AM doc's own example
// ("goose"), and every turn.* field null with only PARTIAL cumulative data
// (inputTokens/outputTokens populated, totalTokens/costUsd not).
describe("aggregatePerAgent / aggregateFleetTotal — real kind-44200 capture", () => {
  const records = liveCapture44200 as TurnMetricRecord[];

  it("captured exactly three real turns from one agent, one session each (turnSeq=1 every time)", () => {
    expect(records).toHaveLength(3);
    expect(new Set(records.map((r) => r.agentPubkey)).size).toBe(1);
    expect(new Set(records.map((r) => r.sessionId)).size).toBe(3);
    expect(records.every((r) => r.turnSeq === 1)).toBe(true);
  });

  it("sums to turnCount=3 and totalTokens=0 — every record's turn.totalTokens was null, never summed as zero-that-means-something", () => {
    const [summary] = aggregatePerAgent(records, new Map([[records[0]?.agentPubkey ?? "", "gatekeeper"]]));

    expect(summary).toMatchObject({ label: "gatekeeper", turnCount: 3, totalTokens: 0, totalCostUsd: 0 });
  });

  it("still reports latestCumulative from the real data even though turn.* is entirely null", () => {
    const [summary] = aggregatePerAgent(records, new Map());

    // The real capture's latest-by-timestampMs record (ae8b5f8e turn).
    expect(summary?.latestCumulative).toEqual({
      inputTokens: 108190,
      outputTokens: 7960,
      totalTokens: null,
      costUsd: null,
    });
  });

  it("fleet total across the real capture matches the single real agent's own totals", () => {
    expect(aggregateFleetTotal(records)).toEqual({
      agentCount: 1,
      turnCount: 3,
      totalTokens: 0,
      totalCostUsd: 0,
    });
  });
});
