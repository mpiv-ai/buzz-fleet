import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RosterTable } from "../../src/ui/RosterTable";
import type { AgentPresence } from "../../src/presence/types";

const NOW = 100_000;

const AGENTS: AgentPresence[] = [
  {
    pubkey: "f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1",
    label: "gatekeeper",
    liveness: "alive",
    rawStatus: "online",
    lastSeenAt: 95_000,
  },
  {
    pubkey: "a".repeat(64),
    label: "watcher",
    liveness: "dead",
    rawStatus: null,
    lastSeenAt: 5_000,
  },
  {
    pubkey: "b".repeat(64),
    liveness: "dead",
    rawStatus: null,
    lastSeenAt: null,
  },
];

describe("RosterTable", () => {
  it("renders a row per agent with label, liveness badge, and last-seen age", () => {
    render(<RosterTable agents={AGENTS} now={NOW} />);

    expect(screen.getByText("gatekeeper")).toBeInTheDocument();
    expect(screen.getByText("watcher")).toBeInTheDocument();
    // No label: falls back to the raw pubkey.
    expect(screen.getByText("b".repeat(64))).toBeInTheDocument();

    expect(screen.getByText("5s ago")).toBeInTheDocument();
    expect(screen.getByText("never")).toBeInTheDocument();
  });

  it("marks alive vs dead agents with distinct, neutral badges", () => {
    render(<RosterTable agents={AGENTS} now={NOW} />);

    const badges = screen.getAllByTestId("badge");
    expect(badges).toHaveLength(3);
    expect(badges[0]).toHaveAttribute("data-liveness", "alive");
    expect(badges[1]).toHaveAttribute("data-liveness", "dead");
    expect(badges[2]).toHaveAttribute("data-liveness", "dead");

    // Neutral copy: never "crashed"/"failed"/"error" for a dead agent.
    for (const badge of badges) {
      expect(badge.textContent?.toLowerCase()).not.toMatch(/crash|fail|error/);
    }
  });

  it("shows an empty-roster message instead of an empty table when there are no agents", () => {
    render(<RosterTable agents={[]} now={NOW} />);

    expect(screen.getByRole("status")).toHaveTextContent(/no agents/i);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
