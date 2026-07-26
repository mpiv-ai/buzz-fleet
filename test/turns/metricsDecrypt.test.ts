import { generateSecretKey, getPublicKey, nip44 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { decryptTurnMetric, safeDecryptTurnMetric } from "../../src/turns/metricsDecrypt";

// Round-trips use nostr-tools' own nip44.v2.encrypt — never a hand-rolled
// cipher — same discipline as test/turns/decrypt.test.ts.

function encryptFrame(
  senderSecretKey: Uint8Array,
  recipientPubkeyHex: string,
  plaintext: string,
): string {
  const conversationKey = nip44.getConversationKey(senderSecretKey, recipientPubkeyHex);
  return nip44.v2.encrypt(plaintext, conversationKey);
}

const FULL_PAYLOAD = {
  harness: "goose",
  model: "claude-sonnet-4-5",
  channelId: "5cdc97df-99b0-4d22-86fa-3d1478d697b1",
  sessionId: "session-abc",
  turnId: "turn-1",
  turnSeq: 17,
  timestamp: "2026-07-01T20:11:03.213Z",
  turn: { inputTokens: 1234, outputTokens: 567, totalTokens: 1801, costUsd: 0.0123 },
  cumulative: { inputTokens: 45210, outputTokens: 9876, totalTokens: 55086, costUsd: 0.41 },
  deltaReliable: true,
  stopReason: "end_turn",
};

describe("decryptTurnMetric", () => {
  it("decrypts and parses a well-formed turn metric end to end", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerKey);
    const content = encryptFrame(agentKey, ownerPubkey, JSON.stringify(FULL_PAYLOAD));

    const result = decryptTurnMetric({
      eventId: "event-1",
      content,
      senderPubkeyHex: getPublicKey(agentKey),
      createdAt: Math.floor(Date.parse(FULL_PAYLOAD.timestamp) / 1000),
      recipientSecretKey: ownerKey,
    });

    expect(result).toEqual({
      eventId: "event-1",
      agentPubkey: getPublicKey(agentKey),
      harness: "goose",
      model: "claude-sonnet-4-5",
      channelId: "5cdc97df-99b0-4d22-86fa-3d1478d697b1",
      sessionId: "session-abc",
      turnId: "turn-1",
      turnSeq: 17,
      timestampMs: Date.parse("2026-07-01T20:11:03.213Z"),
      turn: { inputTokens: 1234, outputTokens: 567, totalTokens: 1801, costUsd: 0.0123 },
      cumulative: { inputTokens: 45210, outputTokens: 9876, totalTokens: 55086, costUsd: 0.41 },
      deltaReliable: true,
      stopReason: "end_turn",
    });
  });

  it("defaults every optional/nullable field when only the required fields are present", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerKey);
    const minimal = { harness: "goose", timestamp: "2026-07-01T20:11:03.213Z" };
    const content = encryptFrame(agentKey, ownerPubkey, JSON.stringify(minimal));

    const result = decryptTurnMetric({
      eventId: "event-2",
      content,
      senderPubkeyHex: getPublicKey(agentKey),
      createdAt: 1_783_000_000,
      recipientSecretKey: ownerKey,
    });

    expect(result.model).toBeNull();
    expect(result.channelId).toBeNull();
    expect(result.sessionId).toBeNull();
    expect(result.turnId).toBeNull();
    expect(result.turnSeq).toBeNull();
    expect(result.turn).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
    });
    expect(result.cumulative).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
    });
    expect(result.deltaReliable).toBe(false);
    // Absent stopReason folds the same as an unrecognized one — always a
    // valid StopReason on the way out, never undefined.
    expect(result.stopReason).toBe("unknown");
  });

  it.each([
    ["max_tokens", "max_tokens"],
    ["cancelled", "cancelled"],
    ["error", "error"],
    ["unknown", "unknown"],
    ["tool_use_interrupted (unrecognized)", "tool_use_interrupted"],
    ["a completely novel future value", "reasoning_budget_exhausted_2027"],
  ] as const)("folds stopReason %s correctly, never failing to parse", (_label, wireValue) => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const content = encryptFrame(
      agentKey,
      getPublicKey(ownerKey),
      JSON.stringify({ harness: "goose", timestamp: "2026-07-01T00:00:00.000Z", stopReason: wireValue }),
    );

    const result = decryptTurnMetric({
      eventId: "event-3",
      content,
      senderPubkeyHex: getPublicKey(agentKey),
      createdAt: 1_783_000_000,
      recipientSecretKey: ownerKey,
    });

    const expected = ["end_turn", "max_tokens", "cancelled", "error", "unknown"].includes(wireValue)
      ? wireValue
      : "unknown";
    expect(result.stopReason).toBe(expected);
  });

  it("throws when the required 'harness' field is missing", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const content = encryptFrame(
      agentKey,
      getPublicKey(ownerKey),
      JSON.stringify({ timestamp: "2026-07-01T00:00:00.000Z" }),
    );

    expect(() =>
      decryptTurnMetric({
        eventId: "event-4",
        content,
        senderPubkeyHex: getPublicKey(agentKey),
        createdAt: 1_783_000_000,
        recipientSecretKey: ownerKey,
      }),
    ).toThrow(/harness/i);
  });

  it("throws when the required 'timestamp' field is missing", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const content = encryptFrame(agentKey, getPublicKey(ownerKey), JSON.stringify({ harness: "goose" }));

    expect(() =>
      decryptTurnMetric({
        eventId: "event-5",
        content,
        senderPubkeyHex: getPublicKey(agentKey),
        createdAt: 1_783_000_000,
        recipientSecretKey: ownerKey,
      }),
    ).toThrow(/timestamp/i);
  });

  it("falls back to the envelope's created_at when 'timestamp' does not parse as a date", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const content = encryptFrame(
      agentKey,
      getPublicKey(ownerKey),
      JSON.stringify({ harness: "goose", timestamp: "not-a-real-date" }),
    );

    const result = decryptTurnMetric({
      eventId: "event-6",
      content,
      senderPubkeyHex: getPublicKey(agentKey),
      createdAt: 1_783_000_000,
      recipientSecretKey: ownerKey,
    });

    expect(result.timestampMs).toBe(1_783_000_000 * 1000);
  });

  it("throws when 'cumulative' is present but 'sessionId' is missing (NIP-AM: required together)", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const content = encryptFrame(
      agentKey,
      getPublicKey(ownerKey),
      JSON.stringify({
        harness: "goose",
        timestamp: "2026-07-01T00:00:00.000Z",
        turnSeq: 1,
        cumulative: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.01 },
      }),
    );

    expect(() =>
      decryptTurnMetric({
        eventId: "event-7",
        content,
        senderPubkeyHex: getPublicKey(agentKey),
        createdAt: 1_783_000_000,
        recipientSecretKey: ownerKey,
      }),
    ).toThrow(/sessionId/i);
  });

  it("throws when 'cumulative' is present but 'turnSeq' is missing (NIP-AM: required together)", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const content = encryptFrame(
      agentKey,
      getPublicKey(ownerKey),
      JSON.stringify({
        harness: "goose",
        timestamp: "2026-07-01T00:00:00.000Z",
        sessionId: "s1",
        cumulative: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.01 },
      }),
    );

    expect(() =>
      decryptTurnMetric({
        eventId: "event-8",
        content,
        senderPubkeyHex: getPublicKey(agentKey),
        createdAt: 1_783_000_000,
        recipientSecretKey: ownerKey,
      }),
    ).toThrow(/turnSeq/i);
  });

  it("never records a null token count as zero — nulls stay null through parsing", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const content = encryptFrame(
      agentKey,
      getPublicKey(ownerKey),
      JSON.stringify({
        harness: "goose",
        timestamp: "2026-07-01T00:00:00.000Z",
        turn: { inputTokens: 10, outputTokens: null, totalTokens: null, costUsd: null },
      }),
    );

    const result = decryptTurnMetric({
      eventId: "event-9",
      content,
      senderPubkeyHex: getPublicKey(agentKey),
      createdAt: 1_783_000_000,
      recipientSecretKey: ownerKey,
    });

    expect(result.turn.inputTokens).toBe(10);
    expect(result.turn.outputTokens).toBeNull();
    expect(result.turn.totalTokens).toBeNull();
    expect(result.turn.costUsd).toBeNull();
  });

  it("throws when content is too short to plausibly be NIP-44 v2 ciphertext", () => {
    expect(() =>
      decryptTurnMetric({
        eventId: "event-10",
        content: "not encrypted",
        senderPubkeyHex: getPublicKey(generateSecretKey()),
        createdAt: 1_783_000_000,
        recipientSecretKey: generateSecretKey(),
      }),
    ).toThrow(/nip-44/i);
  });

  it("throws when the ciphertext was encrypted for a different recipient", () => {
    const agentKey = generateSecretKey();
    const someoneElse = generateSecretKey();
    const content = encryptFrame(agentKey, getPublicKey(someoneElse), JSON.stringify(FULL_PAYLOAD));

    expect(() =>
      decryptTurnMetric({
        eventId: "event-11",
        content,
        senderPubkeyHex: getPublicKey(agentKey),
        createdAt: 1_783_000_000,
        recipientSecretKey: generateSecretKey(),
      }),
    ).toThrow();
  });

  // Defense-in-depth: NIP-AM's payload has no legitimate place for a secret,
  // but this parser reuses the same redaction boundary as kind-24200
  // telemetry anyway (see redact.ts) rather than assuming the wire can never
  // carry a stray secret-shaped field.
  it("redacts a stray nsec1-shaped value even though NIP-AM defines no such field", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const content = encryptFrame(
      agentKey,
      getPublicKey(ownerKey),
      JSON.stringify({
        harness: "goose",
        timestamp: "2026-07-01T00:00:00.000Z",
        model: "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqz9qq5r",
      }),
    );

    const result = decryptTurnMetric({
      eventId: "event-12",
      content,
      senderPubkeyHex: getPublicKey(agentKey),
      createdAt: 1_783_000_000,
      recipientSecretKey: ownerKey,
    });

    expect(result.model).toBe("[REDACTED]");
  });
});

describe("safeDecryptTurnMetric", () => {
  it("returns the decoded record on success", () => {
    const agentKey = generateSecretKey();
    const ownerKey = generateSecretKey();
    const content = encryptFrame(agentKey, getPublicKey(ownerKey), JSON.stringify(FULL_PAYLOAD));

    const result = safeDecryptTurnMetric({
      eventId: "event-13",
      content,
      senderPubkeyHex: getPublicKey(agentKey),
      createdAt: 1_783_000_000,
      recipientSecretKey: ownerKey,
    });

    expect(result?.harness).toBe("goose");
  });

  it("returns null instead of throwing on a malformed metric event", () => {
    const result = safeDecryptTurnMetric({
      eventId: "event-14",
      content: "garbage",
      senderPubkeyHex: getPublicKey(generateSecretKey()),
      createdAt: 1_783_000_000,
      recipientSecretKey: generateSecretKey(),
    });

    expect(result).toBeNull();
  });
});
