import { serveStatic } from "@hono/node-server/serve-static";
import { schema, type Db } from "@readmeter/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { Auth } from "./auth.ts";
import type { ServerCore } from "./core.ts";
import type { ConsoleEnv } from "./env.ts";
import { fail, type AppEnv, type Role } from "./http.ts";
import { takeResetLink } from "./links.ts";
import type { Mailer } from "./mail.ts";
import { projectRoutes } from "./routes/projects.ts";
import { telemetryRoutes } from "./routes/telemetry.ts";
import { workspaceRoutes } from "./routes/workspaces.ts";

export interface Deps {
  db: Db;
  auth: Auth;
  core: ServerCore;
  env: ConsoleEnv;
  mailer: Mailer;
}

const ROLES = new Set<Role>(["owner", "admin", "member"]);

export function createApp({ db, auth, core, env, mailer }: Deps) {
  const app = new Hono();
  app.get("/healthz", (c) => c.text("ok"));

  app.use(
    "/api/*",
    cors({
      origin: env.consoleOrigin,
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "Cookie"],
    }),
  );

  app.get("/api/v1/auth-config", (c) =>
    c.json({ google: Boolean(env.googleClientId && env.googleClientSecret) }),
  );

  app.on(["POST", "GET"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname;
    const reset = c.req.method === "POST" && path.endsWith("/request-password-reset") && !mailer.smtp;
    let email = "";
    const request = c.req.raw;
    if (reset) {
      try {
        const body = (await request.clone().json()) as { email?: unknown };
        if (typeof body.email === "string") email = body.email;
      } catch {
        email = "";
      }
    }
    const response = await auth.handler(request);
    if (!reset || !email) return response;
    const link = takeResetLink(email);
    if (!link) return response;
    const payload: unknown = await response.json().catch(() => null);
    if (!payload || typeof payload !== "object") return response;
    return c.json({ ...payload, resetLink: link }, response.status as 200);
  });

  const api = new Hono<AppEnv>();
  api.use("*", async (c, next) => {
    if (c.req.method === "GET" && new URL(c.req.url).pathname === "/api/v1/auth-config") {
      await next();
      return;
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      const type = (c.req.header("content-type") ?? "").toLowerCase();
      if (!type.startsWith("application/json")) {
        return fail(c, 403, "csrf", "content-type must be application/json");
      }
      if (origin && origin !== env.consoleOrigin) return fail(c, 403, "csrf", "origin is not allowed");
    }
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return fail(c, 401, "unauthorized", "sign in required");
    c.set("user", {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      image: session.user.image ?? null,
    });
    const active = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;
    c.set("session", { id: session.session.id, activeOrganizationId: active });
    await next();
  });

  const loadWorkspace = async (c: Parameters<typeof fail>[0] & { req: { param: (name: string) => string }; var: AppEnv["Variables"]; set: (key: "workspace" | "role", value: unknown) => void }, next: () => Promise<void>) => {
    const slug = c.req.param("slug");
    if (!slug) return fail(c, 404, "not_found", "workspace not found");
    const [org] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug))
      .limit(1);
    if (!org) return fail(c, 404, "not_found", "workspace not found");
    const [member] = await db
      .select({ role: schema.members.role })
      .from(schema.members)
      .where(and(eq(schema.members.organizationId, org.id), eq(schema.members.userId, c.var.user.id)))
      .limit(1);
    if (!member || !ROLES.has(member.role as Role)) return fail(c, 404, "not_found", "workspace not found");
    c.set("workspace", {
      id: org.id,
      name: org.name,
      slug: org.slug,
      logo: org.logo,
      createdAt: org.createdAt,
    });
    c.set("role", member.role);
    await next();
  };
  api.use("/workspaces/:slug", loadWorkspace as never);
  api.use("/workspaces/:slug/*", loadWorkspace as never);

  api.route("/", workspaceRoutes(db, auth, mailer));
  api.route("/", projectRoutes(db, env.ingestPublicUrl));
  api.route("/", telemetryRoutes(db, core));
  app.route("/api/v1", api);

  if (env.staticDir) {
    const root = env.staticDir;
    app.use("*", serveStatic({ root }));
    app.get("*", serveStatic({ root, path: "index.html" }));
  }

  return app;
}
