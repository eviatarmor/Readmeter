import assert from "node:assert/strict";
import test from "node:test";

import { connect, schema } from "@readmeter/db";
import { decodeSecretKey, fakeClients, type ClientFactory } from "@readmeter/connector-gcp";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";

import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { loadCore } from "../src/core.ts";
import { readEnv } from "../src/env.ts";
import { createMailer } from "../src/mail.ts";

const databaseUrl = process.env.DATABASE_URL;
const ORIGIN = "http://localhost:5174";
const BASE = "http://127.0.0.1:8091";
const SECRET_KEY = "SUPER-SECRET-PRIVATE-KEY-VALUE";
const DEV_SECRET = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((cookie) => cookie.includes("="))
    .join("; ");
}

async function call(
  app: Hono,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; origin?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin) headers.set("origin", options.origin);
  const mutating = method !== "GET" && method !== "HEAD";
  if (mutating) headers.set("content-type", "application/json");
  return app.request(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      body: mutating ? JSON.stringify(options.body ?? {}) : undefined,
    }),
  );
}

test("gcp connection hides the key and billed rows feed overview", { skip: !databaseUrl }, async () => {
  const { db, close } = connect(databaseUrl);
  const env = readEnv({
    ...process.env,
    PORT: "8091",
    BETTER_AUTH_URL: BASE,
    CONSOLE_ORIGIN: ORIGIN,
  });
  const mailer = createMailer(env);
  const auth = createAuth(db, env, mailer);
  const core = await loadCore();
  const secretKey = decodeSecretKey(DEV_SECRET);
  assert.ok(secretKey);
  const clients: ClientFactory = async (account) => fakeClients(account);
  const locked = createApp({
    db,
    auth,
    core,
    env,
    mailer,
    gcp: {
      secretKey: null,
      secretError: "Set READMETER_SECRET_KEY to 32 bytes, base64-encoded, before connecting Google Cloud.",
      maxBytesBilled: 1000,
      clients,
    },
  });
  const app = createApp({
    db,
    auth,
    core,
    env,
    mailer,
    gcp: { secretKey, secretError: null, maxBytesBilled: 1000, clients },
  });
  const suffix = Math.random().toString(36).slice(2, 10);
  const email = `gcp-${suffix}@readmeter.test`;
  const slug = `gcp-${suffix}`;
  let orgId = "";
  try {
    const signed = await call(app, "POST", "/api/auth/sign-up/email", {
      origin: ORIGIN,
      body: { name: "Owner", email, password: "readmeter-dev" },
    });
    assert.equal(signed.status, 200, await signed.clone().text());
    const cookie = cookies(signed);
    const created = await call(app, "POST", "/api/v1/workspaces", { cookie, body: { name: "Workspace", slug } });
    assert.equal(created.status, 201, await created.clone().text());
    orgId = ((await created.json()) as { id: string }).id;
    const projectRes = await call(app, "POST", `/api/v1/workspaces/${slug}/projects`, {
      cookie,
      body: { name: "App", environment: "development", firebaseProjectId: "demo-readmeter" },
    });
    assert.equal(projectRes.status, 201, await projectRes.clone().text());
    const project = (await projectRes.json()) as { id: string };
    const path = `/api/v1/workspaces/${slug}/projects/${project.id}/gcp`;
    const key = {
      type: "service_account",
      client_email: "reader@demo-readmeter.iam.gserviceaccount.com",
      private_key: SECRET_KEY,
      project_id: "demo-readmeter",
    };

    const missing = await call(locked, "PUT", path, { cookie, body: { serviceAccountJson: key } });
    assert.equal(missing.status, 400);
    assert.match(await missing.text(), /READMETER_SECRET_KEY/);

    const invalid = await call(app, "PUT", path, { cookie, body: { serviceAccountJson: "{" } });
    assert.equal(invalid.status, 400, await invalid.clone().text());

    const stored = await call(app, "PUT", path, {
      cookie,
      body: { serviceAccountJson: key, billingTable: "demo-readmeter.billing.gcp_billing_export_v1" },
    });
    const storedText = await stored.text();
    assert.equal(stored.status, 200, storedText);
    assert.equal(storedText.includes(SECRET_KEY), false);
    assert.equal(storedText.includes("keyCiphertext"), false);
    const storedBody = JSON.parse(storedText) as { connection: { clientEmail: string; status: string }; checks: { ok: boolean }[] };
    assert.equal(storedBody.connection.clientEmail, key.client_email);
    assert.equal(storedBody.connection.status, "ok");
    assert.equal(storedBody.checks.every((check) => check.ok), true);

    const [row] = await db
      .select({
        keyCiphertext: schema.gcpConnections.keyCiphertext,
        keyIv: schema.gcpConnections.keyIv,
        keyTag: schema.gcpConnections.keyTag,
      })
      .from(schema.gcpConnections)
      .where(eq(schema.gcpConnections.projectId, project.id));
    assert.ok(row);
    assert.equal(row.keyCiphertext.includes(SECRET_KEY), false);
    assert.equal(`${row.keyIv ?? ""}${row.keyTag ?? ""}`.includes(SECRET_KEY), false);

    const fetched = await call(app, "GET", path, { cookie });
    const fetchedText = await fetched.text();
    assert.equal(fetched.status, 200, fetchedText);
    assert.equal(fetchedText.includes(SECRET_KEY), false);
    assert.match(fetchedText, /reader@demo-readmeter/);
    assert.match(fetchedText, /roles\/monitoring.viewer/);

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId));
    assert.equal(JSON.stringify(audits).includes(SECRET_KEY), false);
    assert.ok(audits.some((entry) => entry.action === "gcp.connect"));

    const memberEmail = `gcp-member-${suffix}@readmeter.test`;
    const invite = await call(app, "POST", `/api/v1/workspaces/${slug}/invitations`, {
      cookie,
      body: { email: memberEmail, role: "member" },
    });
    assert.equal(invite.status, 201, await invite.clone().text());
    const invitationId = ((await invite.json()) as { id: string }).id;
    const memberSign = await call(app, "POST", "/api/auth/sign-up/email", {
      origin: ORIGIN,
      body: { name: "Member", email: memberEmail, password: "readmeter-dev" },
    });
    const memberCookie = cookies(memberSign);
    const accepted = await call(app, "POST", "/api/auth/organization/accept-invitation", {
      origin: ORIGIN,
      cookie: memberCookie,
      body: { invitationId },
    });
    assert.equal(accepted.status, 200, await accepted.clone().text());
    const denied = await call(app, "PUT", path, { cookie: memberCookie, body: { serviceAccountJson: key } });
    assert.equal(denied.status, 403);

    const day = new Date().toISOString().slice(0, 10);
    const now = new Date();
    const [batch] = await db
      .insert(schema.batches)
      .values({
        projectId: project.id,
        receivedAt: now,
        sentAt: now,
        schema: 1,
        sdkName: "test",
        sdkVersion: "0",
        session: "s",
        events: 1,
        findings: 0,
      })
      .returning({ id: schema.batches.id });
    await db.insert(schema.events).values({
      projectId: project.id,
      batchId: batch!.id,
      ts: now,
      session: "s",
      provider: "firebase",
      service: "firestore",
      op: "query",
      template: "orders",
      targetKey: "t",
      callId: "1",
      platform: "test",
      units: { reads: 25 },
    });
    await db.insert(schema.usageDaily).values({
      projectId: project.id,
      day,
      provider: "firebase",
      service: "firestore",
      metric: "reads",
      amount: "50",
      source: "monitoring",
    });
    await db.insert(schema.costDaily).values({
      projectId: project.id,
      day,
      service: "Cloud Firestore",
      sku: "Read Ops",
      usageAmount: "10",
      usageUnit: "count",
      costMicros: 1_250_000,
      creditsMicros: -250_000,
      currency: "USD",
    });

    const overview = await call(app, "GET", `/api/v1/workspaces/${slug}/overview?project=${project.id}&range=7d`, { cookie });
    assert.equal(overview.status, 200, await overview.clone().text());
    const overviewBody = (await overview.json()) as {
      kpis: { costLabel: string; costMicros: number; billedCostMicros: number | null };
      sdkCoverage: { ratio: number } | null;
    };
    assert.equal(overviewBody.kpis.costLabel, "Billed");
    assert.equal(overviewBody.kpis.costMicros, 1_000_000);
    assert.equal(overviewBody.kpis.billedCostMicros, 1_000_000);
    assert.equal(overviewBody.sdkCoverage?.ratio, 0.5);

    const costs = await call(app, "GET", `/api/v1/workspaces/${slug}/costs?project=${project.id}&range=7d`, { cookie });
    const costsText = await costs.text();
    assert.equal(costs.status, 200, costsText);
    const costsBody = JSON.parse(costsText) as {
      source: string;
      billedBySku: { sku: string; micros: number; creditsMicros: number }[];
    };
    assert.equal(costsBody.source, "billed");
    assert.equal(costsBody.billedBySku[0]?.sku, "Read Ops");
    assert.equal(costsBody.billedBySku[0]?.micros, 1_250_000);
    assert.equal(costsText.includes(SECRET_KEY), false);

    const removed = await call(app, "DELETE", path, { cookie });
    assert.equal(removed.status, 200, await removed.clone().text());
    const usageLeft = await db.select().from(schema.usageDaily).where(eq(schema.usageDaily.projectId, project.id));
    const costLeft = await db.select().from(schema.costDaily).where(eq(schema.costDaily.projectId, project.id));
    const connections = await db.select().from(schema.gcpConnections).where(eq(schema.gcpConnections.projectId, project.id));
    assert.equal(usageLeft.length, 0);
    assert.equal(costLeft.length, 0);
    assert.equal(connections.length, 0);
  } finally {
    if (orgId) await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await close();
  }
});
