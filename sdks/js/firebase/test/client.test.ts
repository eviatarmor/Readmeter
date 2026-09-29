import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreClient, configJson, openCore, recordRaw } from "../src/core/client.ts";
import { loadWasm } from "../src/core/wasm.ts";
import { flush, init, shutdown } from "../src/index.ts";
import { HASH_KEY, bundleBytes } from "./bundle.ts";

const unbounded = {
  service: "firestore",
  op: "query",
  ts_ms: 1000,
  call_id: 1,
  path: "users/uid_1/orders",
  query: { filters: [{ field: "status", op: "==", value: "open" }] },
  result: { docs: 1200, bytes: 240000 },
  callsite: "src/Orders.tsx:14:9",
};

test("bad raw json does not throw and a real query finds unbounded-list", async () => {
  const client = await openCore({
    hashKey: HASH_KEY,
    bundle: bundleBytes(),
    platform: "server",
    session: "1",
    evaluations: ["local"],
  });
  try {
    assert.deepEqual(client.record("{"), { findings: [], wrote: true });
    assert.deepEqual(client.record("null"), { findings: [], wrote: true });
    const result = client.record(unbounded);
    assert.ok(result.findings.some((finding) => finding.rule === "firebase.firestore/unbounded-list"));
    const batch = client.drain(1_700_000_000_000);
    assert.ok(batch);
    assert.equal(batch[0], 0x52);
    assert.equal(batch[1], 0x4d);
  } finally {
    client.free();
  }
});

test("calls queued before wasm is attached are recorded", async () => {
  const client = new CoreClient();
  client.record(unbounded);
  assert.equal(client.depth, 1);
  const wasm = await loadWasm(false);
  const handle = new wasm.Readmeter(
    configJson({
      hashKey: HASH_KEY,
      session: "1",
      platform: "server",
      dev: false,
      sampleRate: 1,
      evaluations: ["local"],
    }),
    bundleBytes(),
  );
  assert.equal(client.attach(handle), 1);
  assert.equal(client.depth, 0);
  const batch = client.drain(1_700_000_000_000);
  assert.ok(batch);
  client.free();
});

test("a dead config endpoint does not throw", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => {
    lines.push(String(message));
  };
  const cache = process.env.READMETER_BUNDLE_CACHE;
  process.env.READMETER_BUNDLE_CACHE = mkdtempSync(path.join(tmpdir(), "readmeter-cache-"));
  try {
    init({
      apiKey: "rm_dev_key",
      endpoint: "http://127.0.0.1:9",
      flushIntervalMs: 60_000,
      platform: "server",
    });
    assert.doesNotThrow(() => recordRaw(unbounded));
    await flush();
    await shutdown();
    assert.ok(lines.some((line) => line.includes("disabled")));
  } finally {
    console.error = original;
    if (cache === undefined) delete process.env.READMETER_BUNDLE_CACHE;
    else process.env.READMETER_BUNDLE_CACHE = cache;
  }
});

