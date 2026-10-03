import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { schema, type Db } from "@readmeter/db";

import { SEVERITY_ORDER } from "../contract.ts";
import { priceGroups, type CatalogRule, type ServerCore } from "../core.ts";
import {
  decodeCursor,
  encodeCursor,
  fail,
  isoDay,
  likeContains,
  likePrefix,
  listQuery,
  parseTime,
  rangeWindow,
  requireRole,
  writeAudit,
  ws,
  type AppEnv,
} from "../http.ts";
import {
  ISSUE_SORTS,
  issueFindingIds,
  issueOfFinding,
  listIssuePage,
  loadIssue,
  parseIssueId,
  countOpenIssues,
  type IssueSort,
} from "../issues.ts";

const SEVERITIES = SEVERITY_ORDER;
const STATUSES = ["open", "resolved", "ignored"] as const;

const statusBody = z.object({
  status: z.enum(STATUSES).optional(),
  assignee: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});
const bulkBody = z.object({
  ids: z.array(z.union([z.number().int().positive(), z.string().min(1).max(300)])).min(1).max(200),
  status: z.enum(STATUSES),
});
const overrideBody = z.object({
  enabled: z.boolean().nullable().optional(),
  severity: z.enum(SEVERITIES).nullable().optional(),
  params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
});

type FindingItem = {
  id: number;
  projectId: string;
  rule: string;
  severity: string;
  provider: string;
  service: string;
  template: string;
  session: string;
  callsite: string;
  callsiteLabel: string | null;
  message: string;
  occurrences: number;
  firstSeen: Date;
  lastSeen: Date;
  wasted: Record<string, number>;
  status: string;
  assignee: string | null;
  note: string | null;
  wastedMicros: number;
};

