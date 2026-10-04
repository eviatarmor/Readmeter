import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";

import { hashApiKey, schema, type Db } from "@readmeter/db";

import { newLiveKey, randomHashKey } from "../keys.ts";
import { fail, listQuery, requireRole, writeAudit, ws, type AppEnv } from "../http.ts";

const environment = z.enum(["production", "staging", "development"]);

const createProjectBody = z.object({
  name: z.string().min(1).max(80),
  environment: environment.default("production"),
  firebaseProjectId: z.string().min(1).max(120).nullable().optional(),
});

/** Accepted ingest batches per minute for the project; null uses the ingest default. */
const ratePerMin = z
  .number({ error: "ratePerMin must be a whole number from 1 to 1000000, or null" })
  .int("ratePerMin must be a whole number from 1 to 1000000, or null")
  .min(1, "ratePerMin must be a whole number from 1 to 1000000, or null")
  .max(1_000_000, "ratePerMin must be a whole number from 1 to 1000000, or null")
  .nullable();

const patchProjectBody = z
  .object({
    name: z.string().min(1).max(80).optional(),
    environment: environment.optional(),
    firebaseProjectId: z.string().min(1).max(120).nullable().optional(),
    ratePerMin: ratePerMin.optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.environment !== undefined ||
      body.firebaseProjectId !== undefined ||
      body.ratePerMin !== undefined,
    { message: "nothing to update" },
  );

const createKeyBody = z.object({
  name: z.string().min(1).max(80).default("default"),
  allowedOrigins: z.array(z.string().min(1).max(200)).max(20).default([]),
});

function snippets(hashKey: string, endpoint: string) {
  return {
    web: [
      `import { init } from "@readmeter/firebase";`,
      `init({`,
      `  apiKey: "YOUR_API_KEY",`,
      `  hashKey: ${JSON.stringify(hashKey)},`,
      `  endpoint: ${JSON.stringify(endpoint)},`,
      `});`,
    ].join("\n"),
    functions: [
      `import { init } from "@readmeter/firebase";`,
      `import { instrument, withFlush } from "@readmeter/firebase/admin";`,
      `init({`,
      `  apiKey: "YOUR_API_KEY",`,
      `  hashKey: ${JSON.stringify(hashKey)},`,
      `  endpoint: ${JSON.stringify(endpoint)},`,
      `  platform: "server",`,
      `});`,
    ].join("\n"),
  };
}

function encodeId(id: string): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

function cursorIndex(cursor: string | null, ids: string[]): number | "bad" {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id?: unknown };
    if (!value || typeof value.id !== "string") return "bad";
    const at = ids.indexOf(value.id);
    return at < 0 ? "bad" : at + 1;
  } catch {
    return "bad";
  }
}

