import { hashApiKey, schema, type Db } from "@readmeter/db";
import { and, desc, eq, gte, inArray, isNull, like, sql, type SQL } from "drizzle-orm";

import {
  align,
  eventsJson,
  findingsJson,
  formatEvents,
  formatFindings,
  formatStats,
  initSnippet,
  labeled,
  stamp,
  statsJson,
  type EventView,
  type FindingView,
  type StatsView,
} from "./format.ts";
import { newApiKey, randomHashKey } from "./keys.ts";
import type { Command, Since } from "./parse.ts";

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

const SINCE_MS: Record<Since, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

const SEVERITY_RANK = sql`case ${schema.findings.severity}
  when 'critical' then 0
  when 'high' then 1
  when 'medium' then 2
  when 'low' then 3
  when 'info' then 4
  else 5 end`;

function pgCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return pgCode(error.cause);
  return undefined;
}

function whereAll(parts: (SQL | undefined)[]): SQL | undefined {
  const present = parts.filter((part): part is SQL => part !== undefined);
  if (present.length === 0) return undefined;
  return and(...present);
}

function asUnits(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, amount] of Object.entries(value)) {
    if (typeof amount === "number" && Number.isFinite(amount)) out[key] = amount;
    else if (typeof amount === "string" && amount !== "" && Number.isFinite(Number(amount))) out[key] = Number(amount);
  }
  return out;
}

async function requireProject(db: Db, id: string): Promise<{ hashKey: string }> {
  const [row] = await db
    .select({ hashKey: schema.projects.hashKey })
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
    .limit(1);
  if (!row) throw new CliError(`unknown project ${id}`);
  return row;
}

export async function run(db: Db, command: Command, now = new Date()): Promise<string> {
  switch (command.kind) {
    case "project-create":
      return createProject(db, command);
    case "key-create":
      return createKey(db, command);
    case "key-list":
      return listKeys(db, command.projectId);
    case "key-revoke":
      return revokeKey(db, command.prefix, now);
    case "findings":
      return listFindings(db, command, now);
    case "events":
      return listEvents(db, command);
    case "stats":
      return showStats(db, command, now);
  }
}

async function createProject(db: Db, command: Extract<Command, { kind: "project-create" }>): Promise<string> {
  const hashKey = randomHashKey();
  const orgName = command.org === "org_local" ? "Local" : command.org;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.organizations).values({ id: command.org, name: orgName }).onConflictDoNothing();
      await tx.insert(schema.projects).values({
        id: command.id,
        orgId: command.org,
        name: command.name,
        hashKey,
      });
    });
  } catch (error) {
    if (pgCode(error) === "23505") throw new CliError(`project ${command.id} already exists`);
    throw error;
  }
  return labeled([
    ["id", command.id],
    ["hash_key", hashKey],
  ]);
}

async function createKey(db: Db, command: Extract<Command, { kind: "key-create" }>): Promise<string> {
  const project = await requireProject(db, command.projectId);
  const { apiKey, prefix } = newApiKey();
  await db.insert(schema.apiKeys).values({
    projectId: command.projectId,
    keyHash: hashApiKey(apiKey),
    prefix,
    allowedOrigins: command.origins,
  });
  return `${labeled([
    ["key", apiKey],
    ["prefix", prefix],
    ["hash_key", project.hashKey],
  ])}\n\n${initSnippet(apiKey, project.hashKey)}`;
}

async function listKeys(db: Db, projectId: string): Promise<string> {
  await requireProject(db, projectId);
  const rows = await db
    .select({
      prefix: schema.apiKeys.prefix,
      allowedOrigins: schema.apiKeys.allowedOrigins,
      createdAt: schema.apiKeys.createdAt,
      revokedAt: schema.apiKeys.revokedAt,
    })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.projectId, projectId))
    .orderBy(desc(schema.apiKeys.createdAt));
  return align(
    ["prefix", "origins", "created", "revoked"],
    rows.map((row) => [
      row.prefix,
      row.allowedOrigins.length ? row.allowedOrigins.join(",") : "(any)",
      stamp(row.createdAt),
      row.revokedAt ? stamp(row.revokedAt) : "-",
    ]),
  );
}

