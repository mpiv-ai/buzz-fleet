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
