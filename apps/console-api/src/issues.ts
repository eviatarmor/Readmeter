// Issue groups: one row per (project, rule, template, callsite).
// findings_issue_idx covers that GROUP BY. List reads are one grouped query
// plus a count. wasted_micros is ordered after pricing because prices live
// in the Rust core, not in SQL.
import { createHash } from "node:crypto";

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import { schema, type Db } from "@readmeter/db";

import { decodeCursor, encodeCursor } from "./http.ts";

export const ISSUE_SORTS = ["last_seen", "occurrences", "wasted_micros", "sessions"] as const;
export type IssueSort = (typeof ISSUE_SORTS)[number];

const GROUP_SORTS = ["last_seen", "occurrences", "sessions"] as const;
type GroupSort = (typeof GROUP_SORTS)[number];

export interface IssueGroup {
  id: string;
  projectId: string;
  rule: string;
  severity: string;
  provider: string;
  service: string;
  template: string;
  session: string;
  callsite: string;
  message: string;
  occurrences: number;
  sessions: number;
  firstSeen: Date;
  lastSeen: Date;
  wasted: Record<string, number>;
  status: string;
  assignee: string | null;
  note: string | null;
}

export interface PricedIssue extends IssueGroup {
  wastedMicros: number;
}

export interface IssueMember {
  id: number;
  session: string;
  occurrences: number;
  lastSeen: Date;
  evidence: Record<string, unknown>;
}

type Price = (row: { provider: string; service: string; wasted: Record<string, number> }) => number;

/** First 16 hex chars of MD5(`rule\\n template\\n callsite`). Matches Postgres md5(). */
export function issueHash(rule: string, template: string, callsite: string): string {
  return createHash("md5").update(`${rule}\n${template}\n${callsite}`).digest("hex").slice(0, 16);
}

export function issueId(projectId: string, rule: string, template: string, callsite: string): string {
  return `${projectId}:${issueHash(rule, template, callsite)}`;
}

export function parseIssueId(value: string): { projectId: string; hash: string } | null {
  const split = value.lastIndexOf(":");
  if (split <= 0) return null;
  const projectId = value.slice(0, split);
  const hash = value.slice(split + 1);
  if (!/^[0-9a-f]{16}$/.test(hash) || projectId.length === 0) return null;
  return { projectId, hash };
}

export function issueHashMatch(hash: string): SQL {
  return sql`left(md5(${schema.findings.rule} || chr(10) || ${schema.findings.template} || chr(10) || ${schema.findings.callsite}), 16) = ${hash}`;
}

export async function countOpenIssues(db: Db, projectIds: string[]): Promise<number> {
  if (projectIds.length === 0) return 0;
  const where = and(
    inArray(schema.findings.projectId, projectIds),
    sql`coalesce(${schema.findingStates.status}, 'open') = 'open'`,
  );
  if (!where) return 0;
  return countGroups(db, where);
}

export async function listIssuePage(
  db: Db,
  where: SQL,
  options: { sort: IssueSort; limit: number; cursor: string | null; price: Price },
): Promise<{ items: PricedIssue[]; nextCursor: string | null; total: number } | { error: string }> {
  const sort = options.sort;
  const cursor = readCursor(options.cursor, sort);
  if (cursor === "bad") return { error: "invalid cursor" };
  const total = await countGroups(db, where);
  if (sort === "wasted_micros") {
    if (cursor && cursor.sort !== "wasted_micros") return { error: "invalid cursor" };
    const groups = priceAll(await selectGroups(db, where, undefined, undefined), options.price);
    groups.sort((a, b) => b.wastedMicros - a.wastedMicros || b.id.localeCompare(a.id));
    let start = 0;
    if (cursor) {
      const at = groups.findIndex((row) => row.id === cursor.id);
      if (at < 0) return { error: "invalid cursor" };
      start = at + 1;
    }
    const page = groups.slice(start, start + options.limit + 1);
    const items = page.slice(0, options.limit);
    const last = page.length > options.limit ? items[items.length - 1] : undefined;
    return {
      items,
      total,
      nextCursor: last ? encodeCursor({ sort: "wasted_micros", wastedMicros: last.wastedMicros, id: last.id }) : null,
    };
  }
  if (cursor && cursor.sort === "wasted_micros") return { error: "invalid cursor" };
  const order = orderSql(sort);
  const predicate = cursor ? keyset(sort, cursor) : undefined;
  const fetched = priceAll(await selectGroups(db, where, predicate, order, options.limit + 1), options.price);
  const items = fetched.slice(0, options.limit);
  const last = fetched.length > options.limit ? items[items.length - 1] : undefined;
  return {
    items,
    total,
    nextCursor: last ? encodeCursor(cursorOf(sort, last)) : null,
  };
}

