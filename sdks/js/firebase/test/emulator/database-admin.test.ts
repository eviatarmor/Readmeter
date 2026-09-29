/**
 * Admin SDK against the Realtime Database emulator (port 9000).
 * Patches Reference once, on, off, get, set, update, push, remove, and transaction.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getDatabase, type DataSnapshot } from "firebase-admin/database";

import { instrumentDatabase } from "../../src/admin/index.ts";
import { flush, init, shutdown, type Finding } from "../../src/index.ts";
import { HASH_KEY, bundleBytes } from "../bundle.ts";

const raw: Record<string, unknown>[] = [];
const findings: Finding[] = [];

function emulatorAddress(): { host: string; port: number } {
  const rawHost = process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? "127.0.0.1:9000";
  const [host, portText] = rawHost.split(":");
  const port = Number(portText);
  if (!host || port !== 9000) {
    throw new Error(`Realtime Database emulator must be 127.0.0.1:9000 (FIREBASE_DATABASE_EMULATOR_HOST=${rawHost})`);
  }
  return { host, port };
}

function calls(): Record<string, unknown>[] {
  return raw.filter((call) => call.service === "database");
}

test("admin prototype patch records Realtime Database calls", { timeout: 180_000 }, async () => {
  const original = console.debug;
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") {
      raw.push(JSON.parse(args[1]) as Record<string, unknown>);
    }
  };

  const { port } = emulatorAddress();
  assert.equal(port, 9000);
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
  await flush();
  raw.length = 0;
  findings.length = 0;

  const app: App = initializeApp(
    { projectId: "demo-readmeter", databaseURL: "https://demo-readmeter.firebaseio.com" },
    "readmeter-database-admin",
  );
  const database = instrumentDatabase(getDatabase(app));
  const ref = database.ref("admin/probe");

  try {
    await ref.set({ n: 1 });
    await ref.update({ n: 2 });
    const pushed = ref.push({ n: 3 });
    assert.equal(typeof pushed.key, "string");
    assert.equal(pushed.key.length, 20);
    await pushed;
    await ref.child(pushed.key).remove();

    const tx = await ref.transaction((current: unknown) => {
      const row = current && typeof current === "object" ? (current as { n?: number }) : {};
      return { n: (row.n ?? 0) + 1 };
    });
    assert.equal(tx.committed, true);
    assert.ok((tx.snapshot.val() as { n?: number }).n);

    const once = await ref.once("value");
    assert.equal(typeof once.val(), "object");
    const got = await ref.get();
    assert.equal(typeof got.val(), "object");

    const child = await ref.once("child_added");
    assert.equal(typeof child.key, "string");

    await new Promise<void>((resolve, reject) => {
      const callback = (snap: DataSnapshot): void => {
        try {
          assert.equal(typeof snap.val(), "object");
          const returned = callback as (a: DataSnapshot | null, b?: string | null) => unknown;
          ref.off("value", returned);
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const returned = ref.on("value", callback);
      assert.equal(returned, callback);
    });

    const queried = await ref.orderByChild("n").limitToLast(5).equalTo(2).get();
    assert.equal(typeof queried.numChildren(), "number");

    await flush();

    const ops = calls().map((call) => call.op);
    for (const op of ["set", "update", "create", "delete", "get", "child_added", "subscribe", "snapshot", "unsubscribe", "query"]) {
      assert.ok(ops.includes(op), `missing ${op} in ${ops.join(",")}`);
    }
    const created = calls().find((call) => call.op === "create");
    assert.ok(String(created?.path).startsWith("admin/probe/"));
    assert.equal(calls().some((call) => call.op === "subscribe" && call.path === "admin/probe" && calls().filter((item) => item.op === "child_added").length > 0), true);
    const onceChild = calls().filter((call) => call.op === "child_added");
    assert.ok(onceChild.some((call) => call.listener === undefined));
    const shape = calls().find((call) => call.op === "query")?.query as { order_by?: string; limit?: number; limit_to_last?: boolean } | undefined;
    assert.equal(shape?.order_by, "n");
    assert.equal(shape?.limit, 5);
    assert.equal(shape?.limit_to_last, true);
    const txCall = calls().find((call) => call.op === "update" && call.result && typeof call.result === "object");
    assert.equal(typeof (txCall?.result as { bytes?: number } | undefined)?.bytes, "number");
    assert.ok(findings.every((finding) => finding.rule !== "firebase.database/unindexed-query"));
  } finally {
    console.debug = original;
    await shutdown();
    await deleteApp(app);
  }
});
