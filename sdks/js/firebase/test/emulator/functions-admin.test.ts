/**
 * withFlush records one invoke. Firestore reads observed during the handler
 * are a count on that invoke. Cold is the first withFlush in the process.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { flush, init, shutdown, type Finding } from "../../src/index.ts";
import { withFlush } from "../../src/admin/index.ts";
import { recordRaw } from "../../src/core/client.ts";
import { HASH_KEY, bundleBytes } from "../bundle.ts";

const raw: Record<string, unknown>[] = [];
const findings: Finding[] = [];

test("withFlush records cold start, memory, and Firestore reads", { timeout: 60_000 }, async () => {
  const previousMemory = process.env.FUNCTION_MEMORY_MB;
  const previousTarget = process.env.FUNCTION_TARGET;
  process.env.FUNCTION_MEMORY_MB = "256";
  process.env.FUNCTION_TARGET = "readStorm";
  const original = console.debug;
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") {
      raw.push(JSON.parse(args[1]) as Record<string, unknown>);
    }
  };

  init({
    apiKey: "rm_test",
    endpoint: "http://127.0.0.1:9",
    hashKey: HASH_KEY,
    bundle: bundleBytes(),
    dev: true,
    debug: true,
    platform: "server",
    onFinding(finding) {
      findings.push(finding);
    },
  });

  const handler = withFlush(async () => {
    recordRaw({
      service: "firestore",
      op: "query",
      result: { docs: 501 },
      query: {},
      ts_ms: Date.now(),
    });
    return { ok: true };
  });
  const warm = withFlush(async () => ({ ok: true }));

  try {
    await flush();
    raw.length = 0;
    findings.length = 0;
    await handler();
    await warm();
    await flush();
    const invokes = raw.filter((call) => call.service === "functions" && call.op === "invoke");
    assert.equal(invokes.length, 2);
    assert.equal(invokes[0]?.name, "readStorm");
    assert.equal(invokes[0]?.cold, true);
    assert.equal(invokes[0]?.memory_mb, 256);
    assert.equal(invokes[0]?.reads, 501);
    assert.equal(invokes[1]?.cold, undefined);
    assert.equal(invokes[1]?.reads, undefined);
    assert.ok(
      findings.some((finding) => finding.rule === "firebase.functions/reads-per-invocation"),
      `missing reads-per-invocation; have ${findings.map((finding) => finding.rule).join(", ")}`,
    );
  } finally {
    console.debug = original;
    if (previousMemory === undefined) delete process.env.FUNCTION_MEMORY_MB;
    else process.env.FUNCTION_MEMORY_MB = previousMemory;
    if (previousTarget === undefined) delete process.env.FUNCTION_TARGET;
    else process.env.FUNCTION_TARGET = previousTarget;
    await shutdown();
  }
});
