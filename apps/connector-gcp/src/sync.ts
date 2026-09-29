import { eq, inArray, sql } from "drizzle-orm";
import type { Sql } from "postgres";

import { schema, type Db } from "@readmeter/db";

import { billingQuery, parseBillingRows, type BillingRow } from "./billing.ts";
import type { ClientFactory } from "./clients.ts";
import { decryptSecret, publicError } from "./crypto.ts";
import { withConnectionLock } from "./lock.ts";
import { USAGE_METRICS } from "./metrics.ts";
import { pointsFromSeries, seriesRequest, syncWindow, type UsagePoint } from "./monitoring.ts";
import { parseServiceAccount } from "./validate.ts";

export interface SyncOptions {
  sql: Sql;
  clients: ClientFactory;
  secretKey: Buffer | null;
  maxBytesBilled: number;
  timeoutMs: number;
  now?: Date;
  /** Tests pass the rows they inserted so a shared database is not synced by accident. */
  onlyIds?: readonly string[];
}

export interface SyncPass {
  synced: string[];
  skipped: string[];
  failed: string[];
}

interface Collected {
  usage: UsagePoint[];
  costs: BillingRow[];
  errors: string[];
}

export async function syncDue(db: Db, options: SyncOptions): Promise<SyncPass> {
  const now = options.now ?? new Date();
  const due = await db
    .select()
    .from(schema.gcpConnections)
    .where(
      sql`(${schema.gcpConnections.lastSyncAt} is null
        or ${schema.gcpConnections.syncRequestedAt} is not null
        or ${schema.gcpConnections.lastSyncAt} < ${new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString()}::timestamptz)
        ${options.onlyIds && options.onlyIds.length > 0 ? sql`and ${inArray(schema.gcpConnections.id, [...options.onlyIds])}` : sql``}`,
    );
  const pass: SyncPass = { synced: [], skipped: [], failed: [] };
  for (const row of due) {
    try {
      const held = await withConnectionLock(options.sql, row.id, () => syncOne(db, row, options, now));
      if (!held.locked) {
        pass.skipped.push(row.id);
        continue;
      }
      if (held.value.ok) pass.synced.push(row.id);
      else pass.failed.push(row.id);
    } catch (error) {
      pass.failed.push(row.id);
      await mark(db, row.id, now, publicError(error, [])).catch((markError) => {
        console.error(JSON.stringify({ msg: "gcp sync status write failed", id: row.id, error: publicError(markError, []) }));
      });
    }
  }
  return pass;
}

async function syncOne(
  db: Db,
  row: typeof schema.gcpConnections.$inferSelect,
  options: SyncOptions,
  now: Date,
): Promise<{ ok: boolean }> {
  if (!options.secretKey) {
    await mark(db, row.id, now, "Set READMETER_SECRET_KEY to 32 bytes, base64-encoded, before syncing Google Cloud.");
    return { ok: false };
  }
  const [existing] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.usageDaily)
    .where(eq(schema.usageDaily.projectId, row.projectId));
  const first = Number(existing?.n ?? 0) === 0;
  let collected: Collected;
  try {
    collected = await withTimeout(
      collect(row, options.secretKey, options.clients, options.maxBytesBilled, now, first),
      options.timeoutMs,
    );
  } catch (error) {
    await mark(db, row.id, now, publicError(error, []));
    return { ok: false };
  }
  await writeUsage(db, row.projectId, collected.usage);
  await writeCosts(db, row.projectId, collected.costs);
  const message = collected.errors.length > 0 ? collected.errors.join("; ") : null;
  await mark(db, row.id, now, message);
  return { ok: message === null };
}

