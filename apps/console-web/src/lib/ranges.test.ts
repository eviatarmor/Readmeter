import { chartRange, rangeBounds } from "@/lib/ranges";

describe("ranges", () => {
  it("keeps the same window for one minute", () => {
    const now = new Date("2026-09-30T12:34:56.000Z");
    const earlier = new Date(now.getTime() - 50_000);
    expect(rangeBounds("7d", now)).toEqual(rangeBounds("7d", earlier));
    expect(new Date(rangeBounds("24h", now).to).getSeconds()).toBe(0);
    expect(rangeBounds("24h", now).to).not.toBe(rangeBounds("24h", new Date(now.getTime() + 120_000)).to);
  });

  it("maps overview ranges onto the chart API", () => {
    expect(chartRange("24h")).toBe("7d");
    expect(chartRange("30d")).toBe("30d");
    expect(chartRange("90d")).toBe("90d");
  });
});
