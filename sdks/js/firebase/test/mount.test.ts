import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteApp, initializeApp } from "firebase/app";
import { goOffline, getDatabase, ref } from "firebase/database";
import { collection, doc, getFirestore, query, terminate } from "firebase/firestore";

import { currentMount, flush, init, newMountId, runInMount, shutdown, sink, sinkListener, sinkWrite } from "../src/index.ts";
import { onValue } from "../src/web/database.ts";
import { onSnapshot } from "../src/web/firestore.ts";
import { HASH_KEY, bundleBytes } from "./bundle.ts";

type Raw = Record<string, unknown>;

async function capture(body: (logged: Raw[]) => Promise<void> | void): Promise<void> {
  const original = console.debug;
  const logged: Raw[] = [];
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") logged.push(JSON.parse(args[1]) as Raw);
  };
  try {
    init({
      apiKey: "rm_test",
      endpoint: "http://127.0.0.1:9",
      hashKey: HASH_KEY,
      bundle: bundleBytes(),
      debug: true,
      platform: "browser",
    });
    await flush();
    logged.length = 0;
    await body(logged);
  } finally {
    console.debug = original;
    await shutdown();
  }
}

test("runInMount sets the current mount for synchronous work only", () => {
  const a = newMountId();
  const b = newMountId();
  assert.ok(Number.isSafeInteger(a) && a > 0);
  assert.ok(b > a);
  assert.equal(currentMount(), undefined);
  assert.equal(
    runInMount(a, () => {
      assert.equal(currentMount(), a);
      runInMount(b, () => assert.equal(currentMount(), b));
      return currentMount();
    }),
    a,
  );
  assert.equal(currentMount(), undefined);

  const error = new Error("host");
  assert.throws(
    () =>
      runInMount(a, () => {
        throw error;
      }),
    (thrown) => thrown === error,
  );
  assert.equal(currentMount(), undefined);

  for (const bad of [0, -1, 1.5, Number.NaN, "3" as unknown as number]) {
    assert.equal(runInMount(bad, () => currentMount()), undefined);
  }
  assert.equal(runInMount(a, undefined as unknown as () => number), undefined);
});

test("runInMount works without init and costs nothing", () => {
  const value = { n: 1 };
  assert.equal(runInMount(newMountId(), () => sink({ path: "x" }, value)), value);
});

test("sink, sinkWrite and sinkListener carry the mount; listener events keep it", { timeout: 30_000 }, async () => {
  const app = initializeApp({ apiKey: "demo", projectId: "demo-readmeter" }, "readmeter-mount-sink");
  const db = getFirestore(app);
  try {
    await capture((logged) => {
      const mount = newMountId();
      const q = query(collection(db, "todos"));
      const snap = { size: 0, docs: [], metadata: { fromCache: false } };
      let listener: ((snap: unknown) => unknown) | undefined;
      runInMount(mount, () => {
        sink(q, snap);
        sinkWrite(doc(db, "todos", "t1"), "set");
        listener = sinkListener(q, () => undefined);
      });
      // A snapshot delivered later, outside the component's effect.
      listener?.({ size: 0, docs: [], docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } });
      sink(q, snap);

      const calls = logged.filter((raw) => raw.op !== "init");
      assert.deepEqual(
        calls.map((raw) => [raw.op, raw.mount]),
        [
          ["query", mount],
          ["set", mount],
          ["subscribe", mount],
          ["snapshot", mount],
          ["query", undefined],
        ],
      );
    });
  } finally {
    await deleteApp(app);
  }
});

test("Firestore and Realtime Database listeners carry the opening mount", { timeout: 30_000 }, async () => {
  const app = initializeApp(
    { apiKey: "demo", projectId: "demo-readmeter", databaseURL: "http://127.0.0.1:9?ns=demo-readmeter" },
    "readmeter-mount-dropin",
  );
  const fs = getFirestore(app);
  const rtdb = getDatabase(app);
  goOffline(rtdb);
  try {
    await capture((logged) => {
      const mount = newMountId();
      const unsubs = runInMount(mount, () => [
        onSnapshot(query(collection(fs, "todos")), () => undefined),
        onValue(ref(rtdb, "rooms"), () => undefined),
      ]);
      // Cleanup outside runInMount still reports the listener's mount.
      for (const unsub of unsubs) unsub();
      const listeners = logged.filter((raw) => raw.op === "subscribe" || raw.op === "unsubscribe");
      assert.deepEqual(
        listeners.map((raw) => [raw.service, raw.op, raw.mount]),
        [
          ["firestore", "subscribe", mount],
          ["database", "subscribe", mount],
          ["firestore", "unsubscribe", mount],
          ["database", "unsubscribe", mount],
        ],
      );
    });
  } finally {
    await terminate(fs);
    await deleteApp(app);
  }
});
