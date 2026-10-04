// Rollup and retention against real Postgres. Skipped unless DATABASE_URL is set
// and migrated. Every pass is scoped to this test's project.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { and, asc, eq } from "drizzle-orm";

import { connect, retentionFromEnv, runRetention, schema, type RetentionOptions } from "../src/index.ts";

const url = process.env.DATABASE_URL;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T12:00:00Z");
const at = (days: number, hour = 10) =>
  new Date(Date.UTC(2026, 5, 15 + days, hour, 0, 0));

test("retention config reads env and rejects bad values", () => {
  assert.deepEqual(retentionFromEnv({}), {
    eventsDays: 30,
    findingsDays: 365,
    rollupDays: 0,
    intervalMs: 3_600_000,
  });
  assert.equal(retentionFromEnv({ READMETER_EVENTS_RETENTION_DAYS: "7" }).eventsDays, 7);
  assert.throws(() => retentionFromEnv({ READMETER_EVENTS_RETENTION_DAYS: "-1" }));
  assert.throws(() => retentionFromEnv({ READMETER_FINDINGS_RETENTION_DAYS: "1.5" }));
  assert.throws(() => retentionFromEnv({ READMETER_ROLLUP_RETENTION_DAYS: "10" }));
  assert.equal(retentionFromEnv({ READMETER_ROLLUP_RETENTION_DAYS: "400" }).rollupDays, 400);
});

