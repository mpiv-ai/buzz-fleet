import { RosterTable } from "./ui/RosterTable";
import { useFleetPresence } from "./ui/useFleetPresence";

export function App() {
  const { agents, now, loading, error } = useFleetPresence();

  return (
    <main>
      <h1>buzz-fleet</h1>
      {loading && <p role="status">Loading public/fleet.yaml…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && <RosterTable agents={agents} now={now} />}
    </main>
  );
}
