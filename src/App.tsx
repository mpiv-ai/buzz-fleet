import { RosterTable } from "./ui/RosterTable";
import { useAgentBoard } from "./ui/useAgentBoard";

export function App() {
  const { rows, now, loading, error } = useAgentBoard();

  return (
    <main>
      <h1>buzz-fleet</h1>
      {loading && <p role="status">Loading public/fleet.yaml…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && <RosterTable rows={rows} now={now} />}
    </main>
  );
}