export async function loadIssue(
  db: Db,
  projectId: string,
  hash: string,
  price: Price,
): Promise<{ group: PricedIssue; members: IssueMember[]; occurrencesByDay: { day: string; occurrences: number }[] } | null> {
  const where = and(eq(schema.findings.projectId, projectId), issueHashMatch(hash));
  if (!where) return null;
  const page = await listIssuePage(db, where, { sort: "last_seen", limit: 1, cursor: null, price });
  if ("error" in page || page.items.length === 0) return null;
  const group = page.items[0];
  if (!group) return null;
  const [members, days] = await Promise.all([
    selectMembers(db, projectId, hash),
    selectOccurrenceDays(db, projectId, hash),
  ]);
  return { group, members, occurrencesByDay: fillOccurrenceDays(days) };
}

export async function issueFindingIds(db: Db, projectId: string, hash: string): Promise<number[]> {
  const result = await db.execute<{ id: number | string }>(sql`
    select ${schema.findings.id} as id
    from ${schema.findings}
    where ${schema.findings.projectId} = ${projectId}
      and ${issueHashMatch(hash)}
    order by ${schema.findings.id}
  `);
  return rowsOf(result).map((row) => Number(row.id));
}

export async function issueOfFinding(
  db: Db,
  findingId: number,
  projectIds: string[],
): Promise<{ projectId: string; hash: string; issueId: string } | null> {
  if (projectIds.length === 0) return null;
  const [row] = await db
    .select({
      projectId: schema.findings.projectId,
      rule: schema.findings.rule,
      template: schema.findings.template,
      callsite: schema.findings.callsite,
    })
    .from(schema.findings)
    .where(and(eq(schema.findings.id, findingId), inArray(schema.findings.projectId, projectIds)))
    .limit(1);
  if (!row) return null;
  const hash = issueHash(row.rule, row.template, row.callsite);
  return { projectId: row.projectId, hash, issueId: `${row.projectId}:${hash}` };
}

type GroupSqlRow = {
  project_id: string;
  rule: string;
  template: string;
  callsite: string;
  sessions: number | string;
  occurrences: number | string;
  first_seen: Date | string;
  last_seen: Date | string;
  message: string;
  severity: string;
  provider: string;
  service: string;
  session: string;
  wasted_parts: unknown;
  any_open: boolean | string | null;
  latest_status: string | null;
  open_assignee: string | null;
  open_note: string | null;
  latest_assignee: string | null;
  latest_note: string | null;
};

function groupedSql(where: SQL): SQL {
  return sql`
    select
      ${schema.findings.projectId} as project_id,
      ${schema.findings.rule} as rule,
      ${schema.findings.template} as template,
      ${schema.findings.callsite} as callsite,
      count(distinct ${schema.findings.session})::int as sessions,
      sum(${schema.findings.occurrences})::int as occurrences,
      min(${schema.findings.firstSeen}) as first_seen,
      max(${schema.findings.lastSeen}) as last_seen,
      (array_agg(${schema.findings.message} order by ${schema.findings.lastSeen} desc, ${schema.findings.id} desc))[1] as message,
      (array_agg(${schema.findings.severity} order by ${schema.findings.lastSeen} desc, ${schema.findings.id} desc))[1] as severity,
      (array_agg(${schema.findings.provider} order by ${schema.findings.lastSeen} desc, ${schema.findings.id} desc))[1] as provider,
      (array_agg(${schema.findings.service} order by ${schema.findings.lastSeen} desc, ${schema.findings.id} desc))[1] as service,
      (array_agg(${schema.findings.session} order by ${schema.findings.lastSeen} desc, ${schema.findings.id} desc))[1] as session,
      coalesce(jsonb_agg(${schema.findings.wasted}), '[]'::jsonb) as wasted_parts,
      bool_or(coalesce(${schema.findingStates.status}, 'open') = 'open') as any_open,
      (array_agg(coalesce(${schema.findingStates.status}, 'open') order by ${schema.findingStates.updatedAt} desc nulls last, ${schema.findings.id} desc))[1] as latest_status,
      (array_agg(${schema.findingStates.assignee} order by ${schema.findingStates.updatedAt} desc nulls last, ${schema.findings.id} desc) filter (where coalesce(${schema.findingStates.status}, 'open') = 'open'))[1] as open_assignee,
      (array_agg(${schema.findingStates.note} order by ${schema.findingStates.updatedAt} desc nulls last, ${schema.findings.id} desc) filter (where coalesce(${schema.findingStates.status}, 'open') = 'open'))[1] as open_note,
      (array_agg(${schema.findingStates.assignee} order by ${schema.findingStates.updatedAt} desc nulls last, ${schema.findings.id} desc))[1] as latest_assignee,
      (array_agg(${schema.findingStates.note} order by ${schema.findingStates.updatedAt} desc nulls last, ${schema.findings.id} desc))[1] as latest_note
    from ${schema.findings}
    left join ${schema.findingStates} on ${schema.findingStates.findingId} = ${schema.findings.id}
    where ${where}
    group by ${schema.findings.projectId}, ${schema.findings.rule}, ${schema.findings.template}, ${schema.findings.callsite}
  `;
}

