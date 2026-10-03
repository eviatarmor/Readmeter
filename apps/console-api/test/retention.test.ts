// Console charts must not change when raw events move into daily rollups.
// Needs DATABASE_URL (migrated); skipped otherwise.
import assert from "node:assert/strict";
import test from "node:test";

import { connect, runRetention, schema } from "@readmeter/db";
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
const DAY = 24 * 60 * 60 * 1000;

async function call(app: Hono, method: string, path: string, cookie?: string, body?: unknown) {
  const headers = new Headers({ origin: ORIGIN });
  if (cookie) headers.set("cookie", cookie);
  if (method !== "GET") headers.set("content-type", "application/json");
  return app.request(
    new Request(`${BASE}${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) }),
  );
}

test("overview and costs are unchanged across the retention boundary", { skip: !databaseUrl }, async () => {
  const { db, client, close } = connect(databaseUrl);
  const env = readEnv({ ...process.env, PORT: "8091", BETTER_AUTH_URL: BASE, CONSOLE_ORIGIN: ORIGIN });
  const mailer = createMailer(env);
  const app = createApp({ db, auth: createAuth(db, env, mailer), core: await loadCore(), env, mailer });
  const suffix = Math.random().toString(36).slice(2, 10);
  const slug = `ret-${suffix}`;
  let orgId = "";
  try {
    const signed = await call(app, "POST", "/api/auth/sign-up/email", undefined, {
      name: "Owner",
      email: `ret-${suffix}@readmeter.test`,
      password: "readmeter-dev",
    });
    assert.equal(signed.status, 200, await signed.clone().text());
    const cookie = signed.headers
      .getSetCookie()
      .map((c) => c.split(";")[0] ?? "")
      .filter((c) => c.includes("="))
      .join("; ");
    const created = await call(app, "POST", "/api/v1/workspaces", cookie, { name: "R", slug });
    assert.equal(created.status, 201, await created.clone().text());
    orgId = ((await created.json()) as { id: string }).id;
    const projectRes = await call(app, "POST", `/api/v1/workspaces/${slug}/projects`, cookie, { name: "App" });
    const project = ((await projectRes.json()) as { id: string }).id;

    const now = Date.now();
    const [batch] = await db
      .insert(schema.batches)
      .values({
        projectId: project,
        receivedAt: new Date(now - 40 * DAY),
        sentAt: new Date(now - 40 * DAY),
        schema: 1,
        sdkName: "t",
        sdkVersion: "0",
        session: "s",
        events: 0,
        findings: 0,
      })
      .returning({ id: schema.batches.id });
    const event = (daysAgo: number, template: string, reads: number, callsite: string | null) => ({
      projectId: project,
      batchId: batch!.id,
      ts: new Date(now - daysAgo * DAY),
      session: "s",
      provider: "firebase",
      service: "firestore",
      op: "query",
      template,
      targetKey: "0000000000000000",
      callId: "0000000000000000",
      platform: "web",
      callsite,
      callsiteLabel: callsite ? "load" : null,
      units: { reads },
    });
    await db.insert(schema.events).values([
      event(60, "posts", 4, "a.ts:1"),
      event(60, "posts", 6, null),
      event(40, "users", 10, "b.ts:2"),
      event(5, "posts", 1, "a.ts:1"),
      event(0, "users", 2, null),
    ]);

    const snapshot = async () => {
      const paths = [
        `/api/v1/workspaces/${slug}/overview?range=90d&project=${project}`,
        `/api/v1/workspaces/${slug}/costs?range=90d&groupBy=day&project=${project}`,
        `/api/v1/workspaces/${slug}/costs?range=90d&groupBy=template&project=${project}`,
        `/api/v1/workspaces/${slug}/costs?range=90d&groupBy=service&project=${project}`,
      ];
      const out = [];
      for (const path of paths) {
        const res = await call(app, "GET", path, cookie);
        assert.equal(res.status, 200, await res.clone().text());
        out.push(await res.json());
      }
      return out;
    };
    const before = await snapshot();
    const overview = before[0] as {
      kpis: { events: number; billedUnits: number };
      topTemplates: { template: string; events: number }[];
      topCallsites: { callsite: string; callsiteLabel: string | null; events: number }[];
    };
    assert.equal(overview.kpis.events, 5);
    assert.equal(overview.kpis.billedUnits, 23);
    assert.deepEqual(overview.topTemplates, [
      { template: "posts", events: 3 },
      { template: "users", events: 2 },
    ]);
    assert.deepEqual(overview.topCallsites, [
      { callsite: "a.ts:1", callsiteLabel: "load", events: 2 },
      { callsite: "b.ts:2", callsiteLabel: "load", events: 1 },
    ]);

    let report;
    for (let i = 0; i < 100; i += 1) {
      report = await runRetention(client, { projectIds: [project], eventsDays: 30 });
      if (!report.skipped) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(report?.deletedEvents, 3);
    const raw = await db.select().from(schema.events).where(eq(schema.events.projectId, project));
    assert.equal(raw.length, 2);

    assert.deepEqual(await snapshot(), before);
    // A late event for a rolled-up day shows up before the next pass and is counted once after it.
    await db.insert(schema.events).values(event(5, "posts", 1, "a.ts:1"));
    const late = (await snapshot())[0] as { kpis: { events: number } };
    assert.equal(late.kpis.events, 6);
    await runRetention(client, { projectIds: [project], eventsDays: 30 });
    const settled = (await snapshot())[0] as { kpis: { events: number } };
    assert.equal(settled.kpis.events, 6);
  } finally {
    if (orgId) await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await close();
  }
});
