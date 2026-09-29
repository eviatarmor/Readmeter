import { formatAbsolute, formatBytes, formatCount, formatMoney, formatRelative, formatRelativeCompact, halfDelta } from "@/lib/format-value";

describe("formatMoney", () => {
  it("formats zero, tiny amounts, and dollars", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(1)).toBe("<$0.01");
    expect(formatMoney(-1)).toBe("-<$0.01");
    expect(formatMoney(10_000)).toBe("$0.01");
    expect(formatMoney(1_500_000)).toBe("$1.50");
    expect(formatMoney(Number.NaN)).toBe("$0.00");
  });
});

describe("formatCount", () => {
  it("compacts thousands and millions", () => {
    expect(formatCount(12)).toBe("12");
    expect(formatCount(1_000)).toBe("1k");
    expect(formatCount(1_200)).toBe("1.2k");
    expect(formatCount(1_200_000)).toBe("1.2m");
    expect(formatCount(-2_500)).toBe("-2.5k");
  });
});

describe("formatBytes", () => {
  it("uses decimal units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(3_400_000)).toBe("3.4 MB");
    expect(formatBytes(10_000_000)).toBe("10 MB");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("dates and deltas", () => {
  it("formats absolute time and rejects invalid dates", () => {
    expect(formatAbsolute("2026-01-02T15:04:00.000Z")).toMatch(/2026/);
    expect(formatAbsolute("not-a-date")).toBe("");
    expect(formatRelative("not-a-date")).toBe("");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-02T15:04:00.000Z"));
      expect(formatRelativeCompact("not-a-date")).toBe("");
      expect(formatRelativeCompact("2026-01-02T15:03:30.000Z")).toBe("<1m ago");
      expect(formatRelativeCompact("2026-01-02T05:04:00.000Z")).toBe("10h ago");
      expect(formatRelativeCompact("2026-01-05T15:04:00.000Z")).toBe("in 3d");
    } finally {
      vi.useRealTimers();
    }
  });

  it("compares the later half of a series with the earlier half", () => {
    expect(halfDelta([1])).toBeNull();
    expect(halfDelta([1, 1, 3, 3])).toBe(2);
    expect(halfDelta([0, 4])).toBeNull();
    expect(halfDelta([0, 0])).toBe(0);
  });
});
