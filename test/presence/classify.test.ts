import { describe, expect, it } from "vitest";
import { classifyAgent, classifyRoster } from "../../src/presence/classify";
import type { AgentPresence, BridgePresenceEvent } from "../../src/presence/types";

const GATEKEEPER_PK =
  "f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1";
const RELAY_PK =
  "01c8ce850976fb93aac900a44f42568a140867579c85cde1e1176de0e3133bd5";

function makeEvent(content: string, createdAt = 1_785_000_000): BridgePresenceEvent {
  return {
    id: "test-event-id",
    pubkey: RELAY_PK,
    kind: 20001,
    created_at: createdAt,
    content,
    sig: "test-sig",
    tags: [["p", GATEKEEPER_PK]],
  };
}

const AGENT = { pubkey: GATEKEEPER_PK, label: "gatekeeper" };
const NOW = 1_785_000_500_000;

describe("classifyAgent", () => {
  it("marks an agent alive when the bridge returns content=online", () => {
    const result = classifyAgent({
      agent: AGENT,
      event: makeEvent("online"),
      previous: undefined,
      now: NOW,
    });

    expect(result).toEqual({
      pubkey: GATEKEEPER_PK,
      label: "gatekeeper",
      liveness: "alive",
      rawStatus: "online",
      lastSeenAt: NOW,
    });
  });

  it("marks an agent alive when the bridge returns content=away", () => {
    const result = classifyAgent({
      agent: AGENT,
      event: makeEvent("away"),
      previous: undefined,
      now: NOW,
    });

    expect(result.liveness).toBe("alive");
    expect(result.rawStatus).toBe("away");
    expect(result.lastSeenAt).toBe(NOW);
  });

  it("marks an agent dead when the bridge omits it from the response", () => {
    const result = classifyAgent({
      agent: AGENT,
      event: undefined,
      previous: undefined,
      now: NOW,
    });

    expect(result).toEqual({
      pubkey: GATEKEEPER_PK,
      label: "gatekeeper",
      liveness: "dead",
      rawStatus: null,
      lastSeenAt: null,
    });
  });

  it("preserves the previous lastSeenAt when an agent goes from alive to absent", () => {
    const previous: AgentPresence = {
      pubkey: GATEKEEPER_PK,
      label: "gatekeeper",
      liveness: "alive",
      rawStatus: "online",
      lastSeenAt: NOW - 20_000,
    };

    const result = classifyAgent({
      agent: AGENT,
      event: undefined,
      previous,
      now: NOW,
    });

    expect(result.liveness).toBe("dead");
    expect(result.lastSeenAt).toBe(NOW - 20_000);
  });

  it("treats content=offline as dead despite the key still being present", () => {
    // The relay deletes the Redis key outright when a client publishes
    // "offline" (buzz-relay handlers/event.rs) — a synthesized event should
    // never carry this content — but the classifier must not call it alive
    // if it ever does.
    const previous: AgentPresence = {
      pubkey: GATEKEEPER_PK,
      label: "gatekeeper",
      liveness: "alive",
      rawStatus: "online",
      lastSeenAt: NOW - 5_000,
    };

    const result = classifyAgent({
      agent: AGENT,
      event: makeEvent("offline"),
      previous,
      now: NOW,
    });

    expect(result.liveness).toBe("dead");
    expect(result.rawStatus).toBe("offline");
    expect(result.lastSeenAt).toBe(NOW - 5_000);
  });

  it("treats an unrecognized content string as dead but records it verbatim", () => {
    const result = classifyAgent({
      agent: AGENT,
      event: makeEvent("banana"),
      previous: undefined,
      now: NOW,
    });

    expect(result.liveness).toBe("dead");
    expect(result.rawStatus).toBe("banana");
  });

  it("carries no label through when the roster entry has none", () => {
    const result = classifyAgent({
      agent: { pubkey: GATEKEEPER_PK },
      event: makeEvent("online"),
      previous: undefined,
      now: NOW,
    });

    expect(result.label).toBeUndefined();
  });
});

describe("classifyRoster", () => {
  it("classifies every roster entry in order, using each agent's own event", () => {
    const otherPk =
      "0000000000000000000000000000000000000000000000000000000000000042";
    const roster = [AGENT, { pubkey: otherPk, label: "idle-agent" }];
    const eventsByPubkey = new Map([[GATEKEEPER_PK, makeEvent("online")]]);

    const result = classifyRoster({
      roster,
      eventsByPubkey,
      previousByPubkey: new Map(),
      now: NOW,
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ pubkey: GATEKEEPER_PK, liveness: "alive" });
    expect(result[1]).toMatchObject({ pubkey: otherPk, liveness: "dead" });
  });

  it("looks up each agent's previous state by pubkey", () => {
    const previous: AgentPresence = {
      pubkey: GATEKEEPER_PK,
      label: "gatekeeper",
      liveness: "alive",
      rawStatus: "online",
      lastSeenAt: NOW - 15_000,
    };

    const result = classifyRoster({
      roster: [AGENT],
      eventsByPubkey: new Map(),
      previousByPubkey: new Map([[GATEKEEPER_PK, previous]]),
      now: NOW,
    });

    expect(result[0]?.liveness).toBe("dead");
    expect(result[0]?.lastSeenAt).toBe(NOW - 15_000);
  });
});
