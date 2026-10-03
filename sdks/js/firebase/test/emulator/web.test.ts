/**
 * Web SDK against the Firestore emulator (port 8085).
 * Scenarios run one after another: the core client and its window state are singletons.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import * as fb from "firebase/firestore";

import { flush, init, shutdown, type Finding } from "../../src/index.ts";
import * as rm from "../../src/web/firestore.ts";
import { HASH_KEY, bundleBytes } from "../bundle.ts";

interface Fixture {
  calls: Record<string, unknown>[];
  expect_findings: { rule: string }[];
}

const raw: Record<string, unknown>[] = [];
const findings: Finding[] = [];
const deviations: string[] = [];

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
  // `usage` calls fire on a 1 s timer, so on a slow machine they can land
  // before the comparison. Only compare them when the fixture lists them.
  if (!fixture.calls.some((want) => want.op === "usage")) skip.add("usage");
  // Init is one raw call per Firestore instance. Fixtures that do not list it
  // are not asserting client setup.
  if (!fixture.calls.some((want) => want.op === "init")) skip.add("init");
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
    platform: "browser",
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

/** Unsubscribe, then wait until no further raw calls arrive, before the client is replaced. */
async function settleListeners(unsubs: Array<() => void>): Promise<void> {
  for (const unsub of unsubs.splice(0, unsubs.length)) {
    try {
      unsub();
    } catch {
      // Already closed.
    }
  }
  let last = raw.length;
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (raw.length === last) return;
    last = raw.length;
  }
}

