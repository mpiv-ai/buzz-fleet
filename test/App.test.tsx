import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App";
import type { FleetPresenceState } from "../src/ui/useFleetPresence";
import type { AgentPresence } from "../src/presence/types";

const useFleetPresenceMock = vi.fn<() => FleetPresenceState>();

vi.mock("../src/ui/useFleetPresence", () => ({
  useFleetPresence: () => useFleetPresenceMock(),
}));

const AGENTS: AgentPresence[] = [
  {
    pubkey: "f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1",
    label: "gatekeeper",
    liveness: "alive",
    rawStatus: "online",
    lastSeenAt: 0,
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App", () => {
  it("shows a loading indicator while the config/first poll is in flight", () => {
    useFleetPresenceMock.mockReturnValue({ agents: [], now: 0, loading: true, error: null });

    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  it("renders the roster table once agents are classified", () => {
    useFleetPresenceMock.mockReturnValue({ agents: AGENTS, now: 1_000, loading: false, error: null });

    render(<App />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("gatekeeper")).toBeInTheDocument();
  });

  it("surfaces a poll/config error as an alert without hiding the last-known roster", () => {
    useFleetPresenceMock.mockReturnValue({
      agents: AGENTS,
      now: 1_000,
      loading: false,
      error: "buzz relay http://localhost:3000/query: HTTP 503",
    });

    render(<App />);

    expect(screen.getByRole("alert")).toHaveTextContent(/503/);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});
