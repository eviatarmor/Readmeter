import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { connect, schema, type Db } from "@readmeter/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";

import { fakeClients, type ClientFactory, type GcpClients } from "../src/clients.ts";
import { encryptSecret } from "../src/crypto.ts";
import { lockKeys } from "../src/lock.ts";
import { syncDue } from "../src/sync.ts";

const databaseUrl = process.env.DATABASE_URL ?? "";
const secret = Buffer.from("0123456789abcdef0123456789abcdef");
const now = new Date("2026-09-15T12:00:00.000Z");
const billingTable = "demo-readmeter.billing.gcp_billing_export_v1";

function account(email: string) {
  return {
    type: "service_account" as const,
    client_email: email,
    private_key: "fake-private-key",
    project_id: "demo-readmeter",
  };
}

async function fixture(db: Db, email: string) {
  const suffix = randomUUID().slice(0, 8);
  const orgId = `org_gcp_${suffix}`;
  const projectId = `proj_gcp_${suffix}`;
  await db.insert(schema.organizations).values({ id: orgId, name: "GCP", slug: `gcp-${suffix}` });
  await db.insert(schema.projects).values({
    id: projectId,
    orgId,
    name: "App",
    hashKey: "a".repeat(32),
    environment: "development",
  });
  const sealed = encryptSecret(JSON.stringify(account(email)), secret);
  const [row] = await db
    .insert(schema.gcpConnections)
    .values({
      orgId,
      projectId,
      gcpProjectId: "demo-readmeter",
      clientEmail: email,
      keyCiphertext: sealed.ciphertext,
      keyIv: sealed.iv,
      keyTag: sealed.tag,
      billingTable,
      status: "pending",
    })
    .returning({ id: schema.gcpConnections.id });
  return { orgId, projectId, connectionId: row!.id };
}

async function cleanup(db: Db, orgId: string) {
  await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
}

test("sync upserts monitoring and billing rows once", { skip: !databaseUrl }, async () => {
  const { db, close } = connect(databaseUrl);
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  const row = await fixture(db, "reader@demo-readmeter.iam.gserviceaccount.com");
  const clients: ClientFactory = async (serviceAccount) => fakeClients(serviceAccount, now);
  try {
    const first = await syncDue(db, {
      sql,
      clients,
      secretKey: secret,
      maxBytesBilled: 1000,
      timeoutMs: 5000,
      now,
      onlyIds: [row.connectionId],
    });
    assert.deepEqual(first.synced, [row.connectionId]);
    const usage = await db.select().from(schema.usageDaily).where(eq(schema.usageDaily.projectId, row.projectId));
    assert.equal(usage.length, 14);
    const todayReads = usage.find((item) => item.day === "2026-09-15" && item.metric === "reads");
    const olderReads = usage.find((item) => item.day === "2026-09-05" && item.metric === "reads");
    const todayCalls = usage.find((item) => item.day === "2026-09-15" && item.metric === "invocations");
    assert.equal(Number(todayReads?.amount), 10);
    assert.equal(Number(olderReads?.amount), 4);
    assert.equal(Number(todayCalls?.amount), 20);
    assert.equal(usage.every((item) => item.source === "monitoring"), true);
    const costs = await db.select().from(schema.costDaily).where(eq(schema.costDaily.projectId, row.projectId));
    assert.equal(costs.length, 2);
    const today = costs.find((item) => item.day === "2026-09-15");
    const older = costs.find((item) => item.day === "2026-09-05");
    assert.equal(today?.service, "Cloud Firestore");
    assert.equal(today?.sku, "Read Ops");
    assert.equal(today?.costMicros, 1_250_000);
    assert.equal(today?.creditsMicros, -250_000);
    assert.equal(older?.costMicros, 500_000);
    assert.equal(older?.creditsMicros, 0);

    const second = await syncDue(db, {
      sql,
      clients,
      secretKey: secret,
      maxBytesBilled: 1000,
      timeoutMs: 5000,
      now: new Date(now.getTime() + 7 * 60 * 60 * 1000),
      onlyIds: [row.connectionId],
    });
    assert.deepEqual(second.synced, [row.connectionId]);
    const usageAgain = await db.select().from(schema.usageDaily).where(eq(schema.usageDaily.projectId, row.projectId));
    const costsAgain = await db.select().from(schema.costDaily).where(eq(schema.costDaily.projectId, row.projectId));
    assert.equal(usageAgain.length, 14);
    assert.equal(costsAgain.length, 2);
    const olderAgain = usageAgain.find((item) => item.day === "2026-09-05" && item.metric === "reads");
    assert.equal(Number(olderAgain?.amount), 4);
  } finally {
    await cleanup(db, row.orgId);
    await sql.end({ timeout: 5 });
    await close();
  }
});