export function projectRoutes(db: Db, ingestPublicUrl: string) {
  const app = new Hono<AppEnv>();

  app.get("/workspaces/:slug/projects", async (c) => {
    const { workspace } = ws(c);
    const query = listQuery(new URL(c.req.url));
    if ("error" in query) return fail(c, 400, "bad_request", query.error);
    const rows = await db
      .select({
        id: schema.projects.id,
        name: schema.projects.name,
        environment: schema.projects.environment,
        firebaseProjectId: schema.projects.firebaseProjectId,
        ratePerMin: schema.projects.ratePerMin,
        createdAt: schema.projects.createdAt,
      })
      .from(schema.projects)
      .where(eq(schema.projects.orgId, workspace.id))
      .orderBy(desc(schema.projects.createdAt), desc(schema.projects.id));
    const start = cursorIndex(query.cursor, rows.map((row) => row.id));
    if (start === "bad") return fail(c, 400, "bad_request", "invalid cursor");
    const page = rows.slice(start, start + query.limit + 1);
    const items = page.slice(0, query.limit);
    const next = page.length > query.limit ? items[items.length - 1] : undefined;
    const ids = items.map((row) => row.id);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const eventCounts = new Map<string, number>();
    const openCounts = new Map<string, number>();
    if (ids.length > 0) {
      const events = await db
        .select({ projectId: schema.events.projectId, n: sql<number>`count(*)::int` })
        .from(schema.events)
        .where(and(inArray(schema.events.projectId, ids), gte(schema.events.ts, since)))
        .groupBy(schema.events.projectId);
      for (const row of events) eventCounts.set(row.projectId, Number(row.n));
      const open = await db
        .select({ projectId: schema.findings.projectId, n: sql<number>`count(*)::int` })
        .from(schema.findings)
        .leftJoin(schema.findingStates, eq(schema.findingStates.findingId, schema.findings.id))
        .where(
          and(
            inArray(schema.findings.projectId, ids),
            sql`coalesce(${schema.findingStates.status}, 'open') = 'open'`,
          ),
        )
        .groupBy(schema.findings.projectId);
      for (const row of open) openCounts.set(row.projectId, Number(row.n));
    }
    return c.json({
      items: items.map((row) => ({
        ...row,
        events24h: eventCounts.get(row.id) ?? 0,
        openFindings: openCounts.get(row.id) ?? 0,
      })),
      nextCursor: next ? encodeId(next.id) : null,
    });
  });

  app.post("/workspaces/:slug/projects", requireRole("admin"), async (c) => {
    const { workspace, user } = ws(c);
    const parsed = createProjectBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", parsed.error.issues[0]?.message ?? "invalid body");
    const id = `proj_${nanoid()}`;
    const [created] = await db
      .insert(schema.projects)
      .values({
        id,
        orgId: workspace.id,
        name: parsed.data.name,
        hashKey: randomHashKey(),
        environment: parsed.data.environment,
        firebaseProjectId: parsed.data.firebaseProjectId ?? null,
      })
      .returning();
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "project.create",
      target: id,
      metadata: { name: parsed.data.name, environment: parsed.data.environment },
    });
    return c.json(created, 201);
  });

  app.get("/workspaces/:slug/projects/:projectId", async (c) => {
    const project = await loadProject(c, db);
    if (project instanceof Response) return project;
    return c.json({
      ...publicProject(project),
      hashKey: project.hashKey,
      snippets: snippets(project.hashKey, ingestPublicUrl),
    });
  });

  app.patch("/workspaces/:slug/projects/:projectId", requireRole("admin"), async (c) => {
    const { workspace, user } = ws(c);
    const parsed = patchProjectBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", parsed.error.issues[0]?.message ?? "invalid body");
    const [updated] = await db
      .update(schema.projects)
      .set({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.environment !== undefined ? { environment: parsed.data.environment } : {}),
        ...(parsed.data.firebaseProjectId !== undefined
          ? { firebaseProjectId: parsed.data.firebaseProjectId }
          : {}),
        ...(parsed.data.ratePerMin !== undefined ? { ratePerMin: parsed.data.ratePerMin } : {}),
      })
      .where(and(eq(schema.projects.id, c.req.param("projectId")), eq(schema.projects.orgId, workspace.id)))
      .returning();
    if (!updated) return fail(c, 404, "not_found", "project not found");
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "project.update",
      target: updated.id,
      metadata: parsed.data,
    });
    return c.json(publicProject(updated));
  });

  app.delete("/workspaces/:slug/projects/:projectId", requireRole("admin"), async (c) => {
    const { workspace, user } = ws(c);
    const [removed] = await db
      .delete(schema.projects)
      .where(and(eq(schema.projects.id, c.req.param("projectId")), eq(schema.projects.orgId, workspace.id)))
      .returning({ id: schema.projects.id });
    if (!removed) return fail(c, 404, "not_found", "project not found");
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "project.delete",
      target: removed.id,
    });
    return c.json({ ok: true });
  });

  app.get("/workspaces/:slug/projects/:projectId/keys", async (c) => {
    const project = await loadProject(c, db);
    if (project instanceof Response) return project;
    const query = listQuery(new URL(c.req.url));
    if ("error" in query) return fail(c, 400, "bad_request", query.error);
    const rows = await db
      .select({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        prefix: schema.apiKeys.prefix,
        allowedOrigins: schema.apiKeys.allowedOrigins,
        createdAt: schema.apiKeys.createdAt,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        revokedAt: schema.apiKeys.revokedAt,
        createdBy: schema.apiKeys.createdBy,
        creatorId: schema.users.id,
        creatorName: schema.users.name,
        creatorEmail: schema.users.email,
      })
      .from(schema.apiKeys)
      .leftJoin(schema.users, eq(schema.users.id, schema.apiKeys.createdBy))
      .where(eq(schema.apiKeys.projectId, project.id))
      .orderBy(desc(schema.apiKeys.createdAt));
    const start = cursorIndex(query.cursor, rows.map((row) => row.id));
    if (start === "bad") return fail(c, 400, "bad_request", "invalid cursor");
    const page = rows.slice(start, start + query.limit + 1);
    const items = page.slice(0, query.limit);
    const next = page.length > query.limit ? items[items.length - 1] : undefined;
    return c.json({
      items: items.map((row) => ({
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        allowedOrigins: row.allowedOrigins,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        revokedAt: row.revokedAt,
        createdBy: row.createdBy,
        creator: row.creatorId
          ? { id: row.creatorId, name: row.creatorName, email: row.creatorEmail }
          : null,
      })),
      nextCursor: next ? encodeId(next.id) : null,
    });
  });

  app.post("/workspaces/:slug/projects/:projectId/keys", requireRole("admin"), async (c) => {
    const { workspace, user } = ws(c);
    const project = await loadProject(c, db);
    if (project instanceof Response) return project;
    const parsed = createKeyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", parsed.error.issues[0]?.message ?? "invalid body");
    const { apiKey, prefix } = newLiveKey();
    const [created] = await db
      .insert(schema.apiKeys)
      .values({
        projectId: project.id,
        keyHash: hashApiKey(apiKey),
        prefix,
        name: parsed.data.name,
        allowedOrigins: parsed.data.allowedOrigins,
        createdBy: user.id,
      })
      .returning({ id: schema.apiKeys.id, createdAt: schema.apiKeys.createdAt });
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "key.create",
      target: created?.id ?? prefix,
      metadata: { projectId: project.id, prefix, name: parsed.data.name },
    });
    return c.json(
      {
        id: created?.id,
        key: apiKey,
        prefix,
        name: parsed.data.name,
        allowedOrigins: parsed.data.allowedOrigins,
        createdAt: created?.createdAt,
      },
      201,
    );
  });

  app.delete("/workspaces/:slug/projects/:projectId/keys/:keyId", requireRole("admin"), async (c) => {
    const { workspace, user } = ws(c);
    const project = await loadProject(c, db);
    if (project instanceof Response) return project;
    const [revoked] = await db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.apiKeys.id, c.req.param("keyId")),
          eq(schema.apiKeys.projectId, project.id),
          isNull(schema.apiKeys.revokedAt),
        ),
      )
      .returning({ id: schema.apiKeys.id, prefix: schema.apiKeys.prefix });
    if (!revoked) return fail(c, 404, "not_found", "key not found");
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "key.revoke",
      target: revoked.id,
      metadata: { prefix: revoked.prefix, projectId: project.id },
    });
    return c.json({ ok: true });
  });

  return app;
}

async function loadProject(c: { req: { param: (name: string) => string }; var: AppEnv["Variables"] }, db: Db) {
  const workspace = c.var.workspace;
  if (!workspace) return fail(c as never, 500, "internal", "workspace missing");
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.id, c.req.param("projectId")), eq(schema.projects.orgId, workspace.id)))
    .limit(1);
  if (!project) return fail(c as never, 404, "not_found", "project not found");
  return project;
}

function publicProject(project: {
  id: string;
  name: string;
  environment: string;
  firebaseProjectId: string | null;
  ratePerMin: number | null;
  createdAt: Date;
  orgId: string;
}) {
  return {
    id: project.id,
    name: project.name,
    environment: project.environment,
    firebaseProjectId: project.firebaseProjectId,
    ratePerMin: project.ratePerMin,
    createdAt: project.createdAt,
  };
}