export function telemetryRoutes(db: Db, core: ServerCore) {
  const app = new Hono<AppEnv>();
  const catalog = () => core.catalog().rules;

  app.get("/workspaces/:slug/findings", async (c) => {
    const { workspace } = ws(c);
    const query = listQuery(new URL(c.req.url));
    if ("error" in query) return fail(c, 400, "bad_request", query.error);
    const url = new URL(c.req.url);
    const projectIds = await orgProjects(db, workspace.id, url.searchParams.get("project"));
    if (projectIds === "missing") return fail(c, 404, "not_found", "project not found");
    const filters = findingFilters(url, projectIds);
    if ("error" in filters) return fail(c, 400, "bad_request", filters.error);
    const group = url.searchParams.get("group") ?? "issue";
    if (group !== "issue" && group !== "none") return fail(c, 400, "bad_request", "group must be issue or none");
    const sort = url.searchParams.get("sort") ?? "last_seen";
    if (group === "issue") {
      if (!ISSUE_SORTS.includes(sort as IssueSort)) {
        return fail(c, 400, "bad_request", "sort must be last_seen, occurrences, wasted_micros, or sessions");
      }
      if (!filters.where) return c.json({ items: [], nextCursor: null, total: 0 });
      const page = await listIssuePage(db, filters.where, {
        sort: sort as IssueSort,
        limit: query.limit,
        cursor: query.cursor,
        price: (row) => wastedMicros(core, row),
      });
      if ("error" in page) return fail(c, 400, "bad_request", page.error);
      return c.json(page);
    }
    if (sort !== "last_seen" && sort !== "occurrences" && sort !== "wasted_micros") {
      return fail(c, 400, "bad_request", "sort must be last_seen, occurrences, or wasted_micros");
    }
    const rows = await selectFindings(db, filters.where);
    const priced = rows.map((row) => ({ ...row, wastedMicros: wastedMicros(core, row), sessions: 1 }));
    const page =
      sort === "wasted_micros"
        ? slicePriced(
            priced.sort((a, b) => b.wastedMicros - a.wastedMicros || b.id - a.id),
            query.limit,
            query.cursor,
          )
        : sliceSql(priced, sort, query.limit, query.cursor);
    if ("error" in page) return fail(c, 400, "bad_request", "invalid cursor");
    return c.json({ ...page, total: priced.length });
  });

  app.post("/workspaces/:slug/findings/bulk", async (c) => {
    const { workspace, user } = ws(c);
    const parsed = bulkBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", parsed.error.issues[0]?.message ?? "invalid body");
    const projectIds = await orgProjects(db, workspace.id, null);
    if (projectIds === "missing" || projectIds.length === 0) return c.json({ updated: 0 });
    const seen = new Set<string>();
    let updated = 0;
    for (const raw of parsed.data.ids) {
      const target = await resolveIssue(db, projectIds, String(raw));
      if (!target || seen.has(target.issueId)) continue;
      seen.add(target.issueId);
      for (const id of target.findingIds) {
        await upsertStatus(db, id, parsed.data.status, user.id);
      }
      updated += target.findingIds.length;
      await writeAudit(db, {
        orgId: workspace.id,
        actor: user.id,
        action: "finding.status",
        target: target.issueId,
        metadata: { status: parsed.data.status, ids: target.findingIds },
      });
    }
    return c.json({ updated });
  });

  app.get("/workspaces/:slug/findings/:id", async (c) => {
    const { workspace } = ws(c);
    const projectIds = await orgProjects(db, workspace.id, null);
    if (projectIds === "missing" || projectIds.length === 0) return fail(c, 404, "not_found", "finding not found");
    const located = await locateIssue(db, projectIds, pathId(c.req.param("id")));
    if (located === "bad") return fail(c, 400, "bad_request", "invalid finding id");
    if (!located) return fail(c, 404, "not_found", "finding not found");
    const loaded = await loadIssue(db, located.projectId, located.hash, (row) => wastedMicros(core, row));
    if (!loaded) return fail(c, 404, "not_found", "finding not found");
    const rule = catalog().find((item) => item.id === loaded.group.rule) ?? null;
    return c.json({
      ...loaded.group,
      evidence: loaded.members[0]?.evidence ?? {},
      rule,
      members: loaded.members,
      occurrencesByDay: loaded.occurrencesByDay,
    });
  });

  app.patch("/workspaces/:slug/findings/:id", async (c) => {
    const { workspace, user } = ws(c);
    const parsed = statusBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", parsed.error.issues[0]?.message ?? "invalid body");
    if (
      parsed.data.status === undefined &&
      parsed.data.assignee === undefined &&
      parsed.data.note === undefined
    ) {
      return fail(c, 400, "bad_request", "nothing to update");
    }
    const projectIds = await orgProjects(db, workspace.id, null);
    if (projectIds === "missing" || projectIds.length === 0) return fail(c, 404, "not_found", "finding not found");
    const located = await locateIssue(db, projectIds, pathId(c.req.param("id")));
    if (located === "bad") return fail(c, 400, "bad_request", "invalid finding id");
    if (!located) return fail(c, 404, "not_found", "finding not found");
    const findingIds = await issueFindingIds(db, located.projectId, located.hash);
    if (findingIds.length === 0) return fail(c, 404, "not_found", "finding not found");
    if (parsed.data.assignee) {
      const [member] = await db
        .select({ id: schema.members.id })
        .from(schema.members)
        .where(
          and(eq(schema.members.organizationId, workspace.id), eq(schema.members.userId, parsed.data.assignee)),
        )
        .limit(1);
      if (!member) return fail(c, 400, "bad_request", "assignee is not a member of this workspace");
    }
    for (const id of findingIds) {
      await upsertState(db, id, parsed.data, user.id);
    }
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "finding.status",
      target: located.issueId,
      metadata: { ...parsed.data, ids: findingIds },
    });
    const loaded = await loadIssue(db, located.projectId, located.hash, (row) => wastedMicros(core, row));
    if (!loaded) return fail(c, 404, "not_found", "finding not found");
    return c.json(loaded.group);
  });

  app.get("/workspaces/:slug/events", async (c) => {
    const { workspace } = ws(c);
    const query = listQuery(new URL(c.req.url));
    if ("error" in query) return fail(c, 400, "bad_request", query.error);
    const url = new URL(c.req.url);
    const projectIds = await orgProjects(db, workspace.id, url.searchParams.get("project"));
    if (projectIds === "missing") return fail(c, 404, "not_found", "project not found");
    if (projectIds.length === 0) return c.json({ items: [], nextCursor: null });
    const from = parseTime(url.searchParams.get("from"));
    const to = parseTime(url.searchParams.get("to"));
    if (from === "bad" || to === "bad") return fail(c, 400, "bad_request", "from and to must be timestamps");
    const filters = [
      inArray(schema.events.projectId, projectIds),
      url.searchParams.get("op") ? eq(schema.events.op, url.searchParams.get("op")!) : undefined,
      url.searchParams.get("service") ? eq(schema.events.service, url.searchParams.get("service")!) : undefined,
      url.searchParams.get("template") ? eq(schema.events.template, url.searchParams.get("template")!) : undefined,
      url.searchParams.get("session") ? eq(schema.events.session, url.searchParams.get("session")!) : undefined,
      from ? gte(schema.events.ts, from) : undefined,
      to ? lte(schema.events.ts, to) : undefined,
    ];
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !isTupleCursor(cursor)) return fail(c, 400, "bad_request", "invalid cursor");
    if (isTupleCursor(cursor)) {
      filters.push(
        sql`(${schema.events.ts}, ${schema.events.id}) < (${new Date(cursor.ts).toISOString()}::timestamptz, ${cursor.id})`,
      );
    }
    const rows = await db
      .select({
        id: schema.events.id,
        projectId: schema.events.projectId,
        ts: schema.events.ts,
        session: schema.events.session,
        provider: schema.events.provider,
        service: schema.events.service,
        op: schema.events.op,
        template: schema.events.template,
        callsite: schema.events.callsite,
        callsiteLabel: schema.events.callsiteLabel,
        units: schema.events.units,
        items: schema.events.items,
        bytes: schema.events.bytes,
        fromCache: schema.events.fromCache,
        errorCode: schema.events.errorCode,
        platform: schema.events.platform,
        signals: schema.events.signals,
        opDetail: schema.events.opDetail,
        query: schema.events.query,
        durationUs: schema.events.durationUs,
        listener: schema.events.listener,
        mount: schema.events.mount,
        dev: schema.events.dev,
        attempt: schema.events.attempt,
        targetKey: schema.events.targetKey,
        idShape: schema.events.idShape,
        collectionGroup: schema.events.collectionGroup,
      })
      .from(schema.events)
      .where(and(...filters))
      .orderBy(desc(schema.events.ts), desc(schema.events.id))
      .limit(query.limit + 1);
    const items = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? items[items.length - 1] : undefined;
    return c.json({
      items,
      nextCursor: last ? encodeCursor({ ts: last.ts.toISOString(), id: last.id }) : null,
    });
  });

  app.get("/workspaces/:slug/rules", async (c) => {
    const { workspace } = ws(c);
    const project = new URL(c.req.url).searchParams.get("project");
    let overrides = new Map<string, { enabled: boolean | null; severity: string | null; params: Record<string, unknown> | null }>();
    if (project) {
      const projectIds = await orgProjects(db, workspace.id, project);
      if (projectIds === "missing") return fail(c, 404, "not_found", "project not found");
      const rows = await db
        .select()
        .from(schema.ruleOverrides)
        .where(eq(schema.ruleOverrides.projectId, project));
      overrides = new Map(rows.map((row) => [row.rule, row]));
    }
    return c.json({
      rules: catalog().map((rule) => ({
        ...rule,
        ...(project
          ? { effective: effective(rule, overrides.get(rule.id)) }
          : {}),
      })),
    });
  });

  app.put("/workspaces/:slug/projects/:projectId/rules/:ruleId", requireRole("admin"), async (c) => {
    const { workspace, user } = ws(c);
    const project = await ownedProject(db, workspace.id, c.req.param("projectId"));
    if (!project) return fail(c, 404, "not_found", "project not found");
    const ruleId = decodeRuleId(c.req.param("ruleId"));
    const rule = catalog().find((item) => item.id === ruleId);
    if (!rule) return fail(c, 404, "not_found", "rule not found");
    const parsed = overrideBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", parsed.error.issues[0]?.message ?? "invalid body");
    if (
      parsed.data.enabled === undefined &&
      parsed.data.severity === undefined &&
      parsed.data.params === undefined
    ) {
      return fail(c, 400, "bad_request", "nothing to override");
    }
    const paramsError = validateParams(rule, parsed.data.params);
    if (paramsError) return fail(c, 400, "bad_request", paramsError);
    const [saved] = await db
      .insert(schema.ruleOverrides)
      .values({
        projectId: project.id,
        rule: ruleId,
        enabled: parsed.data.enabled ?? null,
        severity: parsed.data.severity ?? null,
        params: parsed.data.params ?? null,
        updatedBy: user.id,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.ruleOverrides.projectId, schema.ruleOverrides.rule],
        set: {
          enabled: parsed.data.enabled ?? null,
          severity: parsed.data.severity ?? null,
          params: parsed.data.params ?? null,
          updatedBy: user.id,
          updatedAt: new Date(),
        },
      })
      .returning();
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "rule.override",
      target: `${project.id}:${ruleId}`,
      metadata: parsed.data,
    });
    return c.json(saved);
  });

  app.delete("/workspaces/:slug/projects/:projectId/rules/:ruleId", requireRole("admin"), async (c) => {
    const { workspace, user } = ws(c);
    const project = await ownedProject(db, workspace.id, c.req.param("projectId"));
    if (!project) return fail(c, 404, "not_found", "project not found");
    const ruleId = decodeRuleId(c.req.param("ruleId"));
    const [removed] = await db
      .delete(schema.ruleOverrides)
      .where(and(eq(schema.ruleOverrides.projectId, project.id), eq(schema.ruleOverrides.rule, ruleId)))
      .returning({ id: schema.ruleOverrides.id });
    if (!removed) return fail(c, 404, "not_found", "override not found");
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "rule.override",
      target: `${project.id}:${ruleId}`,
      metadata: { deleted: true },
    });
    return c.json({ ok: true });
  });

  app.get("/workspaces/:slug/overview", async (c) => {
    const { workspace } = ws(c);
    const url = new URL(c.req.url);
    const range = url.searchParams.get("range") ?? "7d";
    const window = rangeWindow(range);
    if (!window) return fail(c, 400, "bad_request", "range must be 7d, 30d, or 90d");
    const projectIds = await orgProjects(db, workspace.id, url.searchParams.get("project"));
    if (projectIds === "missing") return fail(c, 404, "not_found", "project not found");
    return c.json(await overview(db, core, projectIds, window.days, window.from));
  });

  app.get("/workspaces/:slug/costs", async (c) => {
    const { workspace } = ws(c);
    const url = new URL(c.req.url);
    const range = url.searchParams.get("range") ?? "7d";
    const window = rangeWindow(range);
    if (!window) return fail(c, 400, "bad_request", "range must be 7d, 30d, or 90d");
    const groupBy = url.searchParams.get("groupBy") ?? "service";
    if (groupBy !== "service" && groupBy !== "rule" && groupBy !== "template" && groupBy !== "day") {
      return fail(c, 400, "bad_request", "groupBy must be service, rule, template, or day");
    }
    const projectIds = await orgProjects(db, workspace.id, url.searchParams.get("project"));
    if (projectIds === "missing") return fail(c, 404, "not_found", "project not found");
    const items =
      groupBy === "rule"
        ? await costByRule(db, core, projectIds, window.from)
        : await costFromEvents(db, core, projectIds, window.from, groupBy);
    const daily =
      groupBy === "day" ? items : await costFromEvents(db, core, projectIds, window.from, "day");
    const billed = await billedCosts(db, projectIds, window.from);
    const days = dayKeys(window.from, window.days);
    const estimatedByDay = new Map(daily.map((item) => [item.key, item.micros]));
    const comparison = days.map((day) => ({
      day,
      estimatedMicros: estimatedByDay.get(day) ?? 0,
      billedMicros: billed.byDay.get(day) ?? 0,
    }));
    const estimatedMicros = comparison.reduce((sum, point) => sum + point.estimatedMicros, 0);
    return c.json({
      source: billed.rows > 0 ? "billed" : "estimate",
      currency: billed.currency,
      groupBy,
      range,
      items,
      estimatedMicros,
      billedMicros: billed.rows > 0 ? billed.net : null,
      billedBySku: billed.skus,
      comparison,
      sdkCoverage: await sdkCoverage(db, projectIds, window.from),
    });
  });

  app.get("/workspaces/:slug/audit", requireRole("admin"), async (c) => {
    const { workspace } = ws(c);
    const query = listQuery(new URL(c.req.url));
    if ("error" in query) return fail(c, 400, "bad_request", query.error);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !isTupleCursor(cursor)) return fail(c, 400, "bad_request", "invalid cursor");
    const filters = [eq(schema.auditLog.orgId, workspace.id)];
    if (isTupleCursor(cursor)) {
      filters.push(
        sql`(${schema.auditLog.at}, ${schema.auditLog.id}) < (${new Date(cursor.ts).toISOString()}::timestamptz, ${cursor.id})`,
      );
    }
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(and(...filters))
      .orderBy(desc(schema.auditLog.at), desc(schema.auditLog.id))
      .limit(query.limit + 1);
    const items = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? items[items.length - 1] : undefined;
    return c.json({
      items,
      nextCursor: last ? encodeCursor({ ts: last.at.toISOString(), id: last.id }) : null,
    });
  });

  return app;
}

