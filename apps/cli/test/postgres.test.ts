// Creates a project and key, then lists findings. Skipped without DATABASE_URL.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { connect, schema } from "@readmeter/db";
import { eq } from "drizzle-orm";

import { run } from "../src/commands.ts";
import { parseArgs } from "../src/parse.ts";

const url = process.env.DATABASE_URL;

test("creates a project and key and lists findings", { skip: !url }, async () => {
  const suffix = randomUUID().slice(0, 8);
  const org = `org_${suffix}`;
  const project = `proj_${suffix}`;
  const { db, close } = connect(url);
  try {
    const created = await run(db, parseArgs(["project", "create", project, "--org", org, "--name", "Test"]));
    assert.match(created, new RegExp(`id\\s+${project}`));
    const hashKey = created.match(/hash_key\s+([0-9a-f]{32})/)?.[1];
    assert.ok(hashKey);

    const keyOut = await run(
      db,
      parseArgs(["key", "create", project, "--origin", "http://localhost:5173"]),
    );
    assert.match(keyOut, /key\s+rm_[0-9A-Za-z]{32}/);
    assert.match(keyOut, new RegExp(`hash_key\\s+${hashKey}`));
    assert.match(keyOut, /endpoint: "http:\/\/127\.0\.0\.1:8090"/);
    const apiKey = keyOut.match(/key\s+(rm_[0-9A-Za-z]{32})/)?.[1];
    assert.ok(apiKey);

    const [stored] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.projectId, project));
    assert.equal(stored?.prefix, apiKey.slice(0, 8));
    assert.deepEqual(stored?.allowedOrigins, ["http://localhost:5173"]);

    const listed = await run(db, parseArgs(["key", "list", project]));
    assert.match(listed, new RegExp(stored!.prefix));
    assert.match(listed, /http:\/\/localhost:5173/);

    const now = new Date();
    const finding = {
      projectId: project,
      source: "sdk",
      provider: "firebase",
      service: "firestore",
      template: "posts",
      session: "s1",
      evidence: {},
      firstSeen: now,
      lastSeen: new Date(now.getTime() - 90_000),
    };
    await db.insert(schema.findings).values([
      {
        ...finding,
        rule: "firebase.firestore/offset-pagination",
        severity: "high",
        callsite: "abcdef0123456789",
        message: "offset reads extra documents",
        wasted: { reads: 120, egress_bytes: 4000 },
        occurrences: 3,
      },
      {
        ...finding,
        rule: "firebase.firestore/unbounded-list",
        severity: "critical",
        callsite: "1234567890abcdef",
        message: "list has no limit",
        wasted: { reads: 10 },
        occurrences: 1,
        session: "s2",
      },
    ]);

    const text = await run(db, parseArgs(["findings", "--project", project, "--since", "1h"]), now);
    const lines = text.split("\n").filter((line) => line.startsWith("critical") || line.startsWith("high"));
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /critical/);
    assert.match(lines[0]!, /12345678/);
    assert.match(lines[1]!, /high/);
    assert.match(lines[1]!, /abcdef01/);
    assert.match(text, /reads=120 egress_bytes=4k|egress_bytes=4k reads=120/);
    assert.match(text, /1m ago/);

    const json = JSON.parse(await run(db, parseArgs(["findings", "--project", project, "--json"]), now)) as {
      severity: string;
      callsite: string;
    }[];
    assert.deepEqual(
      json.map((row) => row.severity),
      ["critical", "high"],
    );
    assert.equal(json[1]?.callsite, "abcdef0123456789");

    const events = JSON.parse(await run(db, parseArgs(["events", "--project", project, "--json"]))) as unknown[];
    assert.deepEqual(events, []);

    const stats = JSON.parse(await run(db, parseArgs(["stats", "--project", project, "--json"]), now)) as {
      batches: number;
      events: number;
      findings: number;
    };
    assert.deepEqual(stats, { batches: 0, events: 0, findings: 2, top_templates_24h: [] });

    const revoked = await run(db, parseArgs(["key", "revoke", apiKey]));
    assert.match(revoked, new RegExp(`revoked 1 key \\(${apiKey.slice(0, 8)}\\)`));
    const [after] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.projectId, project));
    assert.ok(after?.revokedAt);
  } finally {
    await db.delete(schema.organizations).where(eq(schema.organizations.id, org));
    await close();
  }
});
