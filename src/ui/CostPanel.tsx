import type { CostSnapshot } from "../server/turnsDaemon";

export interface CostPanelProps {
  /** `null` before the turns daemon has been polled at all (v0.1/v0.2
   * relays, or the very first load) — renders nothing, same graceful
   * fallback posture as `buildBoard.ts`'s presence-only rows. */
  cost: CostSnapshot | null;
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function formatBucketStart(bucketStartMs: number): string {
  return new Date(bucketStartMs).toISOString();
}

/**
 * v0.3 cost panel — per-agent AND fleet-total token/cost trends from stored
 * kind-44200 history (see `src/cost/`). Deliberately structured so the
 * FLEET-WIDE trend is the primary, always-visible content and the
 * per-agent breakdown is a secondary, collapsed drill-down (a real
 * `<details>`, not just a smaller table) — Block's own desktop app already
 * ships a per-agent local usage breakdown by (harness, model) (PR #2790);
 * buzz-fleet's differentiator is CROSS-AGENT, cross-community aggregation
 * on the same stream, so that's what gets the prominent slot. See
 * `docs/teardown2-claims-map.md` row (g).
 */
export function CostPanel({ cost }: CostPanelProps) {
  if (!cost) {
    return null;
  }

  if (cost.perAgent.length === 0) {
    return (
      <section aria-label="Cost">
        <h2>Cost</h2>
        <p role="status">
          No turn-cost history yet (kind 44200). Configure an ownerKeyFile/ownerKeyEnv relay to
          start collecting it.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Cost">
      <h2>Cost</h2>
      <dl className="fleet-total">
        <div>
          <dt>Agents</dt>
          <dd>{cost.fleetTotal.agentCount}</dd>
        </div>
        <div>
          <dt>Turns</dt>
          <dd>{cost.fleetTotal.turnCount}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{formatTokens(cost.fleetTotal.totalTokens)}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{formatUsd(cost.fleetTotal.totalCostUsd)}</dd>
        </div>
      </dl>

      <h3>Fleet trend</h3>
      {cost.trend.length === 0 ? (
        <p role="status">Not enough history yet to chart a trend.</p>
      ) : (
        <table aria-label="Fleet trend">
          <thead>
            <tr>
              <th>Bucket start</th>
              <th>Turns</th>
              <th>Tokens</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {cost.trend.map((point) => (
              <tr key={point.bucketStartMs}>
                <td>{formatBucketStart(point.bucketStartMs)}</td>
                <td>{point.turnCount}</td>
                <td>{formatTokens(point.totalTokens)}</td>
                <td>{formatUsd(point.totalCostUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <details>
        <summary>Per-agent breakdown</summary>
        <table aria-label="Per-agent cost">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Turns</th>
              <th>Tokens</th>
              <th>Cost</th>
              <th>Latest cumulative (session)</th>
            </tr>
          </thead>
          <tbody>
            {cost.perAgent.map((agent) => (
              <tr key={agent.agentPubkey}>
                <td>{agent.label ?? agent.agentPubkey}</td>
                <td>{agent.turnCount}</td>
                <td>{formatTokens(agent.totalTokens)}</td>
                <td>{formatUsd(agent.totalCostUsd)}</td>
                <td>
                  {agent.latestCumulative?.totalTokens !== null &&
                  agent.latestCumulative?.totalTokens !== undefined
                    ? formatTokens(agent.latestCumulative.totalTokens)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