async function orgProjects(db: Db, orgId: string, project: string | null): Promise<string[] | "missing"> {
  const rows = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.orgId, orgId));
  const ids = rows.map((row) => row.id);
  if (!project) return ids;
  return ids.includes(project) ? [project] : "missing";
}

function findingFilters(url: URL, projectIds: string[]): { where: ReturnType<typeof and> } | { error: string } {
  const params = url.searchParams;
  const from = parseTime(params.get("from"));
  const to = parseTime(params.get("to"));
  if (from === "bad" || to === "bad") return { error: "from and to must be timestamps" };
  const severities = [
    ...params.getAll("severity").flatMap((value) => value.split(",").map((part) => part.trim())),
  ].filter((value) => value.length > 0);
  for (const severity of severities) {
    if (!SEVERITIES.includes(severity as (typeof SEVERITIES)[number])) return { error: "unknown severity" };
  }
  const status = params.get("status");
  if (status && !STATUSES.includes(status as (typeof STATUSES)[number])) return { error: "unknown status" };
  const q = params.get("q");
  const template = params.get("template");
  const where = and(
    projectIds.length > 0 ? inArray(schema.findings.projectId, projectIds) : sql`false`,
    severities.length > 0 ? inArray(schema.findings.severity, severities) : undefined,
    params.get("rule") ? eq(schema.findings.rule, params.get("rule")!) : undefined,
    params.get("service") ? eq(schema.findings.service, params.get("service")!) : undefined,
    status ? sql`coalesce(${schema.findingStates.status}, 'open') = ${status}` : undefined,
    template ? sql`${schema.findings.template} like ${likePrefix(template)} escape '\\'` : undefined,
    from ? gte(schema.findings.lastSeen, from) : undefined,
    to ? lte(schema.findings.lastSeen, to) : undefined,
    q
      ? sql`(
          ${schema.findings.message} ilike ${likeContains(q)} escape '\\'
          or ${schema.findings.rule} ilike ${likeContains(q)} escape '\\'
          or ${schema.findings.template} ilike ${likeContains(q)} escape '\\'
        )`
      : undefined,
  );
  return { where };
}

