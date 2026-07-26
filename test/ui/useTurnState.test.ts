import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTurnState } from "../../src/ui/useTurnState";
import type { TurnsSnapshot } from "../../src/server/turnsDaemon";

const fetchTurnStateMock = vi.fn();

vi.mock("../../src/ui/fetchTurnState", () => ({
  fetchTurnState: (...args: unknown[]) => fetchTurnStateMock(...args),
}));

const SNAPSHOT_A: TurnsSnapshot = {
  relays: [
    {
      configuredUrl: "http://localhost:3000",
      wsUrl: "ws://localhost:3000",
      status: "connected",
      lastNotice: null,
      ownerPubkey: "f".repeat(64),
      agents: [],
    },
  ],
};
const SNAPSHOT_B: TurnsSnapshot = {
  relays: [
    {
      configuredUrl: "http://localhost:3000",
      wsUrl: "ws://localhost:3000",
      status: "reconnecting",
      lastNotice: null,
      ownerPubkey: "f".repeat(64),
      agents: [],
    },
  ],
};

beforeEach(() => {
  fetchTurnStateMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useTurnState", () => {
  it("fetches once immediately and exposes the snapshot", async () => {
    fetchTurnStateMock.mockResolvedValue(SNAPSHOT_A);

    const { result, unmount } = renderHook(() => useTurnState("/turns-state.json", 15));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.snapshot).toEqual(SNAPSHOT_A);
    expect(result.current.error).toBeNull();
    expect(fetchTurnStateMock).toHaveBeenCalledWith("/turns-state.json");
    unmount();
  });

  it("re-polls on the configured interval and updates the snapshot", async () => {
    fetchTurnStateMock.mockResolvedValueOnce(SNAPSHOT_A).mockResolvedValue(SNAPSHOT_B);

    const { result, unmount } = renderHook(() => useTurnState("/turns-state.json", 15));

    await waitFor(() => expect(result.current.snapshot).toEqual(SNAPSHOT_B));
    expect(fetchTurnStateMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    unmount();
  });

  it("surfaces a fetch error while keeping the last-known snapshot", async () => {
    fetchTurnStateMock.mockResolvedValueOnce(SNAPSHOT_A).mockRejectedValue(new Error("daemon down"));

    const { result, unmount } = renderHook(() => useTurnState("/turns-state.json", 15));

    await waitFor(() => expect(result.current.snapshot).toEqual(SNAPSHOT_A));
    await waitFor(() => expect(result.current.error).toMatch(/daemon down/));

    expect(result.current.snapshot).toEqual(SNAPSHOT_A);
    unmount();
  });

  it("stops polling after unmount", async () => {
    fetchTurnStateMock.mockResolvedValue(SNAPSHOT_A);

    const { result, unmount } = renderHook(() => useTurnState("/turns-state.json", 15));
    await waitFor(() => expect(result.current.loading).toBe(false));

    unmount();
    const callsAtUnmount = fetchTurnStateMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 45));

    expect(fetchTurnStateMock.mock.calls.length).toBe(callsAtUnmount);
  });
});
