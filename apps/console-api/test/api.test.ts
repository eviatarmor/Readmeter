import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { connect, schema, type Db } from "@readmeter/db";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";

import { bundleEtag, createApp as createIngest } from "../../ingest/src/app.ts";
import { loadCore as loadIngestCore } from "../../ingest/src/core.ts";
import { PgStore } from "../../ingest/src/store.ts";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { loadCore } from "../src/core.ts";
import { readEnv } from "../src/env.ts";
import { createMailer } from "../src/mail.ts";

const databaseUrl = process.env.DATABASE_URL;
const ORIGIN = "http://localhost:5174";
const BASE = "http://127.0.0.1:8091";

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

test("console api", { skip: !databaseUrl }, async () => {
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
  const app = createApp({ db, auth, core, env, mailer });
  const authConfig = await call(app, "GET", "/api/v1/auth-config");
  assert.equal(authConfig.status, 200, await authConfig.clone().text());
  const authConfigBody = (await authConfig.json()) as { google?: unknown };
  assert.equal(typeof authConfigBody.google, "boolean");
  const suffix = Math.random().toString(36).slice(2, 10);
  const email = `owner-${suffix}@readmeter.test`;
  const slug = `ws-${suffix}`;
  let orgId = "";
  try {
    const signed = await call(app, "POST", "/api/auth/sign-up/email", {
      origin: ORIGIN,
      body: { name: "Owner", email, password: "readmeter-dev" },
    });
    assert.equal(signed.status, 200, await signed.clone().text());
    const cookie = cookies(signed);
    assert.ok(cookie.length > 0);

    const created = await call(app, "POST", "/api/v1/workspaces", {
      cookie,
      body: { name: "Workspace", slug },
    });
    assert.equal(created.status, 201, await created.clone().text());
    const workspace = (await created.json()) as { id: string };
    orgId = workspace.id;

    const projectRes = await call(app, "POST", `/api/v1/workspaces/${slug}/projects`, {
      cookie,
      body: { name: "App", environment: "development" },
    });
    assert.equal(projectRes.status, 201, await projectRes.clone().text());
    const project = (await projectRes.json()) as { id: string; hashKey: string };
    assert.match(project.id, /^proj_/);
    const detail = await call(app, "GET", `/api/v1/workspaces/${slug}/projects/${project.id}`, { cookie });
    const detailBody = (await detail.json()) as { snippets: { web: string; functions: string }; hashKey: string };
    assert.match(detailBody.snippets.web, /YOUR_API_KEY/);
    assert.match(detailBody.snippets.web, new RegExp(detailBody.hashKey));
    assert.match(detailBody.snippets.functions, /platform/);
    assert.equal(detailBody.snippets.web.includes(env.ingestPublicUrl), true);

    const keyRes = await call(app, "POST", `/api/v1/workspaces/${slug}/projects/${project.id}/keys`, {
      cookie,
      body: { name: "ci", allowedOrigins: [] },
    });
    assert.equal(keyRes.status, 201, await keyRes.clone().text());
    const keyBody = (await keyRes.json()) as { key: string };
    assert.match(keyBody.key, /^rm_live_[0-9A-Za-z]{32}$/);
    const access = await new PgStore(db).projectForKey(keyBody.key);
    assert.equal(access?.projectId, project.id);

    const memberEmail = `member-${suffix}@readmeter.test`;
    const invite = await call(app, "POST", `/api/v1/workspaces/${slug}/invitations`, {
      cookie,
      body: { email: memberEmail, role: "member" },
    });
    assert.equal(invite.status, 201, await invite.clone().text());
    const inviteBody = (await invite.json()) as { id: string; link?: string };
    assert.ok(inviteBody.link);

    const memberSign = await call(app, "POST", "/api/auth/sign-up/email", {
      origin: ORIGIN,
      body: { name: "Member", email: memberEmail, password: "readmeter-dev" },
    });
    assert.equal(memberSign.status, 200, await memberSign.clone().text());
    const memberCookie = cookies(memberSign);
    const accepted = await call(app, "POST", "/api/auth/organization/accept-invitation", {
      origin: ORIGIN,
      cookie: memberCookie,
      body: { invitationId: inviteBody.id },
    });
    assert.equal(accepted.status, 200, await accepted.clone().text());

    const denied = await call(app, "POST", `/api/v1/workspaces/${slug}/projects/${project.id}/keys`, {
      cookie: memberCookie,
      body: { name: "nope", allowedOrigins: [] },
    });
    assert.equal(denied.status, 403);

    const stranger = await call(app, "POST", "/api/auth/sign-up/email", {
      origin: ORIGIN,
      body: { name: "Stranger", email: `stranger-${suffix}@readmeter.test`, password: "readmeter-dev" },
    });
    const hidden = await call(app, "GET", `/api/v1/workspaces/${slug}`, { cookie: cookies(stranger) });
    assert.equal(hidden.status, 404);

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
        findings: 2,
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
      units: { reads: 100000 },
    });
    const [openFinding] = await insertFinding(db, project.id, {
      rule: "firebase.firestore/unbounded-list",
      severity: "critical",
      template: "orders",
      wasted: { reads: 100000 },
      now,
    });
    await insertFinding(db, project.id, {
      rule: "firebase.firestore/offset-pagination",
      severity: "low",
      template: "posts",
      wasted: { reads: 4 },
      now,
    });

    const patched = await call(app, "PATCH", `/api/v1/workspaces/${slug}/findings/${openFinding!.id}`, {
      cookie: memberCookie,
      body: { status: "resolved", note: "fixed" },
    });
    assert.equal(patched.status, 200, await patched.clone().text());
    const audits = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.orgId, orgId));
    assert.ok(audits.some((row) => row.action === "finding.status"));

    const filtered = await call(
      app,
      "GET",
      `/api/v1/workspaces/${slug}/findings?severity=low&status=open`,
      { cookie },
    );
    assert.equal(filtered.status, 200);
    const filteredBody = (await filtered.json()) as { items: { rule: string; status: string; wastedMicros: number }[] };
    assert.deepEqual(
      filteredBody.items.map((item) => item.rule),
      ["firebase.firestore/offset-pagination"],
    );
    assert.equal(filteredBody.items[0]?.status, "open");
    assert.equal(typeof filteredBody.items[0]?.wastedMicros, "number");

    const bundlePath = new URL("../../../target/rules/bundle.bin", import.meta.url);
    const bundleJson = readFileSync(new URL("../../../target/rules/bundle.json", import.meta.url), "utf8");
    const bundleBytes = new Uint8Array(readFileSync(bundlePath));
    const ingest = createIngest({
      core: await loadIngestCore({ bundleJson, maxEvents: 10_000, maxFindings: 1_000 }),
      store: new PgStore(db),
      bundle: { body: bundleBytes, etag: bundleEtag(bundleBytes) },
    });
    const bundleHeaders = { authorization: `Bearer ${keyBody.key}` };
    const before = await ingest.request(new Request("http://x/v1/bundle", { headers: bundleHeaders }));
    assert.equal(before.status, 200);
    const beforeTag = before.headers.get("etag");
    const beforeBytes = new Uint8Array(await before.arrayBuffer());
    const ruleId = encodeURIComponent("firebase.firestore/unbounded-list");
    const override = await call(
      app,
      "PUT",
      `/api/v1/workspaces/${slug}/projects/${project.id}/rules/${ruleId}`,
      { cookie, body: { enabled: false } },
    );
    assert.equal(override.status, 200, await override.clone().text());
    const after = await ingest.request(new Request("http://x/v1/bundle", { headers: bundleHeaders }));
    const afterTag = after.headers.get("etag");
    const afterBytes = new Uint8Array(await after.arrayBuffer());
    assert.notEqual(afterTag, beforeTag);
    assert.notDeepEqual(afterBytes, beforeBytes);

    const overview = await call(app, "GET", `/api/v1/workspaces/${slug}/overview?range=7d&project=${project.id}`, {
      cookie,
    });
    assert.equal(overview.status, 200, await overview.clone().text());
    const overviewBody = (await overview.json()) as {
      series: { day: string; events: number; estimatedCostMicros: number }[];
      kpis: { events: number };
    };
    assert.equal(overviewBody.series.length, 7);
    assert.ok(overviewBody.kpis.events >= 1);
    assert.ok(overviewBody.series.some((point) => point.events >= 1));

    const csrf = await call(app, "POST", "/api/v1/workspaces", {
      cookie,
      origin: "https://evil.example",
      body: { name: "Nope", slug: `no-${suffix}` },
    });
    assert.equal(csrf.status, 403);
  } finally {
    if (orgId) await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await close();
  }
});

async function insertFinding(
  db: Db,
  projectId: string,
  row: { rule: string; severity: string; template: string; wasted: Record<string, number>; now: Date },
) {
  return db
    .insert(schema.findings)
    .values({
      projectId,
      rule: row.rule,
      severity: row.severity,
      source: "sdk",
      provider: "firebase",
      service: "firestore",
      template: row.template,
      session: "s",
      callsite: "test.ts:1:1",
      message: row.rule,
      evidence: {},
      wasted: row.wasted,
      firstSeen: row.now,
      lastSeen: row.now,
    })
    .returning({ id: schema.findings.id });
}
