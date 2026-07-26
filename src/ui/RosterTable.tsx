import type { AgentPresence } from "../presence/types";
import { formatAge } from "./formatAge";

export interface RosterTableProps {
  agents: AgentPresence[];
  now: number;
}

/**
 * Roster rows: agent label, an alive/dead badge, and a last-seen age.
 *
 * The badge is deliberately neutral copy/styling for "dead" — never
 * "crashed" or "failed" — since a closed desktop window kills a fleet's
 * presence exactly as innocently as a real crash. See README > "How
 * liveness works".
 */
export function RosterTable({ agents, now }: RosterTableProps) {
  if (agents.length === 0) {
    return <p role="status">No agents configured. Check public/fleet.yaml.</p>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Agent</th>
          <th>Status</th>
          <th>Last seen</th>
        </tr>
      </thead>
      <tbody>
        {agents.map((agent) => (
          <tr key={agent.pubkey}>
            <td>{agent.label ?? agent.pubkey}</td>
            <td>
              <span data-testid="badge" data-liveness={agent.liveness}>
                {agent.liveness}
              </span>
            </td>
            <td>{formatAge(agent.lastSeenAt, now)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
