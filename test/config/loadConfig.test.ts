import { describe, expect, it, vi } from "vitest";
import { parseConfig, loadConfig, DEFAULT_POLL_INTERVAL_MS, DEFAULT_DEAD_AFTER_MS } from "../../src/config/loadConfig";

const GATEKEEPER_PK =
  "f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1";

const VALID_YAML = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${GATEKEEPER_PK}
    roster:
      - pubkey: ${GATEKEEPER_PK}
        label: gatekeeper
pollIntervalMs: 20000
deadAfterMs: 90000
`;

describe("parseConfig", () => {
  it("parses a valid fleet.yaml into a FleetConfig", () => {
    const config = parseConfig(VALID_YAML);

    expect(config.relays).toHaveLength(1);
    expect(config.relays[0]).toEqual({
      url: "http://localhost:3000",
      callerPubkey: GATEKEEPER_PK,
      roster: [{ pubkey: GATEKEEPER_PK, label: "gatekeeper" }],
    });
    expect(config.pollIntervalMs).toBe(20000);
    expect(config.deadAfterMs).toBe(90000);
  });

  it("applies default pollIntervalMs and deadAfterMs when omitted", () => {
    const yaml = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${GATEKEEPER_PK}
    roster:
      - pubkey: ${GATEKEEPER_PK}
`;
    const config = parseConfig(yaml);

    expect(config.pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(config.deadAfterMs).toBe(DEFAULT_DEAD_AFTER_MS);
  });

  it("allows a roster entry with no label", () => {
    const yaml = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${GATEKEEPER_PK}
    roster:
      - pubkey: ${GATEKEEPER_PK}
`;
    const config = parseConfig(yaml);

    expect(config.relays[0]?.roster[0]).toEqual({ pubkey: GATEKEEPER_PK });
  });

  it("lowercases pubkeys and callerPubkey for normalization", () => {
    const upper = GATEKEEPER_PK.toUpperCase();
    const yaml = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${upper}
    roster:
      - pubkey: ${upper}
`;
    const config = parseConfig(yaml);

    expect(config.relays[0]?.callerPubkey).toBe(GATEKEEPER_PK);
    expect(config.relays[0]?.roster[0]?.pubkey).toBe(GATEKEEPER_PK);
  });

  it("throws when relays is missing", () => {
    expect(() => parseConfig("pollIntervalMs: 1000\n")).toThrow(/relays/i);
  });

  it("throws when relays is an empty array", () => {
    expect(() => parseConfig("relays: []\n")).toThrow(/relays/i);
  });

  it("throws when a relay has no roster entries", () => {
    const yaml = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${GATEKEEPER_PK}
    roster: []
`;
    expect(() => parseConfig(yaml)).toThrow(/roster/i);
  });

  it("throws when a relay url is not a valid absolute URL", () => {
    const yaml = `
relays:
  - url: "not-a-url"
    callerPubkey: ${GATEKEEPER_PK}
    roster:
      - pubkey: ${GATEKEEPER_PK}
`;
    expect(() => parseConfig(yaml)).toThrow(/url/i);
  });

  it("throws when a pubkey is not 64 hex characters", () => {
    const yaml = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${GATEKEEPER_PK}
    roster:
      - pubkey: deadbeef
`;
    expect(() => parseConfig(yaml)).toThrow(/pubkey/i);
  });

  it("throws when callerPubkey is not 64 hex characters", () => {
    const yaml = `
relays:
  - url: http://localhost:3000
    callerPubkey: not-hex
    roster:
      - pubkey: ${GATEKEEPER_PK}
`;
    expect(() => parseConfig(yaml)).toThrow(/callerPubkey/i);
  });

  it("throws on malformed YAML", () => {
    expect(() => parseConfig("relays: [\n")).toThrow();
  });

  it("throws when the document root is not an object", () => {
    expect(() => parseConfig("- just\n- a\n- list\n")).toThrow(/object/i);
  });
});

describe("loadConfig", () => {
  it("fetches the given URL and parses it as a FleetConfig", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(VALID_YAML),
    });

    const config = await loadConfig("/fleet.yaml", fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith("/fleet.yaml");
    expect(config.relays[0]?.roster[0]?.label).toBe("gatekeeper");
  });

  it("throws a descriptive error when the fetch response is not ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve(""),
    });

    await expect(
      loadConfig("/fleet.yaml", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/404/);
  });
});
