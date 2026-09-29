/**
 * Admin SDK against the Firestore emulator (port 8085).
 * Scenarios run one after another: the core client and its window state are singletons.
 * offset-pagination lives here because the web modular SDK has no offset().
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type DocumentReference, type Firestore, type WriteBatch } from "firebase-admin/firestore";

import { instrument } from "../../src/admin/index.ts";
import { flush, init, shutdown, type Finding } from "../../src/index.ts";
import { HASH_KEY, bundleBytes } from "../bundle.ts";

interface Fixture {
  calls: Record<string, unknown>[];
  expect_findings: { rule: string }[];
}

const raw: Record<string, unknown>[] = [];
const findings: Finding[] = [];

function loadFixture(name: string): Fixture {
  const path = fileURLToPath(new URL(`../../../../../conformance/fixtures/firebase/firestore/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

function emulatorAddress(): { host: string; port: number } {
  const rawHost = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8085";
  const [host, portText] = rawHost.split(":");
  const port = Number(portText);
  if (!host || port !== 8085) {
    throw new Error(`Firestore emulator must be 127.0.0.1:8085 (FIRESTORE_EMULATOR_HOST=${rawHost})`);
  }
  return { host, port };
}

const VOLATILE = ["ts_ms", "call_id", "listener", "callsite", "duration_us"];

function normalize(call: Record<string, unknown>, check: boolean): Record<string, unknown> {
  const copy = structuredClone(call);
  if (check) {
    assert.equal(typeof copy.ts_ms, "number");
    assert.equal(typeof copy.call_id, "number");
    if (copy.op === "usage") {
      assert.equal(copy.duration_us, undefined);
      assert.equal(copy.callsite, undefined);
    } else {
      assert.equal(typeof copy.duration_us, "number");
      assert.equal(typeof copy.callsite, "string");
    }
  }
  for (const key of VOLATILE) delete copy[key];
  freezeSignals(copy, check);
  const result = copy.result;
  if (result && typeof result === "object") {
    const bytes = (result as { bytes?: unknown }).bytes;
    if (check && bytes !== undefined) {
      assert.equal(typeof bytes, "number");
      assert.ok((bytes as number) > 0, `${String(copy.op)} ${String(copy.path)}`);
    }
    if (bytes !== undefined) delete (result as { bytes?: unknown }).bytes;
  }
  return copy;
}

function freezeSignals(copy: Record<string, unknown>, check: boolean): void {
  if ("transaction" in copy) {
    if (check) {
      assert.equal(typeof copy.transaction, "number");
      assert.equal(Number.isInteger(copy.transaction), true);
      assert.ok((copy.transaction as number) >= 1);
    }
    copy.transaction = 1;
  }
  const write = copy.write;
  if (write && typeof write === "object" && "digest" in write) {
    const digest = (write as { digest?: unknown }).digest;
    if (check) assert.match(String(digest), /^[0-9a-f]{16}$/);
    (write as { digest: string }).digest = "0000000000000000";
  }
}

function assertCalls(actual: Record<string, unknown>[], fixture: Fixture, ignoreOps: string[] = []): void {
  const skip = new Set(ignoreOps);
  const got = actual.filter((call) => !skip.has(String(call.op)));
  const unexpected = got.filter((call) => !fixture.calls.some((want) => want.op === call.op));
  assert.deepEqual(
    unexpected.map((call) => call.op),
    [],
    `unexpected ops ${JSON.stringify(unexpected)}`,
  );
  assert.deepEqual(
    got.map((call) => normalize(call, true)),
    fixture.calls.map((call) => normalize(call, false)),
  );
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
    platform: "server",
    onFinding(finding) {
      findings.push(finding);
    },
  });
  await flush();
  raw.length = 0;
  findings.length = 0;
}

async function scenario(body: () => Promise<void>): Promise<void> {
  await boot();
  try {
    await body();
  } finally {
    await shutdown();
  }
}

async function settleListeners(unsubs: Array<() => void>): Promise<void> {
  for (const unsub of unsubs.splice(0, unsubs.length)) {
    try {
      unsub();
    } catch {
      // Already closed.
    }
  }
  let last = raw.length;
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (raw.length === last) return;
    last = raw.length;
  }
}

async function waitFor(label: string, pred: () => boolean): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 10_000) throw new Error(`timed out waiting for ${label}; raw=${JSON.stringify(raw)}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function commitAll(db: Firestore, items: { ref: DocumentReference; data: Record<string, unknown> }[]): Promise<void> {
  let batch: WriteBatch = db.batch();
  let pending = 0;
  for (const item of items) {
    batch.set(item.ref, item.data);
    pending += 1;
    if (pending === 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();
}

test("admin instrument matches the firestore fixtures", { timeout: 180_000 }, async () => {
  emulatorAddress();
  const original = console.debug;
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") {
      raw.push(JSON.parse(args[1]) as Record<string, unknown>);
    }
  };

  const app: App = initializeApp({ projectId: "demo-readmeter" }, "readmeter-admin-emulator");
  const seedApp: App = initializeApp({ projectId: "demo-readmeter" }, "readmeter-admin-seed");
  const db = instrument(getFirestore(app));
  const seedDb = getFirestore(seedApp);
  const unsubs: Array<() => void> = [];
  try {
    assert.equal(db, getFirestore(app));
    for (const name of ["users", "posts", "accounts", "audit"]) {
      await seedDb.recursiveDelete(seedDb.collection(name));
    }

    const items: { ref: DocumentReference; data: Record<string, unknown> }[] = [];
    const orders = seedDb.collection("users").doc("uid_1").collection("orders");
    for (let i = 0; i < 1200; i += 1) items.push({ ref: orders.doc(), data: { status: "open" } });
    for (let i = 1; i <= 6; i += 1) {
      items.push({
        ref: seedDb.collection("posts").doc(`p${String(i).padStart(2, "0")}`),
        data: { createdAt: i, title: "t" },
      });
    }
    items.push({ ref: seedDb.collection("accounts").doc("acc_1"), data: { balance: 1 } });
    await commitAll(seedDb, items);

    await scenario(async () => {
      const snap = await db.collection("users").doc("uid_1").collection("orders").where("status", "==", "open").get();
      assert.equal(snap.size, 1200);
      assertCalls(raw.slice(), loadFixture("unbounded-list"));
      assertRule("firebase.firestore/unbounded-list");
    });

    await scenario(async () => {
      const posts = db.collection("posts").orderBy("createdAt", "desc").limit(20);
      const snap = await posts.get();
      assert.equal(snap.size, 6);
      unsubs.push(posts.onSnapshot(() => undefined));
      await waitFor("subscribe", () => raw.some((call) => call.op === "subscribe"));
      assertCalls(raw.slice(), loadFixture("get-then-listen"), ["snapshot", "unsubscribe", "usage"]);
      assertRule("firebase.firestore/get-then-listen");
      await settleListeners(unsubs);
    });

    await scenario(async () => {
      const more: { ref: DocumentReference; data: Record<string, unknown> }[] = [];
      for (let i = 7; i <= 220; i += 1) {
        more.push({
          ref: seedDb.collection("posts").doc(`p${String(i).padStart(3, "0")}`),
          data: { createdAt: i, title: "t" },
        });
      }
      await commitAll(seedDb, more);
      const snap = await db.collection("posts").orderBy("createdAt").offset(200).limit(20).get();
      assert.equal(snap.size, 20);
      assertCalls(raw.slice(), loadFixture("offset-pagination"));
      assertRule("firebase.firestore/offset-pagination");
    });

    await scenario(async () => {
      const account = db.collection("accounts").doc("acc_1");
      let tries = 0;
      await db.runTransaction(async (tx) => {
        tries += 1;
        const snap = await tx.get(account);
        if (tries < 4) throw Object.assign(new Error("retry"), { code: 10 });
        tx.update(account, { balance: (snap.data()?.balance ?? 0) + 1 });
      });
      assert.equal(tries, 4);
      const batch = db.batch();
      batch.set(db.collection("audit").doc("a1"), { n: 1 });
      batch.set(db.collection("audit").doc("a2"), { n: 1 });
      batch.set(db.collection("audit").doc("a3"), { n: 1 });
      batch.delete(db.collection("audit").doc("gone"));
      await batch.commit();
      assertCalls(raw.slice(), loadFixture("transaction-and-batch"));
      assertRule("firebase.firestore/transaction-contention");
    });

  } finally {
    console.debug = original;
    for (const unsub of unsubs) {
      try {
        unsub();
      } catch {
        // The listener may already be closed.
      }
    }
    await shutdown();
    await deleteApp(app);
    await deleteApp(seedApp);
  }
});