async function countGroups(db: Db, where: SQL): Promise<number> {
  const result = await db.execute<{ n: number | string }>(sql`
    select count(*)::int as n from (${groupedSql(where)}) as issues
  `);
  return Number(rowsOf(result)[0]?.n ?? 0);
}

async function selectGroups(
  db: Db,
  where: SQL,
  predicate: SQL | undefined,
  order: SQL | undefined,
  limit?: number,
): Promise<IssueGroup[]> {
  const filter = predicate ? sql`where ${predicate}` : sql``;
  const ordering = order ? sql`order by ${order}` : sql``;
  const limited = limit === undefined ? sql`` : sql`limit ${limit}`;
  const result = await db.execute<GroupSqlRow>(sql`
    select * from (${groupedSql(where)}) as issues
    ${filter}
    ${ordering}
    ${limited}
  `);
  return rowsOf(result).map(mapGroup);
}

function mapGroup(row: GroupSqlRow): IssueGroup {
  const anyOpen = row.any_open === true || row.any_open === "t" || row.any_open === "true";
  return {
    id: issueId(row.project_id, row.rule, row.template, row.callsite),
    projectId: row.project_id,
    rule: row.rule,
    severity: row.severity,
    provider: row.provider,
    service: row.service,
    template: row.template,
    session: row.session,
    callsite: row.callsite,
    message: row.message,
    occurrences: Number(row.occurrences),
    sessions: Number(row.sessions),
    firstSeen: asDate(row.first_seen),
    lastSeen: asDate(row.last_seen),
    wasted: sumWasted(row.wasted_parts),
    status: anyOpen ? "open" : (row.latest_status ?? "open"),
    assignee: (anyOpen ? row.open_assignee : row.latest_assignee) ?? null,
    note: (anyOpen ? row.open_note : row.latest_note) ?? null,
  };
}

async function selectMembers(db: Db, projectId: string, hash: string): Promise<IssueMember[]> {
  const result = await db.execute<{
    id: number | string;
    session: string;
    occurrences: number | string;
    last_seen: Date | string;
    evidence: unknown;
  }>(sql`
    select
      ${schema.findings.id} as id,
      ${schema.findings.session} as session,
      ${schema.findings.occurrences} as occurrences,
      ${schema.findings.lastSeen} as last_seen,
      ${schema.findings.evidence} as evidence
    from ${schema.findings}
    where ${schema.findings.projectId} = ${projectId}
      and ${issueHashMatch(hash)}
    order by ${schema.findings.lastSeen} desc, ${schema.findings.id} desc
    limit 20
  `);
  return rowsOf(result).map((row) => ({
    id: Number(row.id),
    session: row.session,
    occurrences: Number(row.occurrences),
    lastSeen: asDate(row.last_seen),
    evidence: asRecord(row.evidence),
  }));
}

async function selectOccurrenceDays(
  db: Db,
  projectId: string,
  hash: string,
): Promise<{ day: string; occurrences: number }[]> {
  const result = await db.execute<{ day: string; occurrences: number | string }>(sql`
    select to_char(${schema.findings.lastSeen} at time zone 'UTC', 'YYYY-MM-DD') as day,
           sum(${schema.findings.occurrences})::int as occurrences
    from ${schema.findings}
    where ${schema.findings.projectId} = ${projectId}
      and ${issueHashMatch(hash)}
    group by 1
    order by 1
  `);
  return rowsOf(result).map((row) => ({ day: String(row.day).slice(0, 10), occurrences: Number(row.occurrences) }));
}