async function selectFindings(db: Db, where: ReturnType<typeof and>) {
  return db
    .select({
      id: schema.findings.id,
      projectId: schema.findings.projectId,
      rule: schema.findings.rule,
      severity: schema.findings.severity,
      provider: schema.findings.provider,
      service: schema.findings.service,
      template: schema.findings.template,
      session: schema.findings.session,
      callsite: schema.findings.callsite,
      callsiteLabel: schema.findings.callsiteLabel,
      message: schema.findings.message,
      occurrences: schema.findings.occurrences,
      firstSeen: schema.findings.firstSeen,
      lastSeen: schema.findings.lastSeen,
      wasted: schema.findings.wasted,
      evidence: schema.findings.evidence,
      status: sql<string>`coalesce(${schema.findingStates.status}, 'open')`,
      assignee: schema.findingStates.assignee,
      note: schema.findingStates.note,
    })
    .from(schema.findings)
    .leftJoin(schema.findingStates, eq(schema.findingStates.findingId, schema.findings.id))
    .where(where)
    .orderBy(desc(schema.findings.lastSeen), desc(schema.findings.id));
}

function wastedMicros(
  core: ServerCore,
  row: { provider: string; service: string; wasted: Record<string, number> },
): number {
  return priceGroups(
    core,
    Object.entries(row.wasted).map(([unit, amount]) => ({
      provider: row.provider,
      service: row.service,
      unit,
      amount,
    })),
  );
}

