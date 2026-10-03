// Daily rollups and retention for telemetry tables.
//
// One pass:
// 1. Takes a cluster-wide advisory lock so two workers never run at once.
// 2. Reads `max(events.id)` under a brief SHARE lock on `events`. The lock
//    waits for in-flight ingest transactions, so every event with a lower id
//    is committed and visible to the rollup below (identity ids are handed
//    out in order, but commits are not).
// 3. Per project, in one transaction: adds every event with
//    `id <= watermark and ts < start of today (UTC)` that is not rolled up yet
//    into `events_daily`, then moves `events_rollup_state` forward. The
//    state predicate (see schema.ts) makes re-runs and late events exact.
// 4. Deletes rolled-up raw events, then batches with no events left, older
//    than the raw retention, in small chunks so no statement holds locks
//    for long. Old findings and (optionally) old rollups go the same way.
import type { Sql } from "postgres";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHUNK = 5_000;
/** pg_advisory_lock keys: "rm" "retn". Any fixed pair works; it only has to be unique. */
const LOCK_KEYS = [0x726d, 0x7265746e] as const;

export interface RetentionConfig {
  /** Raw `events` and `batches` older than this many days are deleted. 0 keeps them. */
  eventsDays: number;
  /** Findings whose `last_seen` is older than this many days are deleted. 0 keeps them. */
  findingsDays: number;
  /** `events_daily` rows older than this many days are deleted. 0 keeps them. */
  rollupDays: number;
  /** Worker interval between passes. */
  intervalMs: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  eventsDays: 30,
  findingsDays: 365,
  rollupDays: 0,
  intervalMs: 60 * 60 * 1000,
};

export interface RetentionOptions extends Partial<Omit<RetentionConfig, "intervalMs">> {
  /** Clock for tests. */
  now?: Date;
  /** Limit the pass to these projects (tests). Default: every project. */
  projectIds?: string[];
  /** Rows per delete statement. */
  chunk?: number;
}

export interface RetentionReport {
  /** True when another worker held the lock and this pass did nothing. */
  skipped: boolean;
  projects: number;
  /** `events_daily` rows inserted or updated. */
  rolledRows: number;
  deletedEvents: number;
  deletedBatches: number;
  deletedFindings: number;
  deletedRollups: number;
}