function fillOccurrenceDays(points: { day: string; occurrences: number }[]): { day: string; occurrences: number }[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.day.localeCompare(b.day));
  const start = new Date(`${sorted[0]!.day}T00:00:00.000Z`);
  const end = new Date(`${sorted[sorted.length - 1]!.day}T00:00:00.000Z`);
  const span = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (span > 90) return sorted;
  const byDay = new Map(sorted.map((point) => [point.day, point.occurrences]));
  const out: { day: string; occurrences: number }[] = [];
  for (let i = 0; i <= span; i += 1) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + i);
    const key = day.toISOString().slice(0, 10);
    out.push({ day: key, occurrences: byDay.get(key) ?? 0 });
  }
  return out;
}

function priceAll(rows: IssueGroup[], price: Price): PricedIssue[] {
  return rows.map((row) => ({ ...row, wastedMicros: price(row) }));
}

interface GroupCursor {
  sort: GroupSort;
  projectId: string;
  rule: string;
  template: string;
  callsite: string;
  lastSeen?: string;
  occurrences?: number;
  sessions?: number;
}

interface WasteCursor {
  sort: "wasted_micros";
  id: string;
}

function readCursor(raw: string | null, sort: IssueSort): GroupCursor | WasteCursor | null | "bad" {
  if (!raw) return null;
  const value = decodeCursor(raw);
  if (!value || typeof value !== "object") return "bad";
  const record = value as Record<string, unknown>;
  if (record.sort !== sort) return "bad";
  if (sort === "wasted_micros") {
    if (typeof record.id !== "string") return "bad";
    return { sort, id: record.id };
  }
  if (
    typeof record.projectId !== "string" ||
    typeof record.rule !== "string" ||
    typeof record.template !== "string" ||
    typeof record.callsite !== "string"
  ) {
    return "bad";
  }
  const base = {
    sort,
    projectId: record.projectId,
    rule: record.rule,
    template: record.template,
    callsite: record.callsite,
  };
  if (sort === "last_seen") {
    if (typeof record.lastSeen !== "string") return "bad";
    return { ...base, lastSeen: record.lastSeen };
  }
  if (sort === "occurrences") {
    if (typeof record.occurrences !== "number") return "bad";
    return { ...base, occurrences: record.occurrences };
  }
  if (typeof record.sessions !== "number") return "bad";
  return { ...base, sessions: record.sessions };
}

function orderSql(sort: GroupSort): SQL {
  if (sort === "occurrences") return sql`occurrences desc, project_id desc, rule desc, template desc, callsite desc`;
  if (sort === "sessions") return sql`sessions desc, project_id desc, rule desc, template desc, callsite desc`;
  return sql`last_seen desc, project_id desc, rule desc, template desc, callsite desc`;
}

function keyset(sort: GroupSort, cursor: GroupCursor): SQL {
  if (sort === "occurrences") {
    return sql`(occurrences, project_id, rule, template, callsite) < (${cursor.occurrences}, ${cursor.projectId}, ${cursor.rule}, ${cursor.template}, ${cursor.callsite})`;
  }
  if (sort === "sessions") {
    return sql`(sessions, project_id, rule, template, callsite) < (${cursor.sessions}, ${cursor.projectId}, ${cursor.rule}, ${cursor.template}, ${cursor.callsite})`;
  }
  return sql`(last_seen, project_id, rule, template, callsite) < (${cursor.lastSeen}::timestamptz, ${cursor.projectId}, ${cursor.rule}, ${cursor.template}, ${cursor.callsite})`;
}

function cursorOf(sort: GroupSort, row: IssueGroup): GroupCursor {
  const base = {
    sort,
    projectId: row.projectId,
    rule: row.rule,
    template: row.template,
    callsite: row.callsite,
  };
  if (sort === "occurrences") return { ...base, occurrences: row.occurrences };
  if (sort === "sessions") return { ...base, sessions: row.sessions };
  return { ...base, lastSeen: row.lastSeen.toISOString() };
}

function sumWasted(value: unknown): Record<string, number> {
  let parts: unknown = value;
  if (typeof value === "string") {
    try {
      parts = JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  if (!Array.isArray(parts)) return {};
  const totals: Record<string, number> = {};
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    for (const [unit, amount] of Object.entries(part as Record<string, unknown>)) {
      const n = typeof amount === "number" ? amount : Number(amount);
      if (!Number.isFinite(n)) continue;
      totals[unit] = (totals[unit] ?? 0) + n;
    }
  }
  return totals;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function rowsOf<T>(result: readonly T[] | { rows: T[] }): T[] {
  if ("rows" in result) return result.rows;
  return [...result];
}
