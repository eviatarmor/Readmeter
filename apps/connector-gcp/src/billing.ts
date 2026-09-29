import { quoteBillingTable } from "./validate.ts";

export interface BillingRow {
  day: string;
  service: string;
  sku: string;
  usageAmount: number;
  usageUnit: string;
  costMicros: number;
  creditsMicros: number;
  currency: string;
}

const USAGE_SQL = (table: string) => `
SELECT
  DATE(usage_start_time) AS day,
  service.description AS service,
  sku.description AS sku,
  SUM(usage.amount) AS usage_amount,
  ANY_VALUE(usage.unit) AS usage_unit,
  SUM(cost) AS cost,
  ANY_VALUE(currency) AS currency,
  SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS credits
FROM ${table}
WHERE project.id = @gcp_project_id
  AND usage_start_time >= @start_time
  AND usage_start_time < @end_time
  AND _PARTITIONTIME >= @partition_start
  AND _PARTITIONTIME < @partition_end
GROUP BY day, service, sku
`;

/**
 * Partition time and usage time can differ by about a day on the billing export.
 * The extra two days keep late rows without scanning the whole table.
 */
export function billingQuery(table: string, gcpProjectId: string, start: Date, end: Date, maximumBytesBilled: string) {
  const partitionStart = new Date(start.getTime() - 2 * 86_400_000);
  const partitionEnd = new Date(end.getTime() + 2 * 86_400_000);
  return {
    query: USAGE_SQL(quoteBillingTable(table)),
    params: {
      gcp_project_id: gcpProjectId,
      start_time: start,
      end_time: end,
      partition_start: partitionStart,
      partition_end: partitionEnd,
    },
    types: {
      gcp_project_id: "STRING",
      start_time: "TIMESTAMP",
      end_time: "TIMESTAMP",
      partition_start: "TIMESTAMP",
      partition_end: "TIMESTAMP",
    },
    maximumBytesBilled,
  };
}

export function billingProbeQuery(table: string, maximumBytesBilled: string) {
  return {
    query: `SELECT 1 AS ok FROM ${quoteBillingTable(table)} WHERE _PARTITIONTIME >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY) LIMIT 1`,
    dryRun: true,
    maximumBytesBilled,
  };
}

export function toMicros(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000);
}

export function parseBillingRows(rows: Record<string, unknown>[]): BillingRow[] {
  const parsed: BillingRow[] = [];
  for (const row of rows) {
    const day = asDay(row.day);
    const cost = asNumber(row.cost);
    if (!day || !Number.isFinite(cost)) continue;
    const service = asText(row.service) || "Unknown service";
    const sku = asText(row.sku) || "Unknown SKU";
    const usage = asNumber(row.usage_amount);
    parsed.push({
      day,
      service,
      sku,
      usageAmount: Number.isFinite(usage) ? usage : 0,
      usageUnit: asText(row.usage_unit) || "",
      costMicros: toMicros(cost),
      creditsMicros: toMicros(asNumber(row.credits)),
      currency: asText(row.currency) || "USD",
    });
  }
  return parsed;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) return asText((value as { value: unknown }).value);
  return "";
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "value" in value) return asNumber((value as { value: unknown }).value);
  return Number.NaN;
}

function asDay(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "string") {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    return match?.[1] ?? null;
  }
  if (value && typeof value === "object" && "value" in value) return asDay((value as { value: unknown }).value);
  return null;
}