test("rolls up complete days once, keeps late events exact, deletes in bounds", { skip: !url }, async () => {
  const { db, client, close } = connect(url);
  const suffix = randomUUID().slice(0, 8);
  const org = `org_${suffix}`;
  const project = `proj_${suffix}`;
  // Another worker (another test file) may hold the lock for a moment.
  const pass = async (options: RetentionOptions) => {
    for (let i = 0; i < 100; i += 1) {
      const report = await runRetention(client, { now: NOW, projectIds: [project], ...options });
      if (!report.skipped) return report;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("retention lock never free");
  };
  try {
    await db.insert(schema.organizations).values({ id: org, name: "t", slug: org });
    await db.insert(schema.projects).values({
      id: project,
      orgId: org,
      name: "t",
      hashKey: "000102030405060708090a0b0c0d0e0f",
    });
    const batch = async (receivedAt: Date) => {
      const [row] = await db
        .insert(schema.batches)
        .values({
          projectId: project,
          receivedAt,
          sentAt: receivedAt,
          schema: 1,
          sdkName: "t",
          sdkVersion: "0",
          session: "s",
          events: 0,
          findings: 0,
        })
        .returning({ id: schema.batches.id });
      return row!.id;
    };
    const event = (batchId: number, ts: Date, extra: Partial<typeof schema.events.$inferInsert> = {}) =>
      db.insert(schema.events).values({
        projectId: project,
        batchId,
        ts,
        session: "s",
        provider: "firebase",
        service: "firestore",
        op: "query",
        template: "posts",
        targetKey: "0000000000000000",
        callId: "0000000000000000",
        platform: "web",
        items: 2,
        bytes: 100,
        units: { reads: 2 },
        ...extra,
      });

    const oldBatch = await batch(at(-40));
    const newBatch = await batch(at(0));
    await event(oldBatch, at(-40, 1));
    await event(oldBatch, at(-40, 23), { units: { reads: 3, egress_bytes: 10 }, fromCache: true });
    await event(oldBatch, at(-40, 5), { callsite: "a.ts:1", callsiteLabel: "load", errorCode: "x" });
    await event(newBatch, at(-5));
    await event(newBatch, at(0));
    await db.insert(schema.findings).values(
      [-400, -10].map((days) => ({
        projectId: project,
        rule: `r${days}`,
        severity: "low",
        source: "sdk",
        provider: "firebase",
        service: "firestore",
        template: "posts",
        session: "s",
        message: "m",
        evidence: {},
        wasted: {},
        firstSeen: at(days),
        lastSeen: at(days),
      })),
    );

    const rollups = () =>
      db
        .select()
        .from(schema.eventsDaily)
        .where(eq(schema.eventsDaily.projectId, project))
        .orderBy(asc(schema.eventsDaily.day), asc(schema.eventsDaily.callsite));
    const rawDays = async () =>
      (
        await db
          .select({ ts: schema.events.ts })
          .from(schema.events)
          .where(eq(schema.events.projectId, project))
          .orderBy(asc(schema.events.ts))
      ).map((row) => row.ts.toISOString().slice(0, 10));

    const first = await pass({ eventsDays: 30, findingsDays: 365 });
    assert.equal(first.deletedEvents, 3);
    assert.equal(first.deletedBatches, 1);
    assert.equal(first.deletedFindings, 1);
    const rolled = await rollups();
    assert.deepEqual(
      rolled.map((r) => ({
        day: r.day,
        callsite: r.callsite,
        label: r.callsiteLabel,
        events: r.events,
        items: r.items,
        bytes: r.bytes,
        cached: r.cached,
        errors: r.errors,
        units: r.units,
      })),
      [
        {
          day: "2026-05-06",
          callsite: "",
          label: null,
          events: 2,
          items: 4,
          bytes: 200,
          cached: 1,
          errors: 0,
          units: { reads: 5, egress_bytes: 10 },
        },
        {
          day: "2026-05-06",
          callsite: "a.ts:1",
          label: "load",
          events: 1,
          items: 2,
          bytes: 100,
          cached: 0,
          errors: 1,
          units: { reads: 2 },
        },
        {
          day: "2026-06-10",
          callsite: "",
          label: null,
          events: 1,
          items: 2,
          bytes: 100,
          cached: 0,
          errors: 0,
          units: { reads: 2 },
        },
      ],
    );
    // Today is incomplete and stays raw; day -5 is rolled up but inside the raw window.
    assert.deepEqual(await rawDays(), ["2026-06-10", "2026-06-15"]);
    const batches = await db.select().from(schema.batches).where(eq(schema.batches.projectId, project));
    assert.deepEqual(batches.map((b) => b.id), [newBatch]);
    const findings = await db.select().from(schema.findings).where(eq(schema.findings.projectId, project));
    assert.deepEqual(findings.map((f) => f.rule), ["r-10"]);
    const [state] = await db
      .select()
      .from(schema.eventsRollupState)
      .where(eq(schema.eventsRollupState.projectId, project));
    assert.equal(state?.rolledUntil, "2026-06-15");

    // Idempotent: nothing new, nothing changes.
    const again = await pass({ eventsDays: 30, findingsDays: 365 });
    assert.equal(again.rolledRows, 0);
    assert.equal(again.deletedEvents, 0);
    assert.deepEqual(await rollups(), rolled);

    // Late events for rolled-up days are added on the next pass, exactly once.
    await event(newBatch, at(-5, 3), { units: { reads: 7 } });
    await event(newBatch, at(-40, 2));
    const late = await pass({ eventsDays: 30, findingsDays: 365 });
    assert.equal(late.rolledRows, 2);
    assert.equal(late.deletedEvents, 1);
    await pass({ eventsDays: 30, findingsDays: 365 });
    const after = await rollups();
    const day = (d: string, callsite = "") => after.find((r) => r.day === d && r.callsite === callsite);
    assert.equal(day("2026-05-06")?.events, 3);
    assert.deepEqual(day("2026-05-06")?.units, { reads: 7, egress_bytes: 10 });
    assert.equal(day("2026-06-10")?.events, 2);
    assert.deepEqual(day("2026-06-10")?.units, { reads: 9 });
    assert.deepEqual(await rawDays(), ["2026-06-10", "2026-06-10", "2026-06-15"]);

    // Next day: yesterday becomes complete; 0 disables findings deletion.
    const tomorrow = await runRetention(client, {
      now: new Date(NOW.getTime() + DAY),
      projectIds: [project],
      eventsDays: 30,
      findingsDays: 0,
    });
    if (!tomorrow.skipped) {
      assert.equal(tomorrow.deletedFindings, 0);
      const [today] = await db
        .select()
        .from(schema.eventsDaily)
        .where(and(eq(schema.eventsDaily.projectId, project), eq(schema.eventsDaily.day, "2026-06-15")));
      assert.equal(today?.events, 1);
    }

    // Rollup retention removes old days only.
    const trimmed = await pass({ eventsDays: 30, findingsDays: 0, rollupDays: 35, now: new Date(NOW.getTime() + DAY) });
    assert.equal(trimmed.deletedRollups, 2);
    assert.deepEqual(
      [...new Set((await rollups()).map((r) => r.day))],
      ["2026-06-10", "2026-06-15"],
    );
  } finally {
    await db.delete(schema.organizations).where(eq(schema.organizations.id, org));
    await close();
  }
});
