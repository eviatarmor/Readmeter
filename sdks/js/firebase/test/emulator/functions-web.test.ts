/**
 * Web drop-in against the Functions emulator (port 5001).
 * Payloads, the emulator host, and the project id stay off the raw record.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";

import { flush, init, shutdown, type Finding } from "../../src/index.ts";
import * as functions from "../../src/web/functions.ts";
import { HASH_KEY, bundleBytes } from "../bundle.ts";

const raw: Record<string, unknown>[] = [];
const findings: Finding[] = [];

function emulatorHost(): { host: string; port: number } {
  const rawHost = (process.env.FIREBASE_FUNCTIONS_EMULATOR ?? "127.0.0.1:5001").replace(/^https?:\/\//, "");
  const [host, portText] = rawHost.split(":");
  const port = Number(portText);
  if (!host || port !== 5001) {
    throw new Error(`Functions emulator must be 127.0.0.1:5001 (${rawHost})`);
  }
  return { host, port };
}

function calls(): Record<string, unknown>[] {
  return raw.filter((call) => call.service === "functions");
}

function assertRule(rule: string): void {
  assert.ok(
    findings.some((finding) => finding.rule === rule),
    `missing ${rule}; have ${findings.map((finding) => finding.rule).join(", ")}`,
  );
}

async function boot(): Promise<void> {
  init({
    apiKey: "rm_test",
    endpoint: "http://127.0.0.1:9",
    hashKey: HASH_KEY,
    bundle: bundleBytes(),
    dev: true,
    debug: true,
    platform: "browser",
    onFinding(finding) {
      findings.push(finding);
    },
  });
  await flush();
  raw.length = 0;
  findings.length = 0;
}

test("web drop-in records Cloud Functions callables", { timeout: 180_000 }, async () => {
  const original = console.debug;
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") {
      raw.push(JSON.parse(args[1]) as Record<string, unknown>);
    }
  };

  const app: FirebaseApp = initializeApp({ apiKey: "demo", projectId: "demo-readmeter" }, "readmeter-functions-web");
  const fns = functions.getFunctions(app, "us-central1");
  const endpoint = emulatorHost();
  functions.connectFunctionsEmulator(fns, endpoint.host, endpoint.port);

  try {
    await boot();
    const echo = functions.httpsCallable(fns, "echo");
    assert.equal(typeof echo.stream, "function");
    const secret = "secret-value";
    const result = await echo({ token: secret });
    assert.equal((result.data as { ok?: boolean }).ok, true);
    const first = calls().filter((call) => call.op === "callable");
    assert.equal(first.length, 1);
    assert.equal(first[0]?.name, "echo");
    assert.equal(typeof first[0]?.request_bytes, "number");
    assert.ok(Number(first[0]?.request_bytes) > 0);

    const fromUrl = functions.httpsCallableFromURL(fns, "http://127.0.0.1:5001/demo-readmeter/us-central1/echo");
    await fromUrl({ n: 1 });
    const named = calls().filter((call) => call.name === "echo");
    assert.ok(named.length >= 2);

    const hostOnly = functions.httpsCallableFromURL(fns, "http://127.0.0.1:9");
    await assert.rejects(hostOnly({ n: 1 }));
    assert.ok(calls().some((call) => call.name === "unknown"));

    const loop = functions.httpsCallable(fns, "echo");
    for (let i = 0; i < 10; i += 1) await loop({ n: i });
    assertRule("firebase.functions/callable-in-loop");

    const payload = "x".repeat(1_048_576);
    await echo({ blob: payload });
    assertRule("firebase.functions/large-callable-payload");

    const fail = functions.httpsCallable(fns, "fail");
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(fail({ n: i }));
    }
    const failures = calls().filter((call) => call.name === "fail");
    assert.equal(failures.length, 5);
    assert.equal(failures.every((call) => call.error === "unavailable"), true);
    assertRule("generic/retry-storm");

    const dumped = JSON.stringify(calls());
    assert.equal(dumped.includes(secret), false);
    assert.equal(dumped.includes("nope"), false);
    assert.equal(dumped.includes("127.0.0.1"), false);
    assert.equal(dumped.includes("demo-readmeter"), false);
  } finally {
    console.debug = original;
    await flush();
    await shutdown();
    await deleteApp(app);
  }
});
