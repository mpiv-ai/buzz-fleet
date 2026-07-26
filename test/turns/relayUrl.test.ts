import { describe, expect, it } from "vitest";
import { resolveRelayWsUrl } from "../../src/turns/relayUrl";

describe("resolveRelayWsUrl", () => {
  it("prefers an explicit wsUrl when given", () => {
    expect(
      resolveRelayWsUrl({ url: "http://localhost:3000", wsUrl: "ws://elsewhere:9000" }),
    ).toBe("ws://elsewhere:9000");
  });

  it("derives ws:// from an absolute http:// url when wsUrl is omitted", () => {
    expect(resolveRelayWsUrl({ url: "http://localhost:3000" })).toBe("ws://localhost:3000");
  });

  it("derives wss:// from an absolute https:// url when wsUrl is omitted", () => {
    expect(resolveRelayWsUrl({ url: "https://relay.example.com" })).toBe(
      "wss://relay.example.com",
    );
  });

  it("preserves path/port when deriving from an absolute url", () => {
    expect(resolveRelayWsUrl({ url: "http://localhost:3000/nostr" })).toBe(
      "ws://localhost:3000/nostr",
    );
  });

  it("throws with a clear message when url is a root-relative proxy path and wsUrl is missing", () => {
    expect(() => resolveRelayWsUrl({ url: "/relay-proxy" })).toThrow(/wsUrl/);
  });
});
