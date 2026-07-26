import { generateSecretKey, getPublicKey, nip44 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { safeDecryptObserverFrame, decryptObserverFrame } from "../../src/turns/decrypt";

// Round-trips are built with nostr-tools' own nip44.v2.encrypt — never a
// hand-rolled cipher — so these tests exercise the real algorithm end to end.

function encryptFrame(
  senderSecretKey: Uint8Array,
  recipientPubkeyHex: string,
  plaintext: string,
): string {
  const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkeyHex);
  return nip44.v2.encrypt(plaintext, conversationKey);
}

describe("decryptObserverFrame", () => {
  it("decrypts and parses a well-formed turn_started envelope", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerKey);

    const plaintext = JSON.stringify({
      seq: 42,
      timestamp: "2026-04-29T12:00:41.500Z",
      kind: "turn_started",
      agentIndex: 0,
      channelId: "52a85618-0f8f-4542-94ec-599e6e1c6f2e",
      sessionId: "a1b2c3d4",
      turnId: "e5f6g7h8",
      payload: { source: "channel" },
    });
    const content = encryptFrame(agentKey, ownerPubkey, plaintext);

    const result = decryptObserverFrame({
      content,
      senderPubkeyHex: getPublicKey(agentKey),
      recipientSecretKey: ownerKey,
    });

    expect(result).toEqual({
      seq: 42,
      timestamp: "2026-04-29T12:00:41.500Z",
      kind: "turn_started",
      agentIndex: 0,
      channelId: "52a85618-0f8f-4542-94ec-599e6e1c6f2e",
      sessionId: "a1b2c3d4",
      turnId: "e5f6g7h8",
      payload: { source: "channel" },
    });
  });

  it("defaults optional envelope fields to null when the NIP allows them absent", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerKey);

    const plaintext = JSON.stringify({
      seq: 1,
      timestamp: "2026-04-29T12:00:00.000Z",
      kind: "harness_started",
      payload: {},
    });
    const content = encryptFrame(agentKey, ownerPubkey, plaintext);

    const result = decryptObserverFrame({
      content,
      senderPubkeyHex: getPublicKey(agentKey),
      recipientSecretKey: ownerKey,
    });

    expect(result.agentIndex).toBeNull();
    expect(result.channelId).toBeNull();
    expect(result.sessionId).toBeNull();
    expect(result.turnId).toBeNull();
  });

  it("decrypts a payload carrying a whole-payload elision stub without choking on it", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerKey);

    const plaintext = JSON.stringify({
      seq: 7,
      timestamp: "2026-04-29T12:00:41.500Z",
      kind: "turn_liveness",
      agentIndex: 0,
      channelId: null,
      sessionId: "s1",
      turnId: "t1",
      payload: { elided: "turn_liveness payload too large", originalBytes: 200_000 },
    });
    const content = encryptFrame(agentKey, ownerPubkey, plaintext);

    const result = decryptObserverFrame({
      content,
      senderPubkeyHex: getPublicKey(agentKey),
      recipientSecretKey: ownerKey,
    });

    expect(result.payload).toEqual({
      elided: "turn_liveness payload too large",
      originalBytes: 200_000,
    });
  });

  it("throws when the ciphertext was encrypted for a different recipient", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const someoneElse = generateSecretKey();
    const content = encryptFrame(agentKey, getPublicKey(someoneElse), JSON.stringify({}));

    expect(() =>
      decryptObserverFrame({
        content,
        senderPubkeyHex: getPublicKey(agentKey),
        recipientSecretKey: ownerKey,
      }),
    ).toThrow();
  });

  it("throws when content is too short to plausibly be NIP-44 v2 ciphertext", () => {
    const ownerKey = generateSecretKey();
    expect(() =>
      decryptObserverFrame({
        content: "not encrypted",
        senderPubkeyHex: getPublicKey(generateSecretKey()),
        recipientSecretKey: ownerKey,
      }),
    ).toThrow(/nip-44/i);
  });

  it("throws when the decrypted plaintext is not valid JSON", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const content = encryptFrame(agentKey, getPublicKey(ownerKey), "not { json");

    expect(() =>
      decryptObserverFrame({
        content,
        senderPubkeyHex: getPublicKey(agentKey),
        recipientSecretKey: ownerKey,
      }),
    ).toThrow();
  });

  it("throws when a required envelope field (seq) is missing", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const content = encryptFrame(
      agentKey,
      getPublicKey(ownerKey),
      JSON.stringify({ timestamp: "2026-04-29T12:00:00.000Z", kind: "turn_started", payload: {} }),
    );

    expect(() =>
      decryptObserverFrame({
        content,
        senderPubkeyHex: getPublicKey(agentKey),
        recipientSecretKey: ownerKey,
      }),
    ).toThrow(/seq/i);
  });
});

