import { describe, expect, it, vi } from "vitest";
import {
  buildPresenceFilter,
  fetchPresence,
  parseBridgeResponse,
  subjectPubkeyOf,
} from "../../src/presence/bridge";
import type { BridgePresenceEvent } from "../../src/presence/types";
import bridgeResponseShape from "../fixtures/bridge-response-shape.json";
import mixedRosterResponse from "../fixtures/bridge-response-mixed-roster.json";
import liveCaptureResponse from "../fixtures/live-capture-gatekeeper-query-response.json";

const GATEKEEPER_PK =
  "f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1";
const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = "b".repeat(64);
const PUBKEY_C = "c".repeat(64);

function fixtureEvents(fixture: unknown): BridgePresenceEvent[] {
  return fixture as BridgePresenceEvent[];
}

describe("buildPresenceFilter", () => {
  it("builds a single kind-20001 filter with the given authors", () => {
    expect(buildPresenceFilter([PUBKEY_A, PUBKEY_B])).toEqual([
      { kinds: [20001], authors: [PUBKEY_A, PUBKEY_B] },
    ]);
  });
});

describe("subjectPubkeyOf", () => {
  it("reads the subject pubkey from the event's p tag", () => {
    const [event] = fixtureEvents(bridgeResponseShape);
    expect(subjectPubkeyOf(event!)).toBe(PUBKEY_A);
  });

  it("returns null when the event has no p tag", () => {
    const event: BridgePresenceEvent = {
      id: "x".repeat(64),
      pubkey: "y".repeat(64),
      kind: 20001,
      created_at: 0,
      content: "online",
      sig: "z".repeat(128),
      tags: [["e", "not-a-p-tag"]],
    };
    expect(subjectPubkeyOf(event)).toBeNull();
  });
});

describe("parseBridgeResponse", () => {
  it("parses a well-formed response array", () => {
    const events = parseBridgeResponse(mixedRosterResponse);
    expect(events).toHaveLength(2);
  });

  it("parses the live-captured single-agent response", () => {
    const events = parseBridgeResponse(liveCaptureResponse);
    expect(events).toEqual(fixtureEvents(liveCaptureResponse));
  });

  it("throws when the response is not an array", () => {
    expect(() => parseBridgeResponse({ not: "an array" })).toThrow(/array/i);
  });

  it("drops malformed entries instead of throwing on the whole batch", () => {
    const events = parseBridgeResponse([
      ...mixedRosterResponse,
      { content: "online" }, // missing id/pubkey/kind/sig/tags
    ]);
    expect(events).toHaveLength(2);
  });
});

describe("fetchPresence", () => {
  it("POSTs a kind-20001 filter to <relayUrl>/query with X-Pubkey auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mixedRosterResponse),
    });

    await fetchPresence(
      "http://localhost:3000",
      GATEKEEPER_PK,
      [PUBKEY_A, PUBKEY_B],
      fetchImpl as unknown as typeof fetch,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/query");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Pubkey"]).toBe(GATEKEEPER_PK);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual(
      buildPresenceFilter([PUBKEY_A, PUBKEY_B]),
    );
  });

  it("returns a Map keyed by subject pubkey, omitting agents absent from the response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mixedRosterResponse),
    });

    const result = await fetchPresence(
      "http://localhost:3000",
      GATEKEEPER_PK,
      [PUBKEY_A, PUBKEY_B, PUBKEY_C],
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.size).toBe(2);
    expect(result.get(PUBKEY_A)?.content).toBe("online");
    expect(result.get(PUBKEY_B)?.content).toBe("away");
    expect(result.has(PUBKEY_C)).toBe(false);
  });

  it("round-trips the live-captured gatekeeper response with full fidelity", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(liveCaptureResponse),
    });

    const result = await fetchPresence(
      "http://localhost:3000",
      GATEKEEPER_PK,
      [GATEKEEPER_PK],
      fetchImpl as unknown as typeof fetch,
    );

    const event = result.get(GATEKEEPER_PK);
    expect(event).toBeDefined();
    expect(event?.content).toBe("online");
    expect(event?.created_at).toBe(1785022598);
    expect(event?.id).toBe(
      "53d00b5f2ee895d5c2650f8c402ba6644be3f70ea7aaf2e7d06deb87dd09938e",
    );
  });

  it("throws a descriptive error when the relay responds non-200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });

    await expect(
      fetchPresence(
        "http://localhost:3000",
        GATEKEEPER_PK,
        [PUBKEY_A],
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/500/);
  });

  it("throws when the relay's response body is not a JSON array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ unexpected: true }),
    });

    await expect(
      fetchPresence(
        "http://localhost:3000",
        GATEKEEPER_PK,
        [PUBKEY_A],
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/array/i);
  });
});
