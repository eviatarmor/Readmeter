export const WINDOW_RANGES = ["24h", "7d", "30d", "90d"] as const;
export type WindowRange = (typeof WINDOW_RANGES)[number];

export const CHART_RANGES = ["7d", "30d", "90d"] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

export function isWindowRange(value: string): value is WindowRange {
  return (WINDOW_RANGES as readonly string[]).includes(value);
}

export function chartRange(range: string): ChartRange {
  if (range === "30d" || range === "90d") return range;
  return "7d";
}

export function rangeBounds(range: WindowRange, now = new Date()): { from: string; to: string } {
  const to = new Date(now);
  to.setSeconds(0, 0);
  to.setMinutes(to.getMinutes() + 1);
  const from = new Date(to);
  if (range === "24h") from.setHours(from.getHours() - 24);
  else if (range === "7d") from.setDate(from.getDate() - 7);
  else if (range === "30d") from.setDate(from.getDate() - 30);
  else from.setDate(from.getDate() - 90);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function projectStorageKey(slug: string): string {
  return `readmeter-project:${slug}`;
}
