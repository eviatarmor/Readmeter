import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { recordRaw } from "../src/core/client.ts";
import { flush, init, shutdown } from "../src/index.ts";

const execCommand = promisify(exec);
const enabled = process.env.READMETER_E2E === "1";

test("posts an unbounded-list batch and the finding is stored", { skip: !enabled }, async () => {
  process.env.READMETER_BUNDLE_CACHE = mkdtempSync(path.join(tmpdir(), "readmeter-bundle-"));
  const endpoint = process.env.READMETER_INGEST_URL ?? "http://127.0.0.1:8090";
  init({
    apiKey: "rm_dev_key",
    endpoint,
    flushIntervalMs: 60_000,
    platform: "server",
  });
  recordRaw({
    service: "firestore",
    op: "query",
    ts_ms: Date.now(),
    call_id: 1,
    path: "e2e_sdk/uid_1/orders",
    query: { filters: [{ field: "status", op: "==", value: "open" }] },
    result: { docs: 1200, bytes: 240000 },
    callsite: "test/e2e.test.ts:1:1",
  });
  await flush();
  await shutdown();

  const root = fileURLToPath(new URL("../../../..", import.meta.url));
  const { stdout } = await execCommand(
    "pnpm run rm findings --project proj_demo --rule firebase.firestore/unbounded-list --json",
    {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL ?? "postgres://readmeter:readmeter@127.0.0.1:5442/readmeter",
      },
    },
  );
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  assert.ok(start >= 0 && end > start, stdout);
  const rows = JSON.parse(stdout.slice(start, end + 1)) as { rule: string; template: string }[];
  assert.ok(
    rows.some((row) => row.rule === "firebase.firestore/unbounded-list" && row.template === "e2e_sdk/{id}/orders"),
    stdout,
  );
});
