import { describe, expect, it } from "vitest";
import { redactSecrets, REDACTED } from "../../src/turns/redact";

// Live-rig finding (2026-07-26): buzz-acp's observer stream includes
// `acp_write` frames carrying the ACP `session/new` request verbatim, and that
// request embeds the agent's own MCP server env block — including
// BUZZ_PRIVATE_KEY as a plaintext nsec. The frame is NIP-44 encrypted to the
// owner, so the relay never sees it, but every owner-side consumer (this
// board's ring buffer, /turns-state.json, the UI, any capture file written
// from it) would otherwise hold and render a live secret key. Redaction runs
// at the decrypt boundary so nothing downstream can ever leak it.

describe("redactSecrets", () => {
  it("redacts the value of a {name, value} env pair whose name is a secret", () => {
    const payload = {
      params: {
        mcpServers: [
          {
            command: "/Users/x/dev/buzz-local/gate.sh",
            env: [
              { name: "BUZZ_RELAY_URL", value: "ws://localhost:3000" },
              { name: "BUZZ_PRIVATE_KEY", value: "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqz9qq5r" },
            ],
          },
        ],
      },
    };

    const result = redactSecrets(payload) as typeof payload;
    const env = result.params.mcpServers[0]?.env ?? [];

    expect(env[0]).toEqual({ name: "BUZZ_RELAY_URL", value: "ws://localhost:3000" });
    expect(env[1]).toEqual({ name: "BUZZ_PRIVATE_KEY", value: REDACTED });
  });

  it("redacts values under secret-looking object keys, case-insensitively", () => {
    const result = redactSecrets({
      apiKey: "sk-live-abc",
      PASSWORD: "hunter2",
      auth_token: "t-123",
      privateKey: "deadbeef",
      client_secret: "shh",
      note: "keep me",
    }) as Record<string, unknown>;

    expect(result).toEqual({
      apiKey: REDACTED,
      PASSWORD: REDACTED,
      auth_token: REDACTED,
      privateKey: REDACTED,
      client_secret: REDACTED,
      note: "keep me",
    });
  });

  it("redacts a bech32 nsec anywhere, even under an innocuous key", () => {
    const result = redactSecrets({
      description: "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqz9qq5r",
      args: ["--key", "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqz9qq5r"],
    }) as { description: string; args: string[] };

    expect(result.description).toBe(REDACTED);
    expect(result.args).toEqual(["--key", REDACTED]);
  });

  it("leaves public identifiers untouched", () => {
    const payload = {
      pubkey: "f88187813ab5835fb73c57222bf236ef7e4be9aee7f85b29d6fa0bbee88e20c1",
      npub: "npub1w0rfhqf6ky7l6r2q4pgpsm4mnnk9nqrs9pmqf6ky7l6r2q4pgpsx8f4kz",
      turnId: "e2e74aa7-bddf-41c0-9568-b5518891d072",
      channelId: "5cdc97df-99b0-4d22-86fa-3d1478d697b1",
      source: "channel",
      outcome: "ok",
    };

    expect(redactSecrets(payload)).toEqual(payload);
  });

  it("preserves structure and non-string leaves", () => {
    const payload = {
      seq: 5,
      ok: true,
      missing: null,
      nested: { list: [1, "two", { deep: false }] },
    };

    expect(redactSecrets(payload)).toEqual(payload);
  });

  it("passes elided payload stubs through unchanged", () => {
    const elided = { elided: "payload too large", originalBytes: 91_234 };
    expect(redactSecrets(elided)).toEqual(elided);
  });

  it("returns primitives and empty payloads unchanged", () => {
    expect(redactSecrets({})).toEqual({});
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets(7)).toBe(7);
  });

  it("does not mutate its input", () => {
    const payload = { apiKey: "sk-live-abc", env: [{ name: "TOKEN", value: "t" }] };
    const snapshot = structuredClone(payload);

    redactSecrets(payload);

    expect(payload).toEqual(snapshot);
  });
});
