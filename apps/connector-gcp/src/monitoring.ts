import type { ListTimeSeriesRequest, SeriesPoint, TimeSeries } from "./clients.ts";
import { metricFilter, type UsageMetric } from "./metrics.ts";

const DAY_SECONDS = 86_400;

export interface UsagePoint {
  day: string;
  provider: string;
  service: string;
  metric: string;
  amount: number;
}

export function seriesRequest(
  projectName: string,
  metric: UsageMetric,
  start: Date,
  end: Date,
  alignmentSeconds = DAY_SECONDS,
): ListTimeSeriesRequest {
  return {
    name: projectName,
    filter: metricFilter(metric),
    interval: {
      startTime: { seconds: Math.floor(start.getTime() / 1000) },
      endTime: { seconds: Math.floor(end.getTime() / 1000) },
    },
    aggregation: {
      alignmentPeriod: { seconds: alignmentSeconds },
      perSeriesAligner: "ALIGN_DELTA",
      crossSeriesReducer: "REDUCE_SUM",
    },
  };
}

/** Sum series into one amount per UTC day. Days outside [start, end) are dropped. */
export function pointsFromSeries(metric: UsageMetric, series: TimeSeries[], start: Date, end: Date): UsagePoint[] {
  const startDay = start.toISOString().slice(0, 10);
  const endDay = end.toISOString().slice(0, 10);
  const totals = new Map<string, number>();
  for (const row of series) {
    for (const point of row.points ?? []) {
      const day = pointDay(point);
      const amount = pointAmount(point);
      if (!day || day < startDay || day >= endDay || !Number.isFinite(amount)) continue;
      totals.set(day, (totals.get(day) ?? 0) + amount);
    }
  }
  return [...totals.entries()].map(([day, amount]) => ({
    day,
    provider: metric.provider,
    service: metric.service,
    metric: metric.metric,
    amount,
  }));
}

function pointDay(point: SeriesPoint): string | null {
  const start = secondsOf(point.interval?.startTime?.seconds);
  const end = secondsOf(point.interval?.endTime?.seconds);
  const sec = start ?? (end === null ? null : end - DAY_SECONDS);
  if (sec === null) return null;
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function secondsOf(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pointAmount(point: SeriesPoint): number {
  const intValue = point.value?.int64Value;
  if (typeof intValue === "number" && Number.isFinite(intValue)) return intValue;
  if (typeof intValue === "string" && intValue.trim() !== "") return Number(intValue);
  const doubleValue = point.value?.doubleValue;
  if (typeof doubleValue === "number" && Number.isFinite(doubleValue)) return doubleValue;
  return Number.NaN;
}

/** First sync reads 35 UTC days ending tomorrow; later syncs read 3. */
export function syncWindow(now: Date, first: boolean): { start: Date; end: Date } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const days = first ? 35 : 3;
  const start = new Date(end.getTime() - days * DAY_SECONDS * 1000);
  return { start, end };
}