function sliceSql(rows: FindingItem[], sort: string, limit: number, cursor: string | null) {
  const ordered =
    sort === "occurrences"
      ? [...rows].sort((a, b) => b.occurrences - a.occurrences || b.id - a.id)
      : rows;
  return pageByCursor(ordered, limit, cursor, (row) =>
    sort === "occurrences"
      ? { occurrences: row.occurrences, id: row.id }
      : { ts: row.lastSeen.toISOString(), id: row.id },
  );
}

function slicePriced(rows: FindingItem[], limit: number, cursor: string | null) {
  return pageByCursor(rows, limit, cursor, (row) => ({ wastedMicros: row.wastedMicros, id: row.id }));
}

function pageByCursor<T extends { id: number }>(
  rows: T[],
  limit: number,
  cursor: string | null,
  keyOf: (row: T) => Record<string, unknown>,
) {
  let start = 0;
  if (cursor) {
    const decoded = decodeCursor(cursor) as { id?: unknown } | null;
    if (!decoded || typeof decoded.id !== "number") return { error: true as const };
    const at = rows.findIndex((row) => row.id === decoded.id);
    if (at < 0) return { error: true as const };
    start = at + 1;
  }
  const page = rows.slice(start, start + limit + 1);
  const items = page.slice(0, limit).map((row) => stripEvidence(row));
  const last = page.length > limit ? page[limit - 1] : undefined;
  return { items, nextCursor: last ? encodeCursor(keyOf(last)) : null };
}

function stripEvidence<T extends { id: number }>(row: T): Omit<T, "evidence"> {
  const copy = { ...row };
  delete (copy as { evidence?: unknown }).evidence;
  return copy;
}

function pathId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function locateIssue(
  db: Db,
  projectIds: string[],
  raw: string,
): Promise<{ projectId: string; hash: string; issueId: string } | "bad" | null> {
  const parsed = parseIssueId(raw);
  if (parsed) {
    if (!projectIds.includes(parsed.projectId)) return null;
    const ids = await issueFindingIds(db, parsed.projectId, parsed.hash);
    if (ids.length === 0) return null;
    return { projectId: parsed.projectId, hash: parsed.hash, issueId: `${parsed.projectId}:${parsed.hash}` };
  }
  if (!/^[1-9]\d*$/.test(raw)) return "bad";
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) return "bad";
  return issueOfFinding(db, id, projectIds);
}

async function resolveIssue(db: Db, projectIds: string[], raw: string) {
  const located = await locateIssue(db, projectIds, raw);
  if (!located || located === "bad") return null;
  const findingIds = await issueFindingIds(db, located.projectId, located.hash);
  if (findingIds.length === 0) return null;
  return { ...located, findingIds };
}

function isTupleCursor(value: unknown): value is { ts: string; id: number } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { ts?: unknown }).ts === "string" &&
    typeof (value as { id?: unknown }).id === "number"
  );
}

function decodeRuleId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function effective(
  rule: CatalogRule,
  override: { enabled: boolean | null; severity: string | null; params: Record<string, unknown> | null } | undefined,
) {
  return {
    enabled: override?.enabled ?? rule.default_enabled,
    severity: override?.severity ?? rule.severity,
    params: { ...rule.params, ...(override?.params ?? {}) },
    overridden: Boolean(override),
  };
}

function paramKind(value: unknown): "bool" | "int" | "float" | "string" | "invalid" {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number" && Number.isInteger(value)) return "int";
  if (typeof value === "number" && Number.isFinite(value)) return "float";
  if (typeof value === "string") return "string";
  return "invalid";
}

function kindsMatch(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  return expected === "float" && actual === "int";
}

function validateParams(rule: CatalogRule, params: Record<string, number | boolean | string> | undefined): string | null {
  if (!params) return null;
  for (const [name, value] of Object.entries(params)) {
    if (!(name in rule.params)) return `unknown param ${name}`;
    const expected = paramKind(rule.params[name]);
    const actual = paramKind(value);
    if (!kindsMatch(expected, actual)) return `param ${name} must be ${expected}`;
  }
  return null;
}

async function upsertStatus(db: Db, findingId: number, status: string, actor: string) {
  await upsertState(db, findingId, { status }, actor);
}

async function upsertState(
  db: Db,
  findingId: number,
  patch: { status?: string; assignee?: string | null; note?: string | null },
  actor: string,
) {
  const [existing] = await db
    .select()
    .from(schema.findingStates)
    .where(eq(schema.findingStates.findingId, findingId))
    .limit(1);
  const next = {
    status: patch.status ?? existing?.status ?? "open",
    assignee: patch.assignee !== undefined ? patch.assignee : (existing?.assignee ?? null),
    note: patch.note !== undefined ? patch.note : (existing?.note ?? null),
    updatedBy: actor,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(schema.findingStates).set(next).where(eq(schema.findingStates.findingId, findingId));
  } else {
    await db.insert(schema.findingStates).values({ findingId, ...next });
  }
}

