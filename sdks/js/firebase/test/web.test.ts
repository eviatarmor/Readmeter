import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { deleteApp, initializeApp } from "firebase/app";
import {
  and,
  collection,
  collectionGroup,
  count,
  doc,
  getFirestore,
  limit,
  limitToLast,
  or,
  orderBy,
  query,
  startAt,
  sum,
  where,
  writeBatch,
} from "firebase/firestore";

import { flush, init, shutdown, sink, sinkListener, sinkWrite } from "../src/index.ts";
import { flushPendingUsage, scheduleUsage } from "../src/core/usage.ts";
import { readAdminTarget } from "../src/admin/shape.ts";
import { aggregationsFromSpec, commitPath, mutationStats, readTarget } from "../src/web/shape.ts";
import { installUsage } from "../src/web/usage.ts";
import { HASH_KEY, bundleBytes } from "./bundle.ts";

class Snap {
  constructor(private readonly n: number) {}
  get size(): number {
    return this.n;
  }
  get empty(): boolean {
    return this.size === 0;
  }
  get docs(): number[] {
    this.forEach();
    return [1];
  }
  forEach(): void {}
  docChanges(): number[] {
    return [1];
  }
}

test("web shape, usage, and sink", { timeout: 30_000 }, async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let hits = 0;
    scheduleUsage(() => {
      hits += 1;
    });
    assert.equal(hits, 0);
    mock.timers.tick(1000);
    assert.equal(hits, 1);
    scheduleUsage(() => {
      hits += 1;
    });
    flushPendingUsage();
    assert.equal(hits, 2);
  } finally {
    mock.timers.reset();
  }

  const empty = new Snap(0);
  const emptyFlags = installUsage(empty);
  assert.ok(emptyFlags);
  assert.equal(empty.empty, true);
  assert.deepEqual(emptyFlags, { read_items: false, read_size: false, read_empty: true, items_used: 0, fields_read: 0, fields_numeric: false });

  const sized = new Snap(4);
  const sizeFlags = installUsage(sized);
  assert.ok(sizeFlags);
  assert.equal(sized.size, 4);
  assert.deepEqual(sizeFlags, { read_items: false, read_size: true, read_empty: false, items_used: 0, fields_read: 0, fields_numeric: false });
  assert.deepEqual(sized.docs, [1]);
  assert.equal(sizeFlags.read_items, true);

  assert.equal(installUsage(Object.freeze(new Snap(1))), undefined);

  const app = initializeApp({ apiKey: "demo", projectId: "demo-readmeter" }, "readmeter-web-unit");
  const db = getFirestore(app);
  try {
    const posts = query(
      collection(db, "posts"),
      and(where("status", "==", "open"), or(where("n", ">", 1), where("n", "<", 3))),
      orderBy("createdAt", "desc"),
      limit(20),
      startAt("cursor-page-1"),
    );
    const shape = readTarget(posts);
    assert.ok(shape);
    assert.equal(shape.path, "posts");
    assert.equal(shape.collectionGroup, undefined);
    assert.deepEqual(shape.query, {
      filters: [
        { field: "status", op: "==", value: "open" },
        { field: "n", op: ">", value: 1 },
        { field: "n", op: "<", value: 3 },
      ],
      order_by: [{ field: "createdAt", direction: "desc" }],
      limit: 20,
      start: ["cursor-page-1"],
    });
    assert.equal(shape.query && "offset" in shape.query, false);

    const grouped = readTarget(query(collectionGroup(db, "orders"), orderBy("createdAt"), limitToLast(5)));
    assert.ok(grouped);
    assert.equal(grouped.path, "orders");
    assert.equal(grouped.collectionGroup, true);
    assert.deepEqual(grouped.query, {
      order_by: [{ field: "createdAt" }],
      limit: 5,
      limit_to_last: true,
    });
    assert.deepEqual(readTarget(collection(db, "posts"))?.query, {});

    assert.deepEqual(aggregationsFromSpec({ total: sum("amount"), n: count() }), ["sum:amount", "count"]);

    const admin = readAdminTarget({
      _queryOptions: {
        parentPath: { relativeName: "" },
        collectionId: "posts",
        allDescendants: false,
        filters: [{ field: { formattedName: "status" }, op: "EQUAL", value: "open" }],
        fieldOrders: [{ field: { formattedName: "createdAt" }, direction: "ASCENDING" }],
        limit: 20,
        limitType: 0,
        offset: 200,
      },
    });
    assert.deepEqual(admin?.query, {
      filters: [{ field: "status", op: "==", value: "open" }],
      order_by: [{ field: "createdAt" }],
      limit: 20,
      offset: 200,
    });

    const batch = writeBatch(db);
    batch.set(doc(db, "audit", "a"), { n: 1 });
    batch.update(doc(db, "audit", "b"), { n: 2 });
    batch.delete(doc(db, "audit", "c"));
    const stats = mutationStats(batch);
    assert.deepEqual(stats && { writes: stats.writes, deletes: stats.deletes, path: commitPath(stats.paths) }, {
      writes: 2,
      deletes: 1,
      path: "audit",
    });

    const plain = { path: "users/a" };
    const listener = (value: unknown) => value;
    assert.equal(sink(plain, plain), plain);
    assert.equal(sinkWrite(plain, "set"), plain);
    assert.equal(sinkListener(plain, listener), listener);
    const boom = {
      get type(): string {
        throw new Error("boom");
      },
    };
    assert.equal(sink(boom, 1), 1);

    const logged: string[] = [];
    const original = console.debug;
    console.debug = (...args: unknown[]) => {
      if (args[0] === "[readmeter] raw" && typeof args[1] === "string") logged.push(args[1]);
    };
    const listeners: Array<() => void> = [];
    const fakeDocument = {
      visibilityState: "visible",
      addEventListener(_type: string, listener: () => void) {
        listeners.push(listener);
      },
      removeEventListener(_type: string, listener: () => void) {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      },
    };
    const host = globalThis as { document?: typeof fakeDocument };
    const previousDocument = host.document;
    host.document = fakeDocument;
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
      const ref = doc(db, "posts", "p01");
      for (const op of ["set", "set"] as const) sinkWrite(ref, op);
      assert.equal(logged.length, 3);
      const initCall = JSON.parse(logged[0] ?? "{}") as { op?: string };
      assert.equal(initCall.op, "init");
      const first = JSON.parse(logged[1] ?? "{}") as { callsite?: string; op?: string; path?: string; duration_us?: unknown };
      const second = JSON.parse(logged[2] ?? "{}") as { callsite?: string };
      assert.equal(first.op, "set");
      assert.equal(first.path, "posts/p01");
      assert.equal(first.duration_us, undefined);
      assert.equal(first.callsite, second.callsite);
      assert.match(first.callsite ?? "", /web\.test\.ts:\d+:\d+$/);
      const snap = { size: 0, docs: [], metadata: { fromCache: false } };
      assert.equal(sink(query(collection(db, "posts")), snap), snap);
      const recorded = JSON.parse(logged.at(-1) ?? "{}") as { op?: string; path?: string; duration_us?: unknown; query?: unknown };
      assert.equal(recorded.op, "query");
      assert.equal(recorded.path, "posts");
      assert.equal(recorded.duration_us, undefined);
      assert.deepEqual(recorded.query, {});

      logged.length = 0;
      fakeDocument.visibilityState = "hidden";
      for (const listener of [...listeners]) listener();
      fakeDocument.visibilityState = "visible";
      for (const listener of [...listeners]) listener();
      assert.equal(logged.length, 2);
      const hidden = JSON.parse(logged[0] ?? "{}") as { op?: string; visible?: boolean; ts_ms?: unknown; call_id?: unknown };
      const shown = JSON.parse(logged[1] ?? "{}") as { op?: string; visible?: boolean; ts_ms?: unknown; call_id?: unknown };
      assert.equal(hidden.op, "page");
      assert.equal(hidden.visible, false);
      assert.equal(typeof hidden.ts_ms, "number");
      assert.equal(typeof hidden.call_id, "number");
      assert.equal(shown.op, "page");
      assert.equal(shown.visible, true);
      assert.equal(typeof shown.ts_ms, "number");
      assert.equal(typeof shown.call_id, "number");
    } finally {
      console.debug = original;
      if (previousDocument === undefined) delete host.document;
      else host.document = previousDocument;
      await shutdown();
    }
  } finally {
    await deleteApp(app);
  }
});
