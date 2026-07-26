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

  it("accepts a root-relative relay url for reverse-proxied deployments", () => {
    // Some relay builds don't emit browser CORS headers on /query (see
    // README > "Browser CORS"); a root-relative url lets a relay be reached
    // through a same-origin dev/reverse proxy instead of its real origin.
    const yaml = `
relays:
  - url: "/relay-proxy"
    callerPubkey: ${GATEKEEPER_PK}
    roster:
      - pubkey: ${GATEKEEPER_PK}
`;
    const config = parseConfig(yaml);

    expect(config.relays[0]?.url).toBe("/relay-proxy");
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

  describe("v0.2 — ownerKeyFile / ownerKeyEnv", () => {
    it("has neither owner key field by default (v0.1 relays keep working unchanged)", () => {
      const config = parseConfig(VALID_YAML);
      expect(config.relays[0]?.ownerKeyFile).toBeUndefined();
      expect(config.relays[0]?.ownerKeyEnv).toBeUndefined();
    });

    it("accepts ownerKeyFile as a plain file path", () => {
      const yaml = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${GATEKEEPER_PK}
    ownerKeyFile: /Users/michaelisaac/dev/buzz-local/owner.key
    roster:
      - pubkey: ${GATEKEEPER_PK}
`;
      const config = parseConfig(yaml);
      expect(config.relays[0]?.ownerKeyFile).toBe(
        "/Users/michaelisaac/dev/buzz-local/owner.key",
      );
      expect(config.relays[0]?.ownerKeyEnv).toBeUndefined();
    });

    it("accepts ownerKeyEnv as an env var name", () => {
      const yaml = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${GATEKEEPER_PK}
    ownerKeyEnv: BUZZ_FLEET_OWNER_KEY_MAIN
    roster:
      - pubkey: ${GATEKEEPER_PK}
`;
      const config = parseConfig(yaml);
      expect(config.relays[0]?.ownerKeyEnv).toBe("BUZZ_FLEET_OWNER_KEY_MAIN");
      expect(config.relays[0]?.ownerKeyFile).toBeUndefined();
    });

    it("throws when both ownerKeyFile and ownerKeyEnv are set on the same relay", () => {
      const yaml = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${GATEKEEPER_PK}
    ownerKeyFile: /path/to/owner.key
    ownerKeyEnv: BUZZ_FLEET_OWNER_KEY_MAIN
    roster:
      - pubkey: ${GATEKEEPER_PK}
`;
      expect(() => parseConfig(yaml)).toThrow(/ownerKeyFile.*ownerKeyEnv|ownerKeyEnv.*ownerKeyFile/i);
    });

    it("throws when ownerKeyEnv looks like an actual hex private key rather than a variable name", () => {
      // The one mistake this field exists to make structurally impossible:
      // key material pasted into committed config instead of a name.
      const yaml = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${GATEKEEPER_PK}
    ownerKeyEnv: ${GATEKEEPER_PK}
    roster:
      - pubkey: ${GATEKEEPER_PK}
`;
      expect(() => parseConfig(yaml)).toThrow(/looks like a key/i);
    });

    it("throws when ownerKeyEnv looks like an nsec-encoded private key", () => {
      const yaml = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${GATEKEEPER_PK}
    ownerKeyEnv: nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq
    roster:
      - pubkey: ${GATEKEEPER_PK}
`;
      expect(() => parseConfig(yaml)).toThrow(/looks like a key/i);
    });

    it("throws when ownerKeyEnv is not a valid identifier", () => {
      const yaml = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${GATEKEEPER_PK}
    ownerKeyEnv: "not an env var name!"
    roster:
      - pubkey: ${GATEKEEPER_PK}
`;
      expect(() => parseConfig(yaml)).toThrow(/ownerKeyEnv/i);
    });

    it("throws when ownerKeyFile is an empty string", () => {
      const yaml = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${GATEKEEPER_PK}
    ownerKeyFile: ""
    roster:
      - pubkey: ${GATEKEEPER_PK}
`;
      expect(() => parseConfig(yaml)).toThrow(/ownerKeyFile/i);
    });
  });

  describe("v0.2 — wsUrl", () => {
    it("has no wsUrl by default", () => {
      const config = parseConfig(VALID_YAML);
      expect(config.relays[0]?.wsUrl).toBeUndefined();
    });

    it("accepts a ws:// wsUrl", () => {
      const yaml = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${GATEKEEPER_PK}
    wsUrl: ws://localhost:3000
    roster:
      - pubkey: ${GATEKEEPER_PK}
`;
      const config = parseConfig(yaml);
      expect(config.relays[0]?.wsUrl).toBe("ws://localhost:3000");
    });

    it("accepts a wss:// wsUrl", () => {
      const yaml = `
relays:
  - url: "/relay-proxy"
    callerPubkey: ${GATEKEEPER_PK}
    wsUrl: wss://relay.example.com
    roster:
      - pubkey: ${GATEKEEPER_PK}
`;
      const config = parseConfig(yaml);
      expect(config.relays[0]?.wsUrl).toBe("wss://relay.example.com");
    });

    it("throws when wsUrl does not use the ws(s) scheme", () => {
      const yaml = `
relays:
  - url: http://localhost:3000
    callerPubkey: ${GATEKEEPER_PK}
    wsUrl: http://localhost:3000
    roster:
      - pubkey: ${GATEKEEPER_PK}
`;
      expect(() => parseConfig(yaml)).toThrow(/wsUrl/i);
    });
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