function days(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = source[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole number of days, 0 or more`);
  }
  return value;
}

/** Reads `READMETER_*_RETENTION_DAYS` and `READMETER_RETENTION_INTERVAL_MS`. Throws on bad values. */
export function retentionFromEnv(source: NodeJS.ProcessEnv = process.env): RetentionConfig {
  const eventsDays = days(source, "READMETER_EVENTS_RETENTION_DAYS", DEFAULT_RETENTION.eventsDays);
  const findingsDays = days(source, "READMETER_FINDINGS_RETENTION_DAYS", DEFAULT_RETENTION.findingsDays);
  const rollupDays = days(source, "READMETER_ROLLUP_RETENTION_DAYS", DEFAULT_RETENTION.rollupDays);
  // Raw events of a rolled-up day are only read through the rollup, so a
  // rollup that expires before the raw rows would hide days that still exist.
  if (rollupDays > 0 && (eventsDays === 0 || rollupDays < eventsDays)) {
    throw new Error(
      "READMETER_ROLLUP_RETENTION_DAYS must be 0 or at least READMETER_EVENTS_RETENTION_DAYS (and that must not be 0)",
    );
  }
  const intervalRaw = source.READMETER_RETENTION_INTERVAL_MS?.trim();
  const intervalMs = intervalRaw ? Number(intervalRaw) : DEFAULT_RETENTION.intervalMs;
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000) {
    throw new Error("READMETER_RETENTION_INTERVAL_MS must be at least 1000");
  }
  return { eventsDays, findingsDays, rollupDays, intervalMs };
}

/** `YYYY-MM-DD` of the UTC day `offset` days from `now`'s day. */
function utcDay(now: Date, offset = 0): string {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(start + offset * DAY_MS).toISOString().slice(0, 10);
}

const dayStart = (day: string) => `${day}T00:00:00.000Z`;

/** Runs one pass. Safe to run concurrently with ingest and with other workers. */
export async function runRetention(sql: Sql, options: RetentionOptions = {}): Promise<RetentionReport> {
  const now = options.now ?? new Date();
  const eventsDays = options.eventsDays ?? DEFAULT_RETENTION.eventsDays;
  const findingsDays = options.findingsDays ?? DEFAULT_RETENTION.findingsDays;
  const rollupDays = options.rollupDays ?? DEFAULT_RETENTION.rollupDays;
  const chunk = options.chunk ?? DEFAULT_CHUNK;
  const report: RetentionReport = {
    skipped: false,
    projects: 0,
    rolledRows: 0,
    deletedEvents: 0,
    deletedBatches: 0,
    deletedFindings: 0,
    deletedRollups: 0,
  };

  const reserved = await sql.reserve();
  try {
    const [lock] = await reserved<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${LOCK_KEYS[0]}::integer, ${LOCK_KEYS[1]}::integer) as locked
    `;
    if (lock?.locked !== true) return { ...report, skipped: true };
    try {
      const projectIds =
        options.projectIds ??
        (await sql<{ id: string }[]>`select id from projects order by id`).map((row) => row.id);
      report.projects = projectIds.length;
      if (projectIds.length === 0) return report;

      const watermark = await eventWatermark(sql);
      const today = utcDay(now);
      for (const projectId of projectIds) {
        const state = await rollUp(sql, projectId, watermark, today);
        report.rolledRows += state.rows;
        if (eventsDays > 0) {
          const cutoff = dayStart(utcDay(now, -eventsDays));
          // Only rows that are already in the rollup may go.
          const limit = cutoff < dayStart(state.until) ? cutoff : dayStart(state.until);
          report.deletedEvents += await deleteChunked(
            chunk,
            (n) => sql`
              delete from events where id in (
                select id from events
                where project_id = ${projectId}
                  and ts < ${limit}::timestamptz
                  and id <= ${state.eventId}::bigint
                limit ${n}
              )
            `,
          );
          report.deletedBatches += await deleteChunked(
            chunk,
            (n) => sql`
              delete from batches where id in (
                select b.id from batches b
                where b.project_id = ${projectId}
                  and b.received_at < ${cutoff}::timestamptz
                  and not exists (select 1 from events e where e.batch_id = b.id)
                limit ${n}
              )
            `,
          );
        }
        if (findingsDays > 0) {
          const cutoff = dayStart(utcDay(now, -findingsDays));
          report.deletedFindings += await deleteChunked(
            chunk,
            (n) => sql`
              delete from findings where id in (
                select id from findings
                where project_id = ${projectId} and last_seen < ${cutoff}::timestamptz
                limit ${n}
              )
            `,
          );
        }
        if (rollupDays > 0) {
          const cutoff = utcDay(now, -rollupDays);
          report.deletedRollups += await deleteChunked(
            chunk,
            (n) => sql`
              delete from events_daily where ctid in (
                select ctid from events_daily
                where project_id = ${projectId} and day < ${cutoff}::date
                limit ${n}
              )
            `,
          );
        }
      }
      return report;
    } finally {
      await reserved`select pg_advisory_unlock(${LOCK_KEYS[0]}::integer, ${LOCK_KEYS[1]}::integer)`;
    }
  } finally {
    reserved.release();
  }
}

/** Highest event id such that every lower id is committed. */
async function eventWatermark(sql: Sql): Promise<string> {
  return sql.begin(async (tx) => {
    await tx`set local lock_timeout = '10s'`;
    await tx`lock table events in share mode`;
    const [row] = await tx<{ id: string }[]>`select coalesce(max(id), 0)::text as id from events`;
    return row?.id ?? "0";
  });
}

