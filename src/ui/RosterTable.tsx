import type { AgentBoardRow, SlotBoardRow } from "../turns/buildBoard";
import { formatAge } from "./formatAge";

export interface RosterTableProps {
  rows: AgentBoardRow[];
  now: number;
}

function SlotRow({ slot, now }: { slot: SlotBoardRow; now: number }) {
  return (
    <tr data-testid="slot-row">
      <td className="slot-cell">Slot {slot.agentIndex}</td>
      <td>
        <span data-testid="badge" data-state={slot.state}>
          {slot.state}
        </span>
      </td>
      <td>{formatAge(slot.lastTransitionAt, now)}</td>
      <td>
        {slot.openTurn
          ? `turn ${slot.openTurn.turnId ?? "(unknown)"} (${slot.openTurn.source})`
          : "—"}
      </td>
    </tr>
  );
}

/**
 * v0.2 board: one row per roster agent showing its rolled-up six-state
 * badge and last-transition age, plus presence's own last-seen age for
 * continuity with v0.1. Wherever lifecycle events expose per-slot detail
 * (`row.slots`), each slot gets its own row underneath — empty for a relay
 * with no owner key configured, so a v0.1-only relay renders exactly as it
 * did before this feature existed.
 *
 * Badge copy is deliberately neutral for every state, "dead" included —
 * never "crashed"/"failed"/"broken" — see README > "How liveness works".
 */
export function RosterTable({ rows, now }: RosterTableProps) {
  if (rows.length === 0) {
    return <p role="status">No agents configured. Check public/fleet.yaml.</p>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Agent</th>
          <th>State</th>
          <th>Since</th>
          <th>Last seen</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <RowGroup key={row.pubkey} row={row} now={now} />
        ))}
      </tbody>
    </table>
  );
}

function RowGroup({ row, now }: { row: AgentBoardRow; now: number }) {
  return (
    <>
      <tr>
        <td>{row.label ?? row.pubkey}</td>
        <td>
          <span data-testid="badge" data-state={row.state}>
            {row.state}
          </span>
        </td>
        <td>{formatAge(row.lastTransitionAt, now)}</td>
        <td>{formatAge(row.presenceLastSeenAt, now)}</td>
      </tr>
      {row.slots.map((slot) => (
        <SlotRow key={slot.agentIndex} slot={slot} now={now} />
      ))}
    </>
  );
}
