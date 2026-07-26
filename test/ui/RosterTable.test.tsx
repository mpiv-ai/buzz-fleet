import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RosterTable } from "../../src/ui/RosterTable";
import type { AgentBoardRow } from "../../src/turns/buildBoard";

const NOW = 200_000;

const PRESENCE_ONLY_ROWS: AgentBoardRow[] = [
  {
    pubkey: "f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1",
    label: "gatekeeper",
    state: "alive",
    lastTransitionAt: 195_000,
    presenceLastSeenAt: 199_000,
    slots: [],
  },
  {
    pubkey: "a".repeat(64),
    label: "watcher",
    state: "dead",
    lastTransitionAt: 100_000,
    presenceLastSeenAt: 5_000,
    slots: [],
  },
  {
    pubkey: "b".repeat(64),
    label: undefined,
    state: "dead",
    lastTransitionAt: 100_000,
    presenceLastSeenAt: null,
    slots: [],
  },
];

const ROW_WITH_SLOTS: AgentBoardRow[] = [
  {
    pubkey: "f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1",
    label: "gatekeeper",
    state: "wedged",
    lastTransitionAt: 130_000,
    presenceLastSeenAt: 199_000,
    slots: [
      {
        agentIndex: 0,
        state: "wedged",
        lastTransitionAt: 130_000,
        openTurn: { turnId: "turn-1", source: "channel", startedAt: 100_000, lastTickAt: 190_000 },
      },
      {
        agentIndex: 1,
        state: "alive",
        lastTransitionAt: 180_000,
        openTurn: null,
      },
    ],
  },
];

describe("RosterTable", () => {
  it("renders a row per agent with label, state badge, and ages", () => {
    render(<RosterTable rows={PRESENCE_ONLY_ROWS} now={NOW} />);

    expect(screen.getByText("gatekeeper")).toBeInTheDocument();
    expect(screen.getByText("watcher")).toBeInTheDocument();
    // No label: falls back to the raw pubkey.
    expect(screen.getByText("b".repeat(64))).toBeInTheDocument();
  });

  it("shows all six possible states via distinct, neutral badges", () => {
    const rows: AgentBoardRow[] = [
      { pubkey: "1".repeat(64), label: "a", state: "alive", lastTransitionAt: 0, presenceLastSeenAt: 0, slots: [] },
      { pubkey: "2".repeat(64), label: "b", state: "dead", lastTransitionAt: 0, presenceLastSeenAt: null, slots: [] },
      { pubkey: "3".repeat(64), label: "c", state: "crashed-mid-turn", lastTransitionAt: 0, presenceLastSeenAt: null, slots: [] },
      { pubkey: "4".repeat(64), label: "d", state: "wedged", lastTransitionAt: 0, presenceLastSeenAt: 0, slots: [] },
      { pubkey: "5".repeat(64), label: "e", state: "deaf", lastTransitionAt: 0, presenceLastSeenAt: 0, slots: [] },
      { pubkey: "6".repeat(64), label: "f", state: "swallowed", lastTransitionAt: 0, presenceLastSeenAt: 0, slots: [] },
    ];
    render(<RosterTable rows={rows} now={NOW} />);

    const badges = screen.getAllByTestId("badge");
    expect(badges.map((b) => b.getAttribute("data-state"))).toEqual([
      "alive",
      "dead",
      "crashed-mid-turn",
      "wedged",
      "deaf",
      "swallowed",
    ]);

    // Neutral copy throughout: never "fail"/"error"/"broken" even for
    // crashed-mid-turn (mirrors v0.1's "never editorialize dead" policy).
    for (const badge of badges) {
      expect(badge.textContent?.toLowerCase()).not.toMatch(/fail|broken/);
    }
  });

  it("shows a last-transition age per agent row", () => {
    render(<RosterTable rows={PRESENCE_ONLY_ROWS} now={NOW} />);

    // gatekeeper: NOW(200_000) - lastTransitionAt(195_000) = 5s
    expect(screen.getByText("5s ago")).toBeInTheDocument();
  });

  it("renders per-slot detail rows when lifecycle events expose slots", () => {
    render(<RosterTable rows={ROW_WITH_SLOTS} now={NOW} />);

    const slotRows = screen.getAllByTestId("slot-row");
    expect(slotRows).toHaveLength(2);
    expect(slotRows[0]).toHaveTextContent(/slot 0/i);
    expect(slotRows[0]).toHaveTextContent(/wedged/i);
    expect(slotRows[0]).toHaveTextContent(/turn-1/);
    expect(slotRows[0]).toHaveTextContent(/channel/i);
    expect(slotRows[1]).toHaveTextContent(/slot 1/i);
    expect(slotRows[1]).toHaveTextContent(/alive/i);
  });

  it("renders no slot-detail rows for an agent with no telemetry-exposed slots", () => {
    render(<RosterTable rows={PRESENCE_ONLY_ROWS} now={NOW} />);

    expect(screen.queryAllByTestId("slot-row")).toHaveLength(0);
  });

  it("shows an empty-roster message instead of an empty table when there are no agents", () => {
    render(<RosterTable rows={[]} now={NOW} />);

    expect(screen.getByRole("status")).toHaveTextContent(/no agents/i);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