async function rollUp(
  sql: Sql,
  projectId: string,
  watermark: string,
  today: string,
): Promise<{ eventId: string; until: string; rows: number }> {
  return sql.begin(async (tx) => {
    await tx`insert into events_rollup_state (project_id) values (${projectId}) on conflict do nothing`;
    const [prev] = await tx<{ event_id: string; until: string }[]>`
      select rolled_event_id::text as event_id, rolled_until::text as until
      from events_rollup_state where project_id = ${projectId} for update
    `;
    if (!prev) throw new Error("rollup state row missing");
    const eventId = BigInt(watermark) > BigInt(prev.event_id) ? watermark : prev.event_id;
    const until = today > prev.until ? today : prev.until;
    if (eventId === prev.event_id && until === prev.until) return { eventId, until, rows: 0 };

    const result = await tx`
      with keyed as (
        select (ts at time zone 'UTC')::date as day, provider, service, op, template,
               coalesce(callsite, '') as callsite, callsite_label, items, bytes, from_cache,
               error_code, units
        from events
        where project_id = ${projectId}
          and id <= ${eventId}::bigint
          and ts < ${dayStart(until)}::timestamptz
          and (id > ${prev.event_id}::bigint or ts >= ${dayStart(prev.until)}::timestamptz)
      ),
      g as (
        select day, provider, service, op, template, callsite,
               max(callsite_label) as callsite_label,
               count(*) as events,
               sum(items) as items,
               sum(bytes) as bytes,
               count(*) filter (where from_cache) as cached,
               count(*) filter (where error_code is not null) as errors
        from keyed
        group by 1, 2, 3, 4, 5, 6
      ),
      u as (
        select day, provider, service, op, template, callsite, jsonb_object_agg(unit, amount) as units
        from (
          select k.day, k.provider, k.service, k.op, k.template, k.callsite,
                 e.key as unit, sum((e.value)::text::numeric) as amount
          from keyed k
          cross join lateral jsonb_each(k.units) as e(key, value)
          group by 1, 2, 3, 4, 5, 6, 7
        ) s
        group by 1, 2, 3, 4, 5, 6
      )
      insert into events_daily as r
        (project_id, day, provider, service, op, template, callsite, callsite_label,
         events, items, bytes, cached, errors, units)
      select ${projectId}, g.day, g.provider, g.service, g.op, g.template, g.callsite,
             g.callsite_label, g.events, g.items, g.bytes, g.cached, g.errors,
             coalesce(u.units, '{}'::jsonb)
      from g
      left join u using (day, provider, service, op, template, callsite)
      on conflict (project_id, day, provider, service, op, template, callsite) do update set
        callsite_label = coalesce(excluded.callsite_label, r.callsite_label),
        events = r.events + excluded.events,
        items = r.items + excluded.items,
        bytes = r.bytes + excluded.bytes,
        cached = r.cached + excluded.cached,
        errors = r.errors + excluded.errors,
        units = (
          select coalesce(jsonb_object_agg(k, total), '{}'::jsonb)
          from (
            select k, sum(v::numeric) as total
            from (
              select key as k, value as v from jsonb_each_text(r.units)
              union all
              select key, value from jsonb_each_text(excluded.units)
            ) parts
            group by k
          ) sums
        )
    `;
    await tx`
      update events_rollup_state
      set rolled_event_id = ${eventId}::bigint, rolled_until = ${until}::date, updated_at = now()
      where project_id = ${projectId}
    `;
    return { eventId, until, rows: result.count };
  });
}

async function deleteChunked(
  chunk: number,
  statement: (n: number) => PromiseLike<{ count: number }>,
): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await statement(chunk);
    total += result.count;
    if (result.count < chunk) return total;
  }
}

/**
 * Runs a pass now and then every `intervalMs` until `signal` aborts. Errors
 * are logged and the loop keeps going.
 */
export async function runRetentionLoop(
  sql: Sql,
  config: RetentionConfig,
  signal: AbortSignal,
  log: (msg: string, fields: Record<string, unknown>) => void = (msg, fields) =>
    console.log(JSON.stringify({ msg, ...fields })),
): Promise<void> {
  while (!signal.aborted) {
    try {
      const report = await runRetention(sql, config);
      if (!report.skipped) log("retention pass", { ...report });
    } catch (error) {
      log("retention pass failed", { error: error instanceof Error ? error.message : String(error) });
    }
    await sleep(config.intervalMs, signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
