import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App";
import type { AgentBoardState } from "../src/ui/useAgentBoard";

const useAgentBoardMock = vi.fn<() => AgentBoardState>();

vi.mock("../src/ui/useAgentBoard", () => ({
  useAgentBoard: () => useAgentBoardMock(),
}));

const ROWS: AgentBoardState["rows"] = [
  {
    pubkey: "f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1",
    label: "gatekeeper",
    state: "alive",
    lastTransitionAt: 0,
    presenceLastSeenAt: 0,
    slots: [],
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App", () => {
  it("shows a loading indicator while the config/first poll is in flight", () => {
    useAgentBoardMock.mockReturnValue({ rows: [], now: 0, loading: true, error: null });

    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  it("renders the board once agents are classified", () => {
    useAgentBoardMock.mockReturnValue({ rows: ROWS, now: 1_000, loading: false, error: null });

    render(<App />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("gatekeeper")).toBeInTheDocument();
  });

  it("surfaces a poll/config error as an alert without hiding the last-known board", () => {
    useAgentBoardMock.mockReturnValue({
      rows: ROWS,
      now: 1_000,
      loading: false,
      error: "buzz relay http://localhost:3000/query: HTTP 503",
    });

    render(<App />);

    expect(screen.getByRole("alert")).toHaveTextContent(/503/);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});
