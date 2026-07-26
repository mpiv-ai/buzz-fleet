import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CostPanel } from "../../src/ui/CostPanel";
import type { CostSnapshot } from "../../src/server/turnsDaemon";

const PK_A = "a".repeat(64);
const PK_B = "b".repeat(64);

const SNAPSHOT: CostSnapshot = {
  perAgent: [
    {
      agentPubkey: PK_A,
      label: "gatekeeper",
      turnCount: 5,
      totalTokens: 12_345,
      totalCostUsd: 1.2345,
      latestCumulative: { inputTokens: 900, outputTokens: 400, totalTokens: 1300, costUsd: 0.5 },
    },
    {
      agentPubkey: PK_B,
      label: undefined,
      turnCount: 2,
      totalTokens: 500,
      totalCostUsd: 0.05,
      latestCumulative: null,
    },
  ],
  fleetTotal: { agentCount: 2, turnCount: 7, totalTokens: 12_845, totalCostUsd: 1.2845 },
  trend: [
    { bucketStartMs: 1_785_000_000_000, turnCount: 3, totalTokens: 6_000, totalCostUsd: 0.6 },
    { bucketStartMs: 1_785_003_600_000, turnCount: 4, totalTokens: 6_845, totalCostUsd: 0.6845 },
  ],
};

describe("CostPanel", () => {
  it("renders nothing when there is no snapshot yet (daemon not polled)", () => {
    const { container } = render(<CostPanel cost={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an explanatory empty state when no agent has any cost history yet", () => {
    render(
      <CostPanel
        cost={{
          perAgent: [],
          fleetTotal: { agentCount: 0, turnCount: 0, totalTokens: 0, totalCostUsd: 0 },
          trend: [],
        }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/no turn-cost history/i);
  });

  it("renders the fleet-total summary figures", () => {
    const { container } = render(<CostPanel cost={SNAPSHOT} />);

    const fleetTotal = container.querySelector(".fleet-total");
    expect(fleetTotal).toBeInTheDocument();
    if (!fleetTotal) return;
    expect(within(fleetTotal as HTMLElement).getByText("2")).toBeInTheDocument(); // agentCount
    expect(within(fleetTotal as HTMLElement).getByText("7")).toBeInTheDocument(); // turnCount
    expect(within(fleetTotal as HTMLElement).getByText("12,845")).toBeInTheDocument(); // totalTokens
    expect(within(fleetTotal as HTMLElement).getByText("$1.2845")).toBeInTheDocument(); // totalCostUsd
  });

  it("renders one trend row per bucket, fleet-wide (not split by agent)", () => {
    render(<CostPanel cost={SNAPSHOT} />);

    const trendTable = screen.getByRole("table", { name: /fleet trend/i });
    expect(trendTable).toBeInTheDocument();
    expect(within(trendTable).getAllByRole("row")).toHaveLength(3); // header + 2 buckets
  });

  it("renders per-agent rows inside a collapsed drill-down, secondary to the fleet trend", () => {
    render(<CostPanel cost={SNAPSHOT} />);

    const details = screen.getByText(/per-agent/i).closest("details");
    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("gatekeeper")).toBeInTheDocument();
    expect(screen.getByText(PK_B)).toBeInTheDocument(); // falls back to pubkey when no label
  });

  it("puts the fleet trend before the per-agent drill-down in document order (fleet-level is the point)", () => {
    render(<CostPanel cost={SNAPSHOT} />);

    const trendTable = screen.getByRole("table", { name: /fleet trend/i });
    const perAgentDetails = screen.getByText(/per-agent/i).closest("details");
    expect(perAgentDetails).toBeInTheDocument();
    if (!perAgentDetails) return;

    // DOCUMENT_POSITION_FOLLOWING (4) means trendTable comes before perAgentDetails.
    const position = trendTable.compareDocumentPosition(perAgentDetails);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