test("one connection failing does not stop the next", { skip: !databaseUrl }, async () => {
  const { db, close } = connect(databaseUrl);
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  const good = await fixture(db, "reader@demo-readmeter.iam.gserviceaccount.com");
  const bad = await fixture(db, "fail@readmeter.invalid");
  const clients: ClientFactory = async (serviceAccount) => fakeClients(serviceAccount, now);
  try {
    const pass = await syncDue(db, {
      sql,
      clients,
      secretKey: secret,
      maxBytesBilled: 1000,
      timeoutMs: 5000,
      now,
      onlyIds: [good.connectionId, bad.connectionId],
    });
    assert.ok(pass.synced.includes(good.connectionId));
    assert.ok(pass.failed.includes(bad.connectionId));
    const [badRow] = await db
      .select({ status: schema.gcpConnections.status, lastError: schema.gcpConnections.lastError })
      .from(schema.gcpConnections)
      .where(eq(schema.gcpConnections.id, bad.connectionId));
    assert.equal(badRow?.status, "error");
    assert.match(badRow?.lastError ?? "", /monitoring denied/);
    const [goodRow] = await db
      .select({ status: schema.gcpConnections.status })
      .from(schema.gcpConnections)
      .where(eq(schema.gcpConnections.id, good.connectionId));
    assert.equal(goodRow?.status, "ok");
  } finally {
    await cleanup(db, good.orgId);
    await cleanup(db, bad.orgId);
    await sql.end({ timeout: 5 });
    await close();
  }
});

test("a sync that exceeds the timeout is marked failed", { skip: !databaseUrl }, async () => {
  const { db, close } = connect(databaseUrl);
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  const row = await fixture(db, "reader@demo-readmeter.iam.gserviceaccount.com");
  const clients: ClientFactory = async () => hangingClients();
  try {
    const pass = await syncDue(db, {
      sql,
      clients,
      secretKey: secret,
      maxBytesBilled: 1000,
      timeoutMs: 100,
      now,
      onlyIds: [row.connectionId],
    });
    assert.deepEqual(pass.failed, [row.connectionId]);
    const [saved] = await db
      .select({ status: schema.gcpConnections.status, lastError: schema.gcpConnections.lastError })
      .from(schema.gcpConnections)
      .where(eq(schema.gcpConnections.id, row.connectionId));
    assert.equal(saved?.status, "error");
    assert.match(saved?.lastError ?? "", /sync timed out/);
  } finally {
    await cleanup(db, row.orgId);
    await sql.end({ timeout: 5 });
    await close();
  }
});

test("a held advisory lock skips that connection", { skip: !databaseUrl }, async () => {
  const { db, close } = connect(databaseUrl);
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  const row = await fixture(db, "reader@demo-readmeter.iam.gserviceaccount.com");
  const reserved = await sql.reserve();
  const [k1, k2] = lockKeys(row.connectionId);
  const clients: ClientFactory = async (serviceAccount) => fakeClients(serviceAccount, now);
  try {
    await reserved`select pg_try_advisory_lock(${k1}::integer, ${k2}::integer)`;
    const skipped = await syncDue(db, {
      sql,
      clients,
      secretKey: secret,
      maxBytesBilled: 1000,
      timeoutMs: 5000,
      now,
      onlyIds: [row.connectionId],
    });
    assert.deepEqual(skipped.skipped, [row.connectionId]);
    const usage = await db.select().from(schema.usageDaily).where(eq(schema.usageDaily.projectId, row.projectId));
    assert.equal(usage.length, 0);
    await reserved`select pg_advisory_unlock(${k1}::integer, ${k2}::integer)`;
    const synced = await syncDue(db, {
      sql,
      clients,
      secretKey: secret,
      maxBytesBilled: 1000,
      timeoutMs: 5000,
      now,
      onlyIds: [row.connectionId],
    });
    assert.deepEqual(synced.synced, [row.connectionId]);
  } finally {
    reserved.release();
    await cleanup(db, row.orgId);
    await sql.end({ timeout: 5 });
    await close();
  }
});

function hangingClients(): GcpClients {
  return {
    monitoring: {
      projectPath: (projectId) => `projects/${projectId}`,
      listTimeSeries: () => new Promise(() => {}),
    },
    bigquery: {
      query: () => new Promise(() => {}),
    },
  };
}