async function ownedProject(db: Db, orgId: string, projectId: string) {
  const [project] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, orgId)))
    .limit(1);
  return project ?? null;
}

/**
 * Events since `from` (a UTC day start), one row per raw event or per
 * `events_daily` row: rolled-up days come from the rollup, everything not
 * rolled up yet from `events`. The predicate matches `events_rollup_state`
 * (see packages/db/src/schema.ts), so no event is counted twice or missed,
 * and history survives raw retention. Columns: project_id, day
 * (`YYYY-MM-DD`), provider, service, op, template, callsite (null when
 * unknown), callsite_label, n (events), units.
 */
function eventFacts(projectIds: string[], from: Date) {
  const fromTs = from.toISOString();
  const fromDay = fromTs.slice(0, 10);
  return sql`(
    select r.project_id, r.day::text as day, r.provider, r.service, r.op, r.template,
           nullif(r.callsite, '') as callsite, r.callsite_label, r.events as n, r.units
    from ${schema.eventsDaily} r
    where ${inArray(sql`r.project_id`, projectIds)}
      and r.day >= ${fromDay}::date
    union all
    select e.project_id, to_char(e.ts at time zone 'UTC', 'YYYY-MM-DD') as day, e.provider, e.service,
           e.op, e.template, e.callsite, e.callsite_label, 1::bigint as n, e.units
    from ${schema.events} e
    left join ${schema.eventsRollupState} s on s.project_id = e.project_id
    where ${inArray(sql`e.project_id`, projectIds)}
      and e.ts >= ${fromTs}::timestamptz
      and (e.id > coalesce(s.rolled_event_id, 0)
           or e.ts >= coalesce(s.rolled_until, '1970-01-01'::date)::timestamp at time zone 'UTC')
  ) as f`;
}

async function unitRows(db: Db, projectIds: string[], from: Date, byDay: boolean) {
  if (projectIds.length === 0) return [];
  const result = await db.execute<{
    bucket: string | null;
    provider: string;
    service: string;
    unit: string;
    amount: string;
  }>(sql`
    select ${byDay ? sql`f.day` : sql`null`} as bucket,
           f.provider as provider,
           f.service as service,
           u.key as unit,
           sum((u.value)::text::numeric) as amount
    from ${eventFacts(projectIds, from)}
    cross join lateral jsonb_each(f.units) as u(key, value)
    group by 1, 2, 3, 4
  `);
  return rowsOf(result);
}

async function overview(
  db: Db,
  core: ServerCore,
  projectIds: string[],
  days: number,
  from: Date,
) {
  const emptySeries = fillDays(core, from, days, new Map()).map((point) => ({
    ...point,
    billedCostMicros: 0,
    wastedMicros: 0,
  }));
  if (projectIds.length === 0) {
    return {
      rangeDays: days,
      from,
      kpis: {
        events: 0,
        billedUnits: 0,
        estimatedCostMicros: 0,
        costLabel: "Estimated" as const,
        costMicros: 0,
        billedCostMicros: null,
        wastedMicros: 0,
        openFindings: 0,
        openIssues: 0,
      },
      series: emptySeries,
      sdkCoverage: null,
      topRules: [],
      topTemplates: [],
      topCallsites: [],
      openFindingsBySeverity: {},
    };
  }
  const dailyUnits = await unitRows(db, projectIds, from, true);
  const rangeUnits = await unitRows(db, projectIds, from, false);
  const counts = await db.execute<{ day: Date | string; events: string }>(sql`
    select f.day as day, sum(f.n)::bigint as events
    from ${eventFacts(projectIds, from)}
    group by 1
    order by 1
  `);
  const byDay = new Map<string, { events: number; units: { provider: string; service: string; unit: string; amount: number }[] }>();
  for (const row of rowsOf(counts)) {
    const day = isoDay(row.day);
    byDay.set(day, { events: Number(row.events), units: [] });
  }
  for (const row of dailyUnits) {
    if (!row.bucket) continue;
    const day = isoDay(row.bucket);
    const slot = byDay.get(day) ?? { events: 0, units: [] };
    slot.units.push({
      provider: row.provider,
      service: row.service,
      unit: row.unit,
      amount: Number(row.amount),
    });
    byDay.set(day, slot);
  }
  const wastedByDay = await wastedBy(db, core, projectIds, from, "day");
  const billed = await billedCosts(db, projectIds, from);
  const series = fillDays(core, from, days, byDay).map((point) => ({
    ...point,
    wastedMicros: wastedByDay.get(point.day) ?? 0,
    billedCostMicros: billed.byDay.get(point.day) ?? 0,
  }));
  const eventTotal = [...byDay.values()].reduce((sum, slot) => sum + slot.events, 0);
  const billedUnits = rangeUnits.reduce((sum, row) => sum + Number(row.amount), 0);
  const estimatedCostMicros = priceGroups(
    core,
    rangeUnits.map((row) => ({
      provider: row.provider,
      service: row.service,
      unit: row.unit,
      amount: Number(row.amount),
    })),
  );
  const hasBilled = billed.rows > 0;
  const wastedMicrosTotal = [...wastedByDay.values()].reduce((sum, value) => sum + value, 0);
  const open = await db.execute<{ severity: string; n: string }>(sql`
    select ${schema.findings.severity} as severity, count(*)::int as n
    from ${schema.findings}
    left join ${schema.findingStates} on ${schema.findingStates.findingId} = ${schema.findings.id}
    where ${inArray(schema.findings.projectId, projectIds)}
      and coalesce(${schema.findingStates.status}, 'open') = 'open'
    group by 1
  `);
  const openCounts = new Map(rowsOf(open).map((row) => [row.severity, Number(row.n)]));
  const openFindingsBySeverity: Record<string, number> = {};
  let openFindings = 0;
  for (const severity of SEVERITY_ORDER) {
    const n = openCounts.get(severity) ?? 0;
    if (n > 0) openFindingsBySeverity[severity] = n;
    openFindings += n;
  }
  const openIssues = await countOpenIssues(db, projectIds);
  const templateRows = await db.execute<{ template: string; events: string }>(sql`
    select f.template as template, sum(f.n)::bigint as events
    from ${eventFacts(projectIds, from)}
    group by 1
    order by 2 desc, 1
    limit 10
  `);
  const templates = rowsOf(templateRows).map((row) => ({ template: row.template, events: Number(row.events) }));
  const callsiteRows = await db.execute<{ callsite: string; callsite_label: string | null; events: string }>(sql`
    select f.callsite as callsite, max(f.callsite_label) as callsite_label, sum(f.n)::bigint as events
    from ${eventFacts(projectIds, from)}
    where f.callsite is not null and f.callsite <> ''
    group by 1
    order by 3 desc, 1
    limit 10
  `);
  const callsites = rowsOf(callsiteRows).map((row) => ({
    callsite: row.callsite,
    callsiteLabel: row.callsite_label,
    events: Number(row.events),
  }));
  const titles = new Map(core.catalog().rules.map((rule) => [rule.id, rule.title]));
  const topRules = [...(await wastedBy(db, core, projectIds, from, "rule")).entries()]
    .map(([rule, micros]) => ({ rule, title: titles.get(rule) ?? rule, wastedMicros: micros }))
    .sort((a, b) => b.wastedMicros - a.wastedMicros)
    .slice(0, 10);
  return {
    rangeDays: days,
    from,
    kpis: {
      events: eventTotal,
      billedUnits,
      estimatedCostMicros,
      costLabel: hasBilled ? ("Billed" as const) : ("Estimated" as const),
      costMicros: hasBilled ? billed.net : estimatedCostMicros,
      billedCostMicros: hasBilled ? billed.net : null,
      wastedMicros: wastedMicrosTotal,
      openFindings,
      openIssues,
    },
    series,
    sdkCoverage: await sdkCoverage(db, projectIds, from),
    topRules,
    topTemplates: templates,
    topCallsites: callsites,
    openFindingsBySeverity,
  };
}