async function revokeKey(db: Db, prefix: string, now: Date): Promise<string> {
  const needle = prefix.length >= 8 ? prefix.slice(0, 8) : prefix;
  const pattern = `${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const matches = await db
    .select({ id: schema.apiKeys.id, prefix: schema.apiKeys.prefix })
    .from(schema.apiKeys)
    .where(
      and(
        needle.length >= 8 ? eq(schema.apiKeys.prefix, needle) : like(schema.apiKeys.prefix, pattern),
        isNull(schema.apiKeys.revokedAt),
      ),
    );
  if (matches.length === 0) throw new CliError(`no active key with prefix ${prefix}`);
  if (needle.length < 8 && matches.length > 1) {
    throw new CliError(`prefix ${prefix} matches ${matches.length} keys; pass a longer prefix`);
  }
  await db
    .update(schema.apiKeys)
    .set({ revokedAt: now })
    .where(
      and(
        inArray(
          schema.apiKeys.id,
          matches.map((row) => row.id),
        ),
        isNull(schema.apiKeys.revokedAt),
      ),
    );
  const shown = matches.map((row) => row.prefix).join(", ");
  return `revoked ${matches.length} ${matches.length === 1 ? "key" : "keys"} (${shown})`;
}

async function listFindings(
  db: Db,
  command: Extract<Command, { kind: "findings" }>,
  now: Date,
): Promise<string> {
  if (command.project) await requireProject(db, command.project);
  const since = command.since ? new Date(now.getTime() - SINCE_MS[command.since]) : undefined;
  const rows = await db
    .select({
      severity: schema.findings.severity,
      rule: schema.findings.rule,
      template: schema.findings.template,
      callsite: schema.findings.callsite,
      occurrences: schema.findings.occurrences,
      wasted: schema.findings.wasted,
      lastSeen: schema.findings.lastSeen,
      message: schema.findings.message,
    })
    .from(schema.findings)
    .where(
      whereAll([
        command.project ? eq(schema.findings.projectId, command.project) : undefined,
        command.rule ? eq(schema.findings.rule, command.rule) : undefined,
        since ? gte(schema.findings.lastSeen, since) : undefined,
      ]),
    )
    .orderBy(SEVERITY_RANK, desc(schema.findings.lastSeen))
    .limit(command.limit);
  const views: FindingView[] = rows.map((row) => ({
    severity: row.severity,
    rule: row.rule,
    template: row.template,
    callsite: row.callsite,
    occurrences: row.occurrences,
    wasted: asUnits(row.wasted),
    lastSeen: row.lastSeen,
    message: row.message,
  }));
  return command.json ? findingsJson(views) : formatFindings(views, now);
}

async function listEvents(db: Db, command: Extract<Command, { kind: "events" }>): Promise<string> {
  if (command.project) await requireProject(db, command.project);
  const rows = await db
    .select({
      ts: schema.events.ts,
      op: schema.events.op,
      template: schema.events.template,
      items: schema.events.items,
      units: schema.events.units,
      signals: schema.events.signals,
    })
    .from(schema.events)
    .where(command.project ? eq(schema.events.projectId, command.project) : undefined)
    .orderBy(desc(schema.events.ts), desc(schema.events.id))
    .limit(command.limit);
  const views: EventView[] = rows.map((row) => ({
    ts: row.ts,
    op: row.op,
    template: row.template,
    items: row.items,
    units: asUnits(row.units),
    signals: row.signals,
  }));
  return command.json ? eventsJson(views) : formatEvents(views);
}

async function countOf(
  db: Db,
  table: typeof schema.batches | typeof schema.events | typeof schema.findings,
  project: string | undefined,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(project ? eq(table.projectId, project) : undefined);
  return Number(row?.n ?? 0);
}

async function showStats(
  db: Db,
  command: Extract<Command, { kind: "stats" }>,
  now: Date,
): Promise<string> {
  if (command.project) await requireProject(db, command.project);
  const dayAgo = new Date(now.getTime() - SINCE_MS["24h"]);
  const reads = sql<number>`coalesce(sum((${schema.events.units}->>'reads')::bigint), 0)::float8`;
  const [batches, events, findings, top] = await Promise.all([
    countOf(db, schema.batches, command.project),
    countOf(db, schema.events, command.project),
    countOf(db, schema.findings, command.project),
    db
      .select({ template: schema.events.template, reads })
      .from(schema.events)
      .where(
        whereAll([
          gte(schema.events.ts, dayAgo),
          command.project ? eq(schema.events.projectId, command.project) : undefined,
        ]),
      )
      .groupBy(schema.events.template)
      .orderBy(desc(reads))
      .limit(5),
  ]);
  const stats: StatsView = {
    batches,
    events,
    findings,
    topTemplates: top.map((row) => ({ template: row.template, reads: Number(row.reads) })),
  };
  return command.json ? statsJson(stats) : formatStats(stats);
}
