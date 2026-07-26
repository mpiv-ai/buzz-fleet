import { describe, expect, it, vi } from "vitest";
import { fetchTurnState } from "../../src/ui/fetchTurnState";

const VALID_SNAPSHOT = {
  relays: [
    {
      configuredUrl: "http://localhost:3000",
      wsUrl: "ws://localhost:3000",
      status: "connected",
      lastNotice: null,
      ownerPubkey: "f".repeat(64),
      agents: [{ pubkey: "a".repeat(64), label: "gatekeeper", events: [] }],
    },
  ],
};

describe("fetchTurnState", () => {
  it("fetches the given URL and returns the parsed snapshot", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(VALID_SNAPSHOT),
    });

    const snapshot = await fetchTurnState("/turns-state.json", fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith("/turns-state.json");
    expect(snapshot).toEqual(VALID_SNAPSHOT);
  });

  it("throws a descriptive error when the response is not ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });

    await expect(
      fetchTurnState("/turns-state.json", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/500/);
  });

  it("throws when the response body doesn't look like a TurnsSnapshot", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ not: "a snapshot" }),
    });

    await expect(
      fetchTurnState("/turns-state.json", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/malformed/i);
  });
});