function fillDays(
  core: ServerCore,
  from: Date,
  days: number,
  byDay: Map<string, { events: number; units: { provider: string; service: string; unit: string; amount: number }[] }>,
) {
  const series = [];
  for (let i = 0; i < days; i += 1) {
    const day = new Date(from);
    day.setUTCDate(from.getUTCDate() + i);
    const key = isoDay(day);
    const slot = byDay.get(key);
    const units = slot?.units ?? [];
    series.push({
      day: key,
      events: slot?.events ?? 0,
      billedUnits: units.reduce((sum, unit) => sum + unit.amount, 0),
      estimatedCostMicros: priceGroups(core, units),
    });
  }
  return series;
}

async function wastedBy(db: Db, core: ServerCore, projectIds: string[], from: Date, kind: "day" | "rule") {
  const totals = new Map<string, number>();
  if (projectIds.length === 0) return totals;
  const rows = await db
    .select({
      rule: schema.findings.rule,
      provider: schema.findings.provider,
      service: schema.findings.service,
      lastSeen: schema.findings.lastSeen,
      wasted: schema.findings.wasted,
    })
    .from(schema.findings)
    .where(and(inArray(schema.findings.projectId, projectIds), gte(schema.findings.lastSeen, from)))
    .orderBy(asc(schema.findings.id));
  const groups = new Map<string, { provider: string; service: string; unit: string; amount: number }[]>();
  for (const row of rows) {
    const key = kind === "day" ? isoDay(row.lastSeen) : row.rule;
    const list = groups.get(key) ?? [];
    for (const [unit, amount] of Object.entries(row.wasted)) {
      list.push({ provider: row.provider, service: row.service, unit, amount });
    }
    groups.set(key, list);
  }
  for (const [key, units] of groups) totals.set(key, priceGroups(core, units));
  return totals;
}

async function costFromEvents(
  db: Db,
  core: ServerCore,
  projectIds: string[],
  from: Date,
  groupBy: "service" | "template" | "day",
) {
  if (projectIds.length === 0) return [];
  const bucket =
    groupBy === "day" ? sql`f.day` : groupBy === "template" ? sql`f.template` : sql`f.provider || '/' || f.service`;
  const result = await db.execute<{
    key: string;
    provider: string;
    service: string;
    unit: string;
    amount: string;
  }>(sql`
    select ${bucket} as key,
           f.provider as provider,
           f.service as service,
           u.key as unit,
           sum((u.value)::text::numeric) as amount
    from ${eventFacts(projectIds, from)}
    cross join lateral jsonb_each(f.units) as u(key, value)
    group by 1, 2, 3, 4
  `);
  const grouped = new Map<string, { provider: string; service: string; unit: string; amount: number }[]>();
  for (const row of rowsOf(result)) {
    const list = grouped.get(row.key) ?? [];
    list.push({ provider: row.provider, service: row.service, unit: row.unit, amount: Number(row.amount) });
    grouped.set(row.key, list);
  }
  return [...grouped.entries()]
    .map(([key, units]) => ({
      key,
      micros: priceGroups(core, units),
      units: Object.fromEntries(units.map((unit) => [unit.unit, unit.amount])),
    }))
    .sort((a, b) => b.micros - a.micros);
}