describe("safeDecryptObserverFrame", () => {
  it("returns the decoded event on success", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const content = encryptFrame(
      agentKey,
      getPublicKey(ownerKey),
      JSON.stringify({
        seq: 1,
        timestamp: "2026-04-29T12:00:00.000Z",
        kind: "turn_started",
        payload: {},
      }),
    );

    const result = safeDecryptObserverFrame({
      content,
      senderPubkeyHex: getPublicKey(agentKey),
      recipientSecretKey: ownerKey,
    });

    expect(result?.kind).toBe("turn_started");
  });

  it("returns null instead of throwing on a malformed frame — one bad frame must not take the ingestion loop down", () => {
    const result = safeDecryptObserverFrame({
      content: "garbage",
      senderPubkeyHex: getPublicKey(generateSecretKey()),
      recipientSecretKey: generateSecretKey(),
    });

    expect(result).toBeNull();
  });
});

describe("decryptObserverFrame secret redaction", () => {
  // Live-rig finding (2026-07-26): a real acp_write frame from buzz-acp
  // carries the ACP session/new request, whose mcpServers[].env block holds
  // the agent's own BUZZ_PRIVATE_KEY as a plaintext nsec. Redaction has to
  // happen at this boundary — everything downstream (ring buffer,
  // /turns-state.json, UI, capture files) reads what this function returns.
  it("redacts key material out of an acp_write payload", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();

    const plaintext = JSON.stringify({
      seq: 6,
      timestamp: "2026-07-26T05:17:14.588046+00:00",
      kind: "acp_write",
      agentIndex: 0,
      channelId: "5cdc97df-99b0-4d22-86fa-3d1478d697b1",
      sessionId: null,
      turnId: "e2e74aa7-bddf-41c0-9568-b5518891d072",
      payload: {
        method: "session/new",
        params: {
          mcpServers: [
            {
              command: "/Users/x/dev/buzz-local/gate.sh",
              env: [
                { name: "BUZZ_RELAY_URL", value: "ws://localhost:3000" },
                {
                  name: "BUZZ_PRIVATE_KEY",
                  value:
                    "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqz9qq5r",
                },
              ],
            },
          ],
        },
      },
    });

    const result = decryptObserverFrame({
      content: encryptFrame(agentKey, getPublicKey(ownerKey), plaintext),
      senderPubkeyHex: getPublicKey(agentKey),
      recipientSecretKey: ownerKey,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("nsec1");
    expect(serialized).toContain("[REDACTED]");

    // Envelope and non-secret payload fields survive intact.
    expect(result.kind).toBe("acp_write");
    expect(result.turnId).toBe("e2e74aa7-bddf-41c0-9568-b5518891d072");
    const params = (result.payload as { params: { mcpServers: { env: unknown[] }[] } }).params;
    expect(params.mcpServers[0]?.env[0]).toEqual({
      name: "BUZZ_RELAY_URL",
      value: "ws://localhost:3000",
    });
  });

  it("leaves an ordinary turn_started payload untouched", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();

    const plaintext = JSON.stringify({
      seq: 5,
      timestamp: "2026-07-26T05:17:14.580607+00:00",
      kind: "turn_started",
      agentIndex: 0,
      channelId: "5cdc97df-99b0-4d22-86fa-3d1478d697b1",
      sessionId: null,
      turnId: "e2e74aa7-bddf-41c0-9568-b5518891d072",
      payload: {
        source: "channel",
        triggeringEventIds: ["260fcb8fec0d405381a9bcaa03b057012b53ae94d86ef96e733b5b35cc785821"],
      },
    });

    const result = decryptObserverFrame({
      content: encryptFrame(agentKey, getPublicKey(ownerKey), plaintext),
      senderPubkeyHex: getPublicKey(agentKey),
      recipientSecretKey: ownerKey,
    });

    expect(result.payload).toEqual({
      source: "channel",
      triggeringEventIds: ["260fcb8fec0d405381a9bcaa03b057012b53ae94d86ef96e733b5b35cc785821"],
    });
  });
});