async function collect(
  row: typeof schema.gcpConnections.$inferSelect,
  secretKey: Buffer,
  clientsFor: ClientFactory,
  maxBytesBilled: number,
  now: Date,
  first: boolean,
): Promise<Collected> {
  const json = decryptSecret(
    { ciphertext: row.keyCiphertext, iv: row.keyIv ?? "", tag: row.keyTag ?? "" },
    secretKey,
  );
  const parsed = parseServiceAccount(json);
  if ("error" in parsed) throw new Error(parsed.error);
  const clients = await clientsFor(parsed.account, row.gcpProjectId);
  const secrets = [parsed.account.private_key];
  const window = syncWindow(now, first);
  const usage: UsagePoint[] = [];
  const errors: string[] = [];
  for (const metric of USAGE_METRICS) {
    try {
      const [series] = await clients.monitoring.listTimeSeries(
        seriesRequest(clients.monitoring.projectPath(row.gcpProjectId), metric, window.start, window.end),
      );
      usage.push(...pointsFromSeries(metric, series, window.start, window.end));
    } catch (error) {
      errors.push(`${metric.type}: ${publicError(error, secrets)}`);
    }
  }
  let costs: BillingRow[] = [];
  if (row.billingTable) {
    try {
      const [rows] = await clients.bigquery.query(
        billingQuery(row.billingTable, row.gcpProjectId, window.start, window.end, String(maxBytesBilled)),
      );
      costs = parseBillingRows(rows).filter((item) => item.day >= window.start.toISOString().slice(0, 10) && item.day < window.end.toISOString().slice(0, 10));
    } catch (error) {
      errors.push(`billing: ${publicError(error, secrets)}`);
    }
  }
  return { usage: mergeUsage(usage), costs, errors };
}

/** Gen 1 and gen 2 both land on invocations. The unique key has one row per metric. */
function mergeUsage(points: UsagePoint[]): UsagePoint[] {
  const totals = new Map<string, UsagePoint>();
  for (const point of points) {
    const key = `${point.day}|${point.provider}|${point.service}|${point.metric}`;
    const existing = totals.get(key);
    if (existing) existing.amount += point.amount;
    else totals.set(key, { ...point });
  }
  return [...totals.values()];
}

async function writeUsage(db: Db, projectId: string, points: UsagePoint[]) {
  if (points.length === 0) return;
  await db
    .insert(schema.usageDaily)
    .values(
      points.map((point) => ({
        projectId,
        day: point.day,
        provider: point.provider,
        service: point.service,
        metric: point.metric,
        amount: String(point.amount),
        source: "monitoring",
      })),
    )
    .onConflictDoUpdate({
      target: [
        schema.usageDaily.projectId,
        schema.usageDaily.day,
        schema.usageDaily.provider,
        schema.usageDaily.service,
        schema.usageDaily.metric,
        schema.usageDaily.source,
      ],
      set: { amount: sql`excluded.amount` },
    });
}

async function writeCosts(db: Db, projectId: string, rows: BillingRow[]) {
  if (rows.length === 0) return;
  const merged = new Map<string, BillingRow>();
  for (const row of rows) {
    const key = `${row.day}|${row.service}|${row.sku}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row });
      continue;
    }
    existing.usageAmount += row.usageAmount;
    existing.costMicros += row.costMicros;
    existing.creditsMicros += row.creditsMicros;
  }
  await db
    .insert(schema.costDaily)
    .values(
      [...merged.values()].map((row) => ({
        projectId,
        day: row.day,
        service: row.service,
        sku: row.sku,
        usageAmount: String(row.usageAmount),
        usageUnit: row.usageUnit,
        costMicros: row.costMicros,
        creditsMicros: row.creditsMicros,
        currency: row.currency,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.costDaily.projectId, schema.costDaily.day, schema.costDaily.service, schema.costDaily.sku],
      set: {
        usageAmount: sql`excluded.usage_amount`,
        usageUnit: sql`excluded.usage_unit`,
        costMicros: sql`excluded.cost_micros`,
        creditsMicros: sql`excluded.credits_micros`,
        currency: sql`excluded.currency`,
      },
    });
}

async function mark(db: Db, id: string, startedAt: Date, error: string | null) {
  await db
    .update(schema.gcpConnections)
    .set({
      status: error ? "error" : "ok",
      lastError: error,
      lastSyncAt: startedAt,
      updatedAt: new Date(),
      // A request that arrives while this pass runs stays queued.
      syncRequestedAt: sql`case
        when ${schema.gcpConnections.syncRequestedAt} is null then null
        when ${schema.gcpConnections.syncRequestedAt} <= ${startedAt.toISOString()}::timestamptz then null
        else ${schema.gcpConnections.syncRequestedAt}
      end`,
    })
    .where(eq(schema.gcpConnections.id, id));
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("sync timed out")), timeoutMs);
  });
  // A rejection that lands after the timeout must not surface as unhandled.
  work.catch(() => {});
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
