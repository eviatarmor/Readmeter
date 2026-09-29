import { and, desc, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import { schema, type Db } from "@readmeter/db";

import type { Auth } from "../auth.ts";
import { inviteLinkStore } from "../links.ts";
import type { Mailer } from "../mail.ts";
import {
  authFailure,
  fail,
  listQuery,
  requireRole,
  writeAudit,
  ws,
  type AppEnv,
  type Role,
} from "../http.ts";

const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase letters, numbers, and hyphens");

const createBody = z.object({ name: z.string().min(1).max(80), slug: slugSchema });
const patchBody = z
  .object({
    name: z.string().min(1).max(80).optional(),
    slug: slugSchema.optional(),
    logo: z.string().nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.slug !== undefined || body.logo !== undefined, {
    message: "nothing to update",
  });
const deleteBody = z.object({ confirm: z.string() });
const roleBody = z.object({ role: z.enum(["owner", "admin", "member"]) });
const inviteBody = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "admin", "member"]),
});

async function ownerCount(db: Db, orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.members)
    .where(and(eq(schema.members.organizationId, orgId), eq(schema.members.role, "owner")));
  return row?.n ?? 0;
}

export function workspaceRoutes(db: Db, auth: Auth, mailer: Mailer) {
  const app = new Hono<AppEnv>();

  app.get("/me", async (c) => {
    const user = c.var.user;
    const rows = await db
      .select({
        id: schema.organizations.id,
        name: schema.organizations.name,
        slug: schema.organizations.slug,
        role: schema.members.role,
      })
      .from(schema.members)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.members.organizationId))
      .where(eq(schema.members.userId, user.id));
    let activeWorkspace: string | null = null;
    const activeId = c.var.session.activeOrganizationId;
    if (activeId) activeWorkspace = rows.find((row) => row.id === activeId)?.slug ?? null;
    return c.json({
      user,
      workspaces: rows.map((row) => ({ id: row.id, name: row.name, slug: row.slug, role: row.role })),
      activeWorkspace,
    });
  });

  app.post("/workspaces", async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", parsed.error.issues[0]?.message ?? "invalid body");
    try {
      const created = await auth.api.createOrganization({
        body: { name: parsed.data.name, slug: parsed.data.slug, userId: c.var.user.id },
      });
      await writeAudit(db, {
        orgId: created.id,
        actor: c.var.user.id,
        action: "workspace.create",
        target: created.slug,
      });
      return c.json({ id: created.id, name: created.name, slug: created.slug }, 201);
    } catch (error) {
      const mapped = authFailure(error);
      return fail(c, mapped.status === 400 ? 409 : mapped.status, "conflict", mapped.message);
    }
  });

  app.get("/workspaces/:slug", async (c) => {
    const { workspace } = ws(c);
    const [projects] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.projects)
      .where(eq(schema.projects.orgId, workspace.id));
    const [members] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.members)
      .where(eq(schema.members.organizationId, workspace.id));
    return c.json({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      logo: workspace.logo,
      createdAt: workspace.createdAt,
      counts: { projects: projects?.n ?? 0, members: members?.n ?? 0 },
    });
  });

  app.patch("/workspaces/:slug", requireRole("admin"), async (c) => {
    const { workspace, user } = ws(c);
    const parsed = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", parsed.error.issues[0]?.message ?? "invalid body");
    if (parsed.data.slug && parsed.data.slug !== workspace.slug) {
      const [taken] = await db
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.slug, parsed.data.slug))
        .limit(1);
      if (taken) return fail(c, 409, "conflict", "slug is already in use");
    }
    const [updated] = await db
      .update(schema.organizations)
      .set({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.slug !== undefined ? { slug: parsed.data.slug } : {}),
        ...(parsed.data.logo !== undefined ? { logo: parsed.data.logo } : {}),
      })
      .where(eq(schema.organizations.id, workspace.id))
      .returning();
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "workspace.update",
      target: updated?.slug ?? workspace.slug,
      metadata: parsed.data,
    });
    return c.json({
      id: workspace.id,
      name: updated?.name ?? workspace.name,
      slug: updated?.slug ?? workspace.slug,
      logo: updated?.logo ?? null,
    });
  });

  app.delete("/workspaces/:slug", requireRole("owner"), async (c) => {
    const { workspace, user } = ws(c);
    const parsed = deleteBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", "body must be { confirm: slug }");
    if (parsed.data.confirm !== workspace.slug) return fail(c, 400, "bad_request", "confirm must equal the slug");
    // The org_id foreign key cascades, so this row does not survive the delete.
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "workspace.delete",
      target: workspace.slug,
    });
    await db.delete(schema.organizations).where(eq(schema.organizations.id, workspace.id));
    return c.json({ ok: true });
  });

  app.get("/workspaces/:slug/members", async (c) => {
    const { workspace } = ws(c);
    const query = listQuery(new URL(c.req.url));
    if ("error" in query) return fail(c, 400, "bad_request", query.error);
    const rows = await db
      .select({
        id: schema.members.id,
        role: schema.members.role,
        createdAt: schema.members.createdAt,
        userId: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        image: schema.users.image,
        lastActive: sql<Date | null>`(
          select max(${schema.sessions.updatedAt})
          from ${schema.sessions}
          where ${schema.sessions.userId} = ${schema.users.id}
        )`,
      })
      .from(schema.members)
      .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
      .where(eq(schema.members.organizationId, workspace.id))
      .orderBy(desc(schema.members.createdAt), desc(schema.members.id));
    const start = cursorIndex(query.cursor, rows.map((row) => row.id));
    if (start === "bad") return fail(c, 400, "bad_request", "invalid cursor");
    const page = rows.slice(start, start + query.limit + 1);
    const items = page.slice(0, query.limit);
    const next = page.length > query.limit ? items[items.length - 1] : undefined;
    return c.json({
      items: items.map((row) => ({
        id: row.id,
        role: row.role,
        joined: row.createdAt,
        lastActive: row.lastActive,
        user: { id: row.userId, name: row.name, email: row.email, image: row.image },
      })),
      nextCursor: next ? encodeId(next.id) : null,
    });
  });

  app.patch("/workspaces/:slug/members/:id", requireRole("admin"), async (c) => {
    const { workspace, user } = ws(c);
    const parsed = roleBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", "role must be owner, admin, or member");
    const blocked = await guardLastOwner(c, db, workspace.id, c.req.param("id"), parsed.data.role);
    if (blocked) return blocked;
    const [updated] = await db
      .update(schema.members)
      .set({ role: parsed.data.role })
      .where(and(eq(schema.members.id, c.req.param("id")), eq(schema.members.organizationId, workspace.id)))
      .returning();
    if (!updated) return fail(c, 404, "not_found", "member not found");
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "member.role",
      target: updated.id,
      metadata: { role: parsed.data.role },
    });
    return c.json({ id: updated.id, role: updated.role });
  });

  app.delete("/workspaces/:slug/members/:id", requireRole("admin"), async (c) => {
    const { workspace, user } = ws(c);
    const blocked = await guardLastOwner(c, db, workspace.id, c.req.param("id"), null);
    if (blocked) return blocked;
    const [removed] = await db
      .delete(schema.members)
      .where(and(eq(schema.members.id, c.req.param("id")), eq(schema.members.organizationId, workspace.id)))
      .returning();
    if (!removed) return fail(c, 404, "not_found", "member not found");
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "member.remove",
      target: removed.id,
      metadata: { userId: removed.userId },
    });
    return c.json({ ok: true });
  });

  app.get("/workspaces/:slug/invitations", requireRole("admin"), async (c) => {
    const { workspace } = ws(c);
    const query = listQuery(new URL(c.req.url));
    if ("error" in query) return fail(c, 400, "bad_request", query.error);
    const rows = await db
      .select()
      .from(schema.invitations)
      .where(eq(schema.invitations.organizationId, workspace.id))
      .orderBy(desc(schema.invitations.createdAt), desc(schema.invitations.id));
    const start = cursorIndex(query.cursor, rows.map((row) => row.id));
    if (start === "bad") return fail(c, 400, "bad_request", "invalid cursor");
    const page = rows.slice(start, start + query.limit + 1);
    const items = page.slice(0, query.limit);
    const next = page.length > query.limit ? items[items.length - 1] : undefined;
    return c.json({
      items: items.map(inviteJson),
      nextCursor: next ? encodeId(next.id) : null,
    });
  });

  app.post("/workspaces/:slug/invitations", requireRole("admin"), async (c) => {
    const { workspace, user } = ws(c);
    const parsed = inviteBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, "bad_request", parsed.error.issues[0]?.message ?? "invalid body");
    const box: { link?: string } = {};
    try {
      const invitation = await inviteLinkStore.run(box, () =>
        auth.api.createInvitation({
          body: {
            email: parsed.data.email,
            role: parsed.data.role,
            organizationId: workspace.id,
          },
          headers: c.req.raw.headers,
        }),
      );
      await writeAudit(db, {
        orgId: workspace.id,
        actor: user.id,
        action: "member.invite",
        target: invitation.id,
        metadata: { email: parsed.data.email, role: parsed.data.role },
      });
      return c.json(
        {
          ...inviteJson(invitation),
          ...(mailer.smtp ? {} : { link: box.link ?? null }),
        },
        201,
      );
    } catch (error) {
      const mapped = authFailure(error);
      return fail(c, mapped.status, "bad_request", mapped.message);
    }
  });

  app.delete("/workspaces/:slug/invitations/:id", requireRole("admin"), async (c) => {
    const { workspace, user } = ws(c);
    const id = c.req.param("id");
    try {
      await auth.api.cancelInvitation({
        body: { invitationId: id },
        headers: c.req.raw.headers,
      });
    } catch (error) {
      const mapped = authFailure(error);
      return fail(c, mapped.status, "bad_request", mapped.message);
    }
    await writeAudit(db, {
      orgId: workspace.id,
      actor: user.id,
      action: "invitation.cancel",
      target: id,
    });
    return c.json({ ok: true });
  });

  return app;
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

function inviteJson(row: {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: Date;
  createdAt: Date;
}) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

async function guardLastOwner(
  c: Context<AppEnv>,
  db: Db,
  orgId: string,
  memberId: string,
  nextRole: Role | null,
): Promise<Response | null> {
  const [member] = await db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, memberId), eq(schema.members.organizationId, orgId)))
    .limit(1);
  if (!member) return fail(c, 404, "not_found", "member not found");
  if (member.role !== "owner") return null;
  if (nextRole === "owner") return null;
  if ((await ownerCount(db, orgId)) <= 1) {
    return fail(c, 409, "conflict", "the last owner cannot be removed or demoted");
  }
  return null;
}
