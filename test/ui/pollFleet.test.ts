import { describe, expect, it, vi } from "vitest";
import { pollFleet } from "../../src/ui/pollFleet";
import type { FleetConfig } from "../../src/config/types";
import type { AgentPresence, BridgePresenceEvent } from "../../src/presence/types";

const GATEKEEPER = "f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1";
const OTHER = "a".repeat(64);

function eventFor(pubkey: string, content: string): BridgePresenceEvent {
  return {
    id: "id",
    pubkey: "relay-signing-key",
    kind: 20001,
    created_at: 1700,
    content,
    sig: "sig",
    tags: [["p", pubkey]],
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  };
}

describe("pollFleet", () => {
  it("polls every relay and flattens classified results in relay/roster order", async () => {
    const config: FleetConfig = {
      relays: [
        {
          url: "http://localhost:3000",
          callerPubkey: GATEKEEPER,
          roster: [
            { pubkey: GATEKEEPER, label: "gatekeeper" },
            { pubkey: OTHER, label: "other" },
          ],
        },
      ],
      pollIntervalMs: 20_000,
      deadAfterMs: 90_000,
    };

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse([eventFor(GATEKEEPER, "online")]));

    const result = await pollFleet(
      config,
      new Map<string, AgentPresence>(),
      5_000,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ pubkey: GATEKEEPER, liveness: "alive", lastSeenAt: 5_000 });
    expect(result[1]).toMatchObject({ pubkey: OTHER, liveness: "dead", lastSeenAt: null });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:3000/query",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("carries forward previous lastSeenAt for an agent that drops out", async () => {
    const config: FleetConfig = {
      relays: [
        {
          url: "http://localhost:3000",
          callerPubkey: GATEKEEPER,
          roster: [{ pubkey: GATEKEEPER, label: "gatekeeper" }],
        },
      ],
      pollIntervalMs: 20_000,
      deadAfterMs: 90_000,
    };

    const previous = new Map<string, AgentPresence>([
      [
        GATEKEEPER,
        { pubkey: GATEKEEPER, label: "gatekeeper", liveness: "alive", rawStatus: "online", lastSeenAt: 1_000 },
      ],
    ]);

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));

    const result = await pollFleet(config, previous, 10_000, fetchImpl as unknown as typeof fetch);

    expect(result[0]).toMatchObject({ liveness: "dead", lastSeenAt: 1_000 });
  });

  it("queries multiple relays independently and preserves relay order", async () => {
    const config: FleetConfig = {
      relays: [
        {
          url: "http://relay-a:3000",
          callerPubkey: GATEKEEPER,
          roster: [{ pubkey: GATEKEEPER, label: "a-gatekeeper" }],
        },
        {
          url: "http://relay-b:3000",
          callerPubkey: OTHER,
          roster: [{ pubkey: OTHER, label: "b-agent" }],
        },
      ],
      pollIntervalMs: 20_000,
      deadAfterMs: 90_000,
    };

    const fetchImpl = vi.fn((url: string) => {
      if (url.startsWith("http://relay-a")) {
        return Promise.resolve(jsonResponse([eventFor(GATEKEEPER, "online")]));
      }
      return Promise.resolve(jsonResponse([eventFor(OTHER, "away")]));
    });

    const result = await pollFleet(
      config,
      new Map<string, AgentPresence>(),
      2_000,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.map((a) => a.label)).toEqual(["a-gatekeeper", "b-agent"]);
    expect(result.every((a) => a.liveness === "alive")).toBe(true);
  });
});
