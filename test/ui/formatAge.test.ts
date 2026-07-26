import { describe, expect, it } from "vitest";
import { formatAge } from "../../src/ui/formatAge";

describe("formatAge", () => {
  it('returns "never" when lastSeenAt is null', () => {
    expect(formatAge(null, 1_000)).toBe("never");
  });

  it("renders sub-minute deltas in seconds", () => {
    expect(formatAge(1_000, 6_000)).toBe("5s ago");
  });

  it("renders zero delta as 0s ago", () => {
    expect(formatAge(5_000, 5_000)).toBe("0s ago");
  });

  it("renders sub-hour deltas in minutes", () => {
    expect(formatAge(0, 90_000)).toBe("1m ago");
  });

  it("renders hour-plus deltas in hours", () => {
    expect(formatAge(0, 3_661_000)).toBe("1h ago");
  });

  it("clamps a lastSeenAt after now to 0s ago instead of going negative", () => {
    expect(formatAge(10_000, 5_000)).toBe("0s ago");
  });
});
