import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StopReason, TokenCounts, TurnMetricRecord } from "./types";
import { foldStopReason } from "./types";

/**
 * SQLite-backed persistence for decoded kind-44200 turn metrics
 * (daemon-side only — Node, never the browser). Uses the built-in
 * `node:sqlite` module rather than a third-party dependency: empirically
 * verified present and usable (unflagged, `DatabaseSync`/`StatementSync`,
 * only an `ExperimentalWarning`) on the installed Node v22.22.3 — see
 * `docs/teardown2-claims-map.md` and `package.json`'s `engines` field,
 * which pins `>=22.12.0` (the version `node:sqlite` first shipped
 * unflagged). Per the doc-first rule, the API used below (`exec`,
 * `prepare`, `.run`/`.all`) was confirmed against the installed module
 * itself, not from training-data memory.
 *
 * Kind 44200 is durable and regular (never replaced) — `eventId` (the
 * Nostr event id) is therefore a stable, permanent dedup key: a daemon
 * restart that resubscribes with a `since` reaching back into already-seen
 * history re-delivers the same events, and `INSERT OR IGNORE` makes
 * re-inserting them a no-op rather than double-counting usage.
 */

function toIntOrNull(value: number | null): number | null {
  return value === null ? null : Math.trunc(value);
}

interface TurnMetricRow {
  event_id: string;
  agent_pubkey: string;
  harness: string;
  model: string | null;
  channel_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  turn_seq: number | null;
  timestamp_ms: number;
  turn_input_tokens: number | null;
  turn_output_tokens: number | null;
  turn_total_tokens: number | null;
  turn_cost_usd: number | null;
  cumulative_input_tokens: number | null;
  cumulative_output_tokens: number | null;
  cumulative_total_tokens: number | null;
  cumulative_cost_usd: number | null;
  delta_reliable: number;
  stop_reason: string;
}

function isTurnMetricRow(value: unknown): value is TurnMetricRow {
  return typeof value === "object" && value !== null && "event_id" in value;
}

function rowToRecord(row: unknown): TurnMetricRecord {
  if (!isTurnMetricRow(row)) {
    throw new Error("cost store: unexpected row shape from SQLite");
  }
  const turn: TokenCounts = {
    inputTokens: row.turn_input_tokens,
    outputTokens: row.turn_output_tokens,
    totalTokens: row.turn_total_tokens,
    costUsd: row.turn_cost_usd,
  };
  const cumulative: TokenCounts = {
    inputTokens: row.cumulative_input_tokens,
    outputTokens: row.cumulative_output_tokens,
    totalTokens: row.cumulative_total_tokens,
    costUsd: row.cumulative_cost_usd,
  };
  return {
    eventId: row.event_id,
    agentPubkey: row.agent_pubkey,
    harness: row.harness,
    model: row.model,
    channelId: row.channel_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    turnSeq: row.turn_seq,
    timestampMs: row.timestamp_ms,
    turn,
    cumulative,
    deltaReliable: row.delta_reliable === 1,
    stopReason: foldStopReason(row.stop_reason) as StopReason,
  };
}

export interface ListTurnMetricsOptions {
  sinceMs?: number;
  agentPubkey?: string;
}

export interface CostStore {
  insertTurnMetric(record: TurnMetricRecord): void;
  listTurnMetrics(options?: ListTurnMetricsOptions): TurnMetricRecord[];
  close(): void;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS turn_metrics (
  event_id TEXT PRIMARY KEY,
  agent_pubkey TEXT NOT NULL,
  harness TEXT NOT NULL,
  model TEXT,
  channel_id TEXT,
  session_id TEXT,
  turn_id TEXT,
  turn_seq INTEGER,
  timestamp_ms INTEGER NOT NULL,
  turn_input_tokens INTEGER,
  turn_output_tokens INTEGER,
  turn_total_tokens INTEGER,
  turn_cost_usd REAL,
  cumulative_input_tokens INTEGER,
  cumulative_output_tokens INTEGER,
  cumulative_total_tokens INTEGER,
  cumulative_cost_usd REAL,
  delta_reliable INTEGER NOT NULL,
  stop_reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_metrics_agent_ts ON turn_metrics(agent_pubkey, timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_turn_metrics_ts ON turn_metrics(timestamp_ms);
`;

/** Open (creating if needed) a cost store at `path` — pass `":memory:"` for
 * an ephemeral in-process store (tests), or a real file path for durable
 * daemon-side persistence. For a real path, the parent directory is created
 * if missing (SQLite creates the database FILE itself but not missing
 * parent directories — confirmed empirically against the installed
 * node:sqlite). */
export function openCostStore(path: string): CostStore {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_SQL);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO turn_metrics (
      event_id, agent_pubkey, harness, model, channel_id, session_id, turn_id,
      turn_seq, timestamp_ms,
      turn_input_tokens, turn_output_tokens, turn_total_tokens, turn_cost_usd,
      cumulative_input_tokens, cumulative_output_tokens, cumulative_total_tokens, cumulative_cost_usd,
      delta_reliable, stop_reason
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?
    )
  `);

  return {
    insertTurnMetric(record: TurnMetricRecord): void {
      insertStmt.run(
        record.eventId,
        record.agentPubkey,
        record.harness,
        record.model,
        record.channelId,
        record.sessionId,
        record.turnId,
        toIntOrNull(record.turnSeq),
        Math.trunc(record.timestampMs),
        toIntOrNull(record.turn.inputTokens),
        toIntOrNull(record.turn.outputTokens),
        toIntOrNull(record.turn.totalTokens),
        record.turn.costUsd,
        toIntOrNull(record.cumulative.inputTokens),
        toIntOrNull(record.cumulative.outputTokens),
        toIntOrNull(record.cumulative.totalTokens),
        record.cumulative.costUsd,
        record.deltaReliable ? 1 : 0,
        record.stopReason,
      );
    },

    listTurnMetrics(options: ListTurnMetricsOptions = {}): TurnMetricRecord[] {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (options.sinceMs !== undefined) {
        clauses.push("timestamp_ms >= ?");
        params.push(Math.trunc(options.sinceMs));
      }
      if (options.agentPubkey !== undefined) {
        clauses.push("agent_pubkey = ?");
        params.push(options.agentPubkey);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(`SELECT * FROM turn_metrics ${where} ORDER BY timestamp_ms ASC`)
        .all(...params);
      return rows.map(rowToRecord);
    },

    close(): void {
      db.close();
    },
  };
}
