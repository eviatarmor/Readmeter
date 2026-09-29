import {
  billingTableError,
  decryptSecret,
  encryptSecret,
  GCP_ROLES,
  parseServiceAccount,
  testConnection,
  type GcpDeps,
} from "@readmeter/connector-gcp";
import { schema, type Db } from "@readmeter/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { fail, requireRole, writeAudit, ws, type AppEnv } from "../http.ts";

const putBody = z.object({
  serviceAccountJson: z.union([z.string().min(2), z.record(z.string(), z.unknown())]),
  gcpProjectId: z.string().min(1).max(120).optional(),
  billingTable: z.string().max(300).nullable().optional(),
});

const publicColumns = {
  id: schema.gcpConnections.id,
  projectId: schema.gcpConnections.projectId,
  gcpProjectId: schema.gcpConnections.gcpProjectId,
  clientEmail: schema.gcpConnections.clientEmail,
  billingTable: schema.gcpConnections.billingTable,
  status: schema.gcpConnections.status,
  lastSyncAt: schema.gcpConnections.lastSyncAt,
  lastError: schema.gcpConnections.lastError,
  createdAt: schema.gcpConnections.createdAt,
  updatedAt: schema.gcpConnections.updatedAt,
};

export function gcpRoutes(db: Db, gcp: GcpDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", requireRole("admin"));

  app.get("/workspaces/:slug/projects/:projectId/gcp", async (c) => {
    const { workspace } = ws(c);
    const project = await ownedProject(db, workspace.id, c.req.param("projectId"));
    if (!project) return fail(c, 404, "not_found", "project not found");
    const [connection] = await db
      .select(publicColumns)
      .from(schema.gcpConnections)
      .where(eq(schema.gcpConnections.projectId, project.id))
      .limit(1);
    return c.json({ connection: connection ?? null, roles: GCP_ROLES });
  });

  app.put("/workspaces/:slug/projects/:projectId/gcp", async (c) => {
    const { workspace, user } = ws(c);
    const project = await ownedProject(db, workspace.id, c.req.param("projectId"));
    if (!project) return fail(c, 404, "not_found", "project not found");
    if (!gcp.secretKey) return fail(c, 400, "bad_request", gcp.secretError ?? "READMETER_SECRET_KEY is not set");
    const body = putBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(c, 400, "bad_request", "serviceAccountJson is required");
    const parsed = parseServiceAccount(body.data.serviceAccountJson);
    if ("error" in parsed) return fail(c, 400, "bad_request", parsed.error);
    const gcpProjectId = body.data.gcpProjectId?.trim() || parsed.account.project_id;
    const billingTable = blankToNull(body.data.billingTable);
    if (billingTable) {
      const tableError = billingTableError(billingTable);
      if (tableError) return fail(c, 400, "bad_request", tableError);
    }
    const sealed = encryptSecret(parsed.json, gcp.secretKey);
    const now = new Date();
    const [saved] = await db
      .insert(schema.gcpConnections)
      .values({
        orgId: workspace.id,
        projectId: project.id,
        gcpProjectId,
        clientEmail: parsed.account.client_email,
        keyCiphertext: sealed.ciphertext,
        keyIv: sealed.iv,
        keyTag: sealed.tag,
        billingTable,
        status: "pending",
        lastError: null,
        createdBy: user.id,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.gcpConnections.projectId,
        set: {
          gcpProjectId,
          clientEmail: parsed.account.client_email,
          keyCiphertext: sealed.ciphertext,
          keyIv: sealed.iv,
          keyTag: sealed.tag,
          billingTable,
          status: "pending",
          lastError: null,
          updatedAt: now,
        },
      })
      .returning(publicColumns);
    if (!saved) return fail(c, 500, "internal", "could not store the connection");
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "gcp.connect",
      target: project.id,
      metadata: { gcpProjectId, clientEmail: parsed.account.client_email, billingTable, status: "pending" },
    });
    const checks = await testConnection({
      account: parsed.account,
      gcpProjectId,
      billingTable,
      clients: gcp.clients,
      maxBytesBilled: gcp.maxBytesBilled,
    });
    const message = checks
      .filter((check) => !check.ok)
      .map((check) => check.message)
      .join("; ");
    const status = message ? "error" : "ok";
    const [connection] = await db
      .update(schema.gcpConnections)
      .set({ status, lastError: message || null, updatedAt: new Date() })
      .where(eq(schema.gcpConnections.id, saved.id))
      .returning(publicColumns);
    return c.json({ connection: connection ?? { ...saved, status, lastError: message || null }, checks });
  });

  app.post("/workspaces/:slug/projects/:projectId/gcp/test", async (c) => {
    const { workspace, user } = ws(c);
    const project = await ownedProject(db, workspace.id, c.req.param("projectId"));
    if (!project) return fail(c, 404, "not_found", "project not found");
    if (!gcp.secretKey) return fail(c, 400, "bad_request", gcp.secretError ?? "READMETER_SECRET_KEY is not set");
    const [row] = await db
      .select()
      .from(schema.gcpConnections)
      .where(eq(schema.gcpConnections.projectId, project.id))
      .limit(1);
    if (!row) return fail(c, 404, "not_found", "google cloud is not connected");
    let json = "";
    try {
      json = decryptSecret({ ciphertext: row.keyCiphertext, iv: row.keyIv ?? "", tag: row.keyTag ?? "" }, gcp.secretKey);
    } catch {
      return fail(c, 500, "internal", "stored key could not be decrypted");
    }
    const parsed = parseServiceAccount(json);
    if ("error" in parsed) return fail(c, 500, "internal", parsed.error);
    const checks = await testConnection({
      account: parsed.account,
      gcpProjectId: row.gcpProjectId,
      billingTable: row.billingTable,
      clients: gcp.clients,
      maxBytesBilled: gcp.maxBytesBilled,
    });
    const message = checks
      .filter((check) => !check.ok)
      .map((check) => check.message)
      .join("; ");
    await db
      .update(schema.gcpConnections)
      .set({ status: message ? "error" : "ok", lastError: message || null, updatedAt: new Date() })
      .where(eq(schema.gcpConnections.id, row.id));
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "gcp.test",
      target: project.id,
      metadata: { checks: checks.map((check) => ({ name: check.name, ok: check.ok })) },
    });
    const [connection] = await db.select(publicColumns).from(schema.gcpConnections).where(eq(schema.gcpConnections.id, row.id));
    return c.json({ connection, checks });
  });

  app.post("/workspaces/:slug/projects/:projectId/gcp/sync", async (c) => {
    const { workspace, user } = ws(c);
    const project = await ownedProject(db, workspace.id, c.req.param("projectId"));
    if (!project) return fail(c, 404, "not_found", "project not found");
    const [row] = await db
      .update(schema.gcpConnections)
      .set({ syncRequestedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.gcpConnections.projectId, project.id))
      .returning({ id: schema.gcpConnections.id });
    if (!row) return fail(c, 404, "not_found", "google cloud is not connected");
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "gcp.sync",
      target: project.id,
      metadata: { queued: true },
    });
    return c.json({ queued: true });
  });

  app.delete("/workspaces/:slug/projects/:projectId/gcp", async (c) => {
    const { workspace, user } = ws(c);
    const project = await ownedProject(db, workspace.id, c.req.param("projectId"));
    if (!project) return fail(c, 404, "not_found", "project not found");
    const [removed] = await db
      .delete(schema.gcpConnections)
      .where(eq(schema.gcpConnections.projectId, project.id))
      .returning({ id: schema.gcpConnections.id });
    if (!removed) return fail(c, 404, "not_found", "google cloud is not connected");
    await db.delete(schema.usageDaily).where(eq(schema.usageDaily.projectId, project.id));
    await db.delete(schema.costDaily).where(eq(schema.costDaily.projectId, project.id));
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "gcp.disconnect",
      target: project.id,
      metadata: {},
    });
    return c.json({ ok: true });
  });

  return app;
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

async function ownedProject(db: Db, orgId: string, projectId: string) {
  const [project] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, orgId)))
    .limit(1);
  return project ?? null;
}