async function seed(db: fb.Firestore): Promise<void> {
  const items: { ref: fb.DocumentReference; data: Record<string, unknown> }[] = [];
  const orders = fb.collection(db, "users", "uid_1", "orders");
  for (let i = 0; i < 1200; i += 1) items.push({ ref: fb.doc(orders), data: { status: "open" } });
  const messages = fb.collection(db, "messages");
  for (let i = 0; i < 3000; i += 1) items.push({ ref: fb.doc(messages), data: { read: false } });
  const feed = fb.collection(db, "feed");
  for (let i = 0; i < 60; i += 1) items.push({ ref: fb.doc(feed), data: { ts: i } });
  for (let i = 1; i <= 6; i += 1) {
    items.push({
      ref: fb.doc(db, "posts", `p${String(i).padStart(2, "0")}`),
      data: { createdAt: i, title: "t" },
    });
  }
  items.push({ ref: fb.doc(db, "users", "u1"), data: { name: "abcde" } });
  items.push({ ref: fb.doc(db, "users", "u2"), data: { name: "abcdef" } });
  items.push({ ref: fb.doc(db, "drafts", "d1"), data: { body: "" } });
  items.push({ ref: fb.doc(db, "accounts", "acc_1"), data: { balance: 1 } });
  items.push({
    ref: fb.doc(db, "profiles", "p1"),
    data: { blob: "x".repeat(262144), tags: [] as string[] },
  });

  let batch = fb.writeBatch(db);
  let pending = 0;
  for (const item of items) {
    batch.set(item.ref, item.data);
    pending += 1;
    if (pending === 400) {
      await batch.commit();
      batch = fb.writeBatch(db);
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();
}

test("web drop-in matches the firestore fixtures", { timeout: 180_000 }, async () => {
  const original = console.debug;
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") {
      raw.push(JSON.parse(args[1]) as Record<string, unknown>);
    }
  };

  const { host, port } = emulatorAddress();
  const app: FirebaseApp = initializeApp({ apiKey: "demo", projectId: "demo-readmeter" }, "readmeter-web-emulator");
  const db = fb.getFirestore(app);
  fb.connectFirestoreEmulator(db, host, port);
  const unsubs: Array<() => void> = [];
  try {
    await seed(db);

    await scenario(async () => {
      const snap = await rm.getDocs(fb.query(fb.collection(db, "users", "uid_1", "orders"), fb.where("status", "==", "open")));
      assert.equal(snap.size, 1200);
      assertCalls(raw.slice(), loadFixture("unbounded-list"));
      assertRule("firebase.firestore/unbounded-list");
    });

    await scenario(async () => {
      const feed = fb.collection(db, "feed");
      for (const n of [20, 40, 60]) await rm.getDocs(fb.query(feed, fb.orderBy("ts", "desc"), fb.limit(n)));
      assertCalls(raw.slice(), loadFixture("missing-cursor"));
      assertRule("firebase.firestore/missing-cursor");
    });

    await scenario(async () => {
      const snap = await rm.getDocs(fb.query(fb.collection(db, "messages"), fb.where("read", "==", false), fb.limit(5000)));
      assert.equal(snap.size, 3000);
      await flush();
      const got = raw.slice();
      const usage = got.find((call) => call.op === "usage");
      const queryCall = got.find((call) => call.op === "query");
      assert.equal(usage?.call_id, queryCall?.call_id);
      const bytes = (queryCall?.result as { bytes?: number } | undefined)?.bytes ?? 0;
      assertCalls(got, loadFixture("count-via-fetch"));
      assertRule("firebase.firestore/oversized-limit");
      assertRule("firebase.firestore/count-via-fetch");
      const payload = findings.some((finding) => finding.rule === "generic/oversized-payload");
      if (bytes <= 524288) {
        assert.equal(payload, false);
        deviations.push(`count-via-fetch: estimated bytes ${bytes} are under max_response_bytes 524288 (fixture bytes 900000), so oversized-payload does not fire`);
      } else {
        assert.equal(payload, true);
      }
    });

    await scenario(async () => {
      const posts = fb.query(fb.collection(db, "posts"), fb.orderBy("createdAt", "desc"), fb.limit(20));
      const snap = await rm.getDocs(posts);
      assert.equal(snap.size, 6);
      unsubs.push(rm.onSnapshot(posts, () => undefined));
      assertCalls(raw.slice(), loadFixture("get-then-listen"), ["snapshot", "unsubscribe", "usage"]);
      assertRule("firebase.firestore/get-then-listen");
      await settleListeners(unsubs);
    });

    await scenario(async () => {
      for (let i = 1; i <= 25; i += 1) unsubs.push(rm.onSnapshot(fb.doc(db, "posts", `p${String(i).padStart(2, "0")}`), () => undefined));
      const subs = raw.filter((call) => call.op === "subscribe");
      assert.equal(subs.length, 25);
      assert.ok(subs.every((call) => call.query === undefined));
      assertCalls(raw.slice(), loadFixture("listener-per-item"), ["snapshot", "unsubscribe"]);
      assertRule("firebase.firestore/listener-per-item");
      await settleListeners(unsubs);
    });

    await scenario(async () => {
      const users = fb.collection(db, "users");
      for (const prefix of ["a", "ab", "abc", "abcd"]) await rm.getDocs(fb.query(users, fb.where("name", ">=", prefix), fb.limit(8)));
      assertCalls(raw.slice(), loadFixture("query-per-keystroke"));
      assertRule("firebase.firestore/query-per-keystroke");
    });

    await scenario(async () => {
      const draft = fb.doc(db, "drafts", "d1");
      for (const ch of ["a", "b", "c", "d", "e"]) await rm.updateDoc(draft, { body: ch });
      assertCalls(raw.slice(), loadFixture("write-per-keystroke"));
      assertRule("firebase.firestore/write-per-keystroke");
    });

    await scenario(async () => {
      const account = fb.doc(db, "accounts", "acc_1");
      let tries = 0;
      await rm.runTransaction(db, async (tx) => {
        tries += 1;
        const snap = await tx.get(account);
        if (tries < 4) throw Object.assign(new Error("retry"), { name: "FirebaseError", code: "aborted" });
        tx.update(account, { balance: (snap.data()?.balance ?? 0) + 1 });
      });
      const batch = rm.writeBatch(db);
      batch.set(fb.doc(db, "audit", "a1"), { n: 1 });
      batch.set(fb.doc(db, "audit", "a2"), { n: 1 });
      batch.set(fb.doc(db, "audit", "a3"), { n: 1 });
      batch.delete(fb.doc(db, "audit", "gone"));
      await batch.commit();
      assertCalls(raw.slice(), loadFixture("transaction-and-batch"));
      assertRule("firebase.firestore/transaction-contention");
    });

    await scenario(async () => {
      const snap = await rm.getDocs(
        fb.query(fb.collection(db, "messages"), fb.where("read", "==", false), fb.limit(100)),
      );
      for (const item of snap.docs.slice(0, 5)) item.data();
      await flush();
      assertCalls(raw.slice(), loadFixture("overfetch"));
      assertRule("firebase.firestore/overfetch");
    });

    await scenario(async () => {
      const latest = fb.query(fb.collection(db, "posts"), fb.limit(1));
      for (let i = 0; i < 3; i += 1) await rm.getDocsFromServer(latest);
      assertCalls(raw.slice(), loadFixture("force-server-read"));
      assertRule("firebase.firestore/force-server-read");
    });

    await scenario(async () => {
      const draft = fb.doc(db, "drafts", "noop");
      for (let i = 0; i < 3; i += 1) await rm.setDoc(draft, { body: "same" });
      assertCalls(raw.slice(), loadFixture("no-op-write"));
      assertRule("firebase.firestore/no-op-write");
    });

    await scenario(async () => {
      const account = fb.doc(db, "accounts", "acc_1");
      for (let i = 0; i < 3; i += 1) {
        await rm.runTransaction(db, async (tx) => {
          const snap = await tx.get(account);
          tx.update(account, { balance: (snap.data()?.balance ?? 0) + 1 });
        });
      }
      assertCalls(raw.slice(), loadFixture("read-modify-write-counter"));
      assertRule("firebase.firestore/read-modify-write-counter");
    });

    await scenario(async () => {
      const posts = fb.collection(db, "posts");
      for (const authorId of ["Xb3kD9aQ2mLp7rT1vY0z", "Yc4lE0bR3nMq8sU2wZ1a", "Zd5mF1cS4oNr9tV3xA2b"]) {
        await rm.getDocs(fb.query(posts, fb.where("authorId", "==", authorId), fb.limit(5)));
      }
      await flush();
      assertCalls(raw.slice(), loadFixture("unused-result"));
      assertRule("generic/unused-result");
    });

    await scenario(async () => {
      const profile = fb.doc(db, "profiles", "p1");
      await rm.updateDoc(profile, { tags: fb.arrayUnion("a") });
      const snap = await rm.getDoc(profile);
      const blob = snap.data()?.blob;
      assert.equal(typeof blob, "string");
      assert.ok((blob as string).length >= 262144);
      const got = raw.find((call) => call.op === "get");
      const bytes = (got?.result as { bytes?: number } | undefined)?.bytes ?? 0;
      assert.ok(bytes >= 262144, `growing-document estimated ${bytes} bytes`);
      assertCalls(raw.slice(), loadFixture("growing-document"));
      assertRule("firebase.firestore/growing-document");
    });

    if (deviations.length > 0) console.log(deviations.join("\n"));
  } finally {
    console.debug = original;
    for (const unsub of unsubs) {
      try {
        unsub();
      } catch {
        // The listener may already be closed by shutdown.
      }
    }
    await shutdown();
    await deleteApp(app);
  }
});