async function costByRule(db: Db, core: ServerCore, projectIds: string[], from: Date) {
  const totals = await wastedBy(db, core, projectIds, from, "rule");
  return [...totals.entries()]
    .map(([key, micros]) => ({ key, micros, units: {} }))
    .sort((a, b) => b.micros - a.micros);
}

function dayKeys(from: Date, days: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = new Date(from);
    day.setUTCDate(from.getUTCDate() + i);
    keys.push(isoDay(day));
  }
  return keys;
}

interface BilledRollup {
  rows: number;
  net: number;
  currency: string;
  byDay: Map<string, number>;
  skus: { service: string; sku: string; micros: number; creditsMicros: number; usageAmount: number; usageUnit: string }[];
}

async function billedCosts(db: Db, projectIds: string[], from: Date): Promise<BilledRollup> {
  const empty: BilledRollup = { rows: 0, net: 0, currency: "USD", byDay: new Map(), skus: [] };
  if (projectIds.length === 0) return empty;
  const day = from.toISOString().slice(0, 10);
  const daily = await db.execute<{ day: string; net: string; n: string; currency: string }>(sql`
    select ${schema.costDaily.day}::text as day,
           sum(${schema.costDaily.costMicros} + ${schema.costDaily.creditsMicros})::float8 as net,
           count(*)::int as n,
           max(${schema.costDaily.currency}) as currency
    from ${schema.costDaily}
    where ${inArray(schema.costDaily.projectId, projectIds)}
      and ${schema.costDaily.day} >= ${day}::date
    group by 1
  `);
  const byDay = new Map<string, number>();
  let rows = 0;
  let net = 0;
  let currency = "USD";
  for (const row of rowsOf(daily)) {
    const amount = Number(row.net);
    byDay.set(isoDay(row.day), amount);
    net += amount;
    rows += Number(row.n);
    if (row.currency) currency = row.currency;
  }
  const skuRows = await db.execute<{
    service: string;
    sku: string;
    micros: string;
    credits: string;
    usage_amount: string;
    usage_unit: string;
  }>(sql`
    select ${schema.costDaily.service} as service,
           ${schema.costDaily.sku} as sku,
           sum(${schema.costDaily.costMicros})::float8 as micros,
           sum(${schema.costDaily.creditsMicros})::float8 as credits,
           sum(${schema.costDaily.usageAmount})::float8 as usage_amount,
           max(${schema.costDaily.usageUnit}) as usage_unit
    from ${schema.costDaily}
    where ${inArray(schema.costDaily.projectId, projectIds)}
      and ${schema.costDaily.day} >= ${day}::date
    group by 1, 2
    order by sum(${schema.costDaily.costMicros} + ${schema.costDaily.creditsMicros}) desc
  `);
  return {
    rows,
    net,
    currency,
    byDay,
    skus: rowsOf(skuRows).map((row) => ({
      service: row.service,
      sku: row.sku,
      micros: Number(row.micros),
      creditsMicros: Number(row.credits),
      usageAmount: Number(row.usage_amount),
      usageUnit: row.usage_unit,
    })),
  };
}

/** Estimated SDK Firestore reads divided by billed reads, when both are present. */
async function sdkCoverage(db: Db, projectIds: string[], from: Date) {
  if (projectIds.length === 0) return null;
  const day = from.toISOString().slice(0, 10);
  const estimated = await db.execute<{ reads: string }>(sql`
    select coalesce(sum((f.units->>'reads')::numeric), 0)::float8 as reads
    from ${eventFacts(projectIds, from)}
    where f.provider = 'firebase'
      and f.service = 'firestore'
  `);
  const billed = await db.execute<{ reads: string }>(sql`
    select coalesce(sum(${schema.usageDaily.amount}), 0)::float8 as reads
    from ${schema.usageDaily}
    where ${inArray(schema.usageDaily.projectId, projectIds)}
      and ${schema.usageDaily.day} >= ${day}::date
      and ${schema.usageDaily.provider} = 'firebase'
      and ${schema.usageDaily.service} = 'firestore'
      and ${schema.usageDaily.metric} = 'reads'
      and ${schema.usageDaily.source} = 'monitoring'
  `);
  const estimatedReads = Number(rowsOf(estimated)[0]?.reads ?? 0);
  const billedReads = Number(rowsOf(billed)[0]?.reads ?? 0);
  if (!(estimatedReads > 0) || !(billedReads > 0)) return null;
  return { estimatedReads, billedReads, ratio: estimatedReads / billedReads };
}

function rowsOf<T>(result: readonly T[] | { rows: T[] }): T[] {
  if ("rows" in result) return result.rows;
  return [...result];
}
