// Postgres round trip. Runs only when DATABASE_URL is set and the schema is
// migrated (`pnpm db:up && pnpm db:migrate`); skipped otherwise.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { connect, hashApiKey, schema } from "@readmeter/db";
import { eq } from "drizzle-orm";

import { createApp } from "../src/app.ts";
import { PgStore } from "../src/store.ts";
import { batch, core, growingPages, offsetQuery } from "./helpers.ts";

const url = process.env.DATABASE_URL;

test("stores batches, events and deduped findings in Postgres", { skip: !url }, async () => {
  const { db, close } = connect(url);
  const suffix = randomUUID().slice(0, 8);
  const org = `org_${suffix}`;
  const project = `proj_${suffix}`;
  const key = `rm_${suffix}`;
  try {
    await db.insert(schema.organizations).values({ id: org, name: "t", slug: org });
    await db.insert(schema.projects).values({
      id: project,
      orgId: org,
      name: "t",
      hashKey: "000102030405060708090a0b0c0d0e0f",
    });
    await db
      .insert(schema.apiKeys)
      .values({ projectId: project, keyHash: hashApiKey(key), prefix: "rm_" });

    const store = new PgStore(db);
    const loaded = await store.projectForKey(key);
    assert.equal(loaded?.projectId, project);
    assert.deepEqual(loaded?.allowedOrigins, []);
    assert.equal(loaded?.hashKey, "000102030405060708090a0b0c0d0e0f");
    assert.equal(loaded?.ratePerMin, null);
    await db.update(schema.projects).set({ ratePerMin: 42 }).where(eq(schema.projects.id, project));
    // Cached for 30 s; a fresh store sees the project's limit with the key.
    assert.equal((await new PgStore(db).projectForKey(key))?.ratePerMin, 42);

    const app = createApp({ core: await core(), store });
    const send = (calls: object[]) =>
      app.request(
        new Request("http://x/v1/batches", {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
          body: batch(calls),
        }),
      );
    assert.equal((await send([offsetQuery(1), ...growingPages])).status, 202);
    // Same session and callsite: the SDK finding upserts into the same row.
    assert.equal((await send([offsetQuery(100_000)])).status, 202);

    const events = await db.select().from(schema.events).where(eq(schema.events.projectId, project));
    assert.equal(events.length, 5);
    const findings = await db
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.projectId, project));
    const byRule = Object.fromEntries(findings.map((f) => [f.rule, f]));
    assert.equal(byRule["firebase.firestore/offset-pagination"]?.occurrences, 2);
    assert.equal(byRule["firebase.firestore/missing-cursor"]?.source, "evaluator");
  } finally {
    await db.delete(schema.organizations).where(eq(schema.organizations.id, org));
    await close();
  }
});
