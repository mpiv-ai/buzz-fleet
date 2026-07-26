import { describe, expect, it } from "vitest";
import { foldStopReason, KNOWN_STOP_REASONS, ZERO_TOKEN_COUNTS } from "../../src/cost/types";

// NIP-AM: "stopReason, when present, MUST be one of end_turn, max_tokens,
// cancelled, error, unknown. Consumers MUST treat unrecognized stopReason
// values as unknown; the token counts remain valid." — folding must never
// throw, for any input shape.

describe("KNOWN_STOP_REASONS", () => {
  it("lists exactly the five values the NIP-AM spec enumerates", () => {
    expect([...KNOWN_STOP_REASONS].sort()).toEqual(
      ["cancelled", "end_turn", "error", "max_tokens", "unknown"].sort(),
    );
  });
});

describe("foldStopReason", () => {
  it.each(["end_turn", "max_tokens", "cancelled", "error", "unknown"] as const)(
    "passes a known value %s through unchanged",
    (value) => {
      expect(foldStopReason(value)).toBe(value);
    },
  );

  it("folds an unrecognized string value to unknown", () => {
    expect(foldStopReason("tool_use_interrupted")).toBe("unknown");
  });

  it("folds a future/unseen stopReason without throwing", () => {
    expect(() => foldStopReason("some_future_reason_2027")).not.toThrow();
    expect(foldStopReason("some_future_reason_2027")).toBe("unknown");
  });

  it("folds a missing (undefined) stopReason to unknown", () => {
    expect(foldStopReason(undefined)).toBe("unknown");
  });

  it("folds a non-string value to unknown without throwing", () => {
    expect(foldStopReason(42)).toBe("unknown");
    expect(foldStopReason(null)).toBe("unknown");
    expect(foldStopReason({})).toBe("unknown");
    expect(foldStopReason(["end_turn"])).toBe("unknown");
  });
});

describe("ZERO_TOKEN_COUNTS", () => {
  it("is all-null — a real all-null count, never zero (NIP-AM: nulls MUST NOT be summed as zero)", () => {
    expect(ZERO_TOKEN_COUNTS).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
    });
  });
});
