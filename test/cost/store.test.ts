/** @vitest-environment node */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCostStore } from "../../src/cost/store";
import type { CostStore } from "../../src/cost/store";
import type { TurnMetricRecord } from "../../src/cost/types";
import liveCapture44200 from "../fixtures/live-capture-44200-turn-metrics.json";

// node:sqlite (DatabaseSync/StatementSync) — verified empirically present
// and usable, unflagged (just an ExperimentalWarning), on the installed
// Node v22.22.3 before choosing it over better-sqlite3. See
// docs/teardown2-claims-map.md for the verification note and
// package.json's engines field.

const AGENT_A = "a".repeat(64);
const AGENT_B = "b".repeat(64);

function record(overrides: Partial<TurnMetricRecord> = {}): TurnMetricRecord {
  return {
    eventId: "evt-1",
    agentPubkey: AGENT_A,
    harness: "goose",
    model: "claude-sonnet-4-5",
    channelId: "chan-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    turnSeq: 3,
    timestampMs: 1_785_000_000_000,
    turn: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.0123 },
    cumulative: { inputTokens: 900, outputTokens: 400, totalTokens: 1300, costUsd: 0.5 },
    deltaReliable: true,
    stopReason: "end_turn",
    ...overrides,
  };
}

describe("openCostStore (:memory:)", () => {
  let store: CostStore;

  beforeEach(() => {
    store = openCostStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("starts empty", () => {
    expect(store.listTurnMetrics()).toEqual([]);
  });

  it("round-trips a full record exactly, including nullable and boolean fields", () => {
    store.insertTurnMetric(record());

    const rows = store.listTurnMetrics();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(record());
  });

  it("round-trips null token-count fields as null, never as 0", () => {
    store.insertTurnMetric(
      record({
        turn: { inputTokens: 10, outputTokens: null, totalTokens: null, costUsd: null },
      }),
    );

    const [row] = store.listTurnMetrics();

    expect(row?.turn.outputTokens).toBeNull();
    expect(row?.turn.totalTokens).toBeNull();
    expect(row?.turn.costUsd).toBeNull();
  });

  it("round-trips deltaReliable: false correctly (not coerced true by a truthy 0/1 bug)", () => {
    store.insertTurnMetric(record({ eventId: "evt-false", deltaReliable: false }));

    const [row] = store.listTurnMetrics();

    expect(row?.deltaReliable).toBe(false);
  });

  it("is idempotent by eventId — inserting the same event twice yields one row", () => {
    store.insertTurnMetric(record({ eventId: "evt-dup" }));
    store.insertTurnMetric(record({ eventId: "evt-dup" }));

    expect(store.listTurnMetrics()).toHaveLength(1);
  });

  it("keeps distinct rows for distinct eventIds", () => {
    store.insertTurnMetric(record({ eventId: "evt-1" }));
    store.insertTurnMetric(record({ eventId: "evt-2" }));

    expect(store.listTurnMetrics()).toHaveLength(2);
  });

  it("filters by sinceMs", () => {
    store.insertTurnMetric(record({ eventId: "evt-old", timestampMs: 1_000 }));
    store.insertTurnMetric(record({ eventId: "evt-new", timestampMs: 2_000_000 }));

    const rows = store.listTurnMetrics({ sinceMs: 1_000_000 });

    expect(rows.map((r) => r.eventId)).toEqual(["evt-new"]);
  });

  it("filters by agentPubkey", () => {
    store.insertTurnMetric(record({ eventId: "evt-a", agentPubkey: AGENT_A }));
    store.insertTurnMetric(record({ eventId: "evt-b", agentPubkey: AGENT_B }));

    const rows = store.listTurnMetrics({ agentPubkey: AGENT_B });

    expect(rows.map((r) => r.eventId)).toEqual(["evt-b"]);
  });

  it("returns rows ordered by timestampMs ascending", () => {
    store.insertTurnMetric(record({ eventId: "evt-second", timestampMs: 2_000 }));
    store.insertTurnMetric(record({ eventId: "evt-first", timestampMs: 1_000 }));

    const rows = store.listTurnMetrics();

    expect(rows.map((r) => r.eventId)).toEqual(["evt-first", "evt-second"]);
  });
});

describe("openCostStore (file-backed)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "buzz-fleet-cost-store-test-"));
    dbPath = join(dir, "cost.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists rows across a close and a fresh open of the same file", () => {
    const store1 = openCostStore(dbPath);
    store1.insertTurnMetric(record({ eventId: "evt-persisted" }));
    store1.close();

    const store2 = openCostStore(dbPath);
    try {
      expect(store2.listTurnMetrics().map((r) => r.eventId)).toEqual(["evt-persisted"]);
    } finally {
      store2.close();
    }
  });
});

// AC1: at least one REAL kind-44200 capture round-tripped through the real
// store, not just synthetic fixtures — see
// live-capture-44200-turn-metrics.meta.md for full provenance.
describe("openCostStore — real kind-44200 capture round-trip", () => {
  it("persists and reads back all three real captured records byte-for-byte", () => {
    const store = openCostStore(":memory:");
    try {
      const records = liveCapture44200 as TurnMetricRecord[];
      for (const record of records) {
        store.insertTurnMetric(record);
      }

      const rows = store.listTurnMetrics({ agentPubkey: records[0]?.agentPubkey });

      expect(rows).toHaveLength(3);
      // Order-independent equality — listTurnMetrics returns timestamp-sorted.
      expect([...rows].sort((a, b) => a.eventId.localeCompare(b.eventId))).toEqual(
        [...records].sort((a, b) => a.eventId.localeCompare(b.eventId)),
      );
    } finally {
      store.close();
    }
  });
});
