/**
 * Web drop-in against the Realtime Database emulator (port 9000).
 * Sizes match the conformance fixtures: 1 MiB root read, 500 children, 10 list updates of 100 KB.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";

import { flush, init, shutdown, type Finding } from "../../src/index.ts";
import * as db from "../../src/web/database.ts";
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
    await flush();
  } finally {
    await shutdown();
  }
}

function waitUntil(ready: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (ready()) {
        resolve();
        return;
      }
      if (Date.now() - start > 20_000) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function resultOf(call: Record<string, unknown> | undefined): { children?: number; bytes?: number } {
  const result = call?.result;
  if (!result || typeof result !== "object") return {};
  return result as { children?: number; bytes?: number };
}

test("web drop-in records Realtime Database and fires the fixture rules", { timeout: 180_000 }, async () => {
  const original = console.debug;
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") {
      raw.push(JSON.parse(args[1]) as Record<string, unknown>);
    }
  };

  const { host, port } = emulatorAddress();
  const app: FirebaseApp = initializeApp(
    { apiKey: "demo", projectId: "demo-readmeter", databaseURL: "https://demo-readmeter.firebaseio.com" },
    "readmeter-database-web",
  );
  const database = db.getDatabase(app);
  db.connectDatabaseEmulator(database, host, port);

  try {
    await scenario(async () => {
      const archive = db.ref(database, "archive");
      await db.set(archive, "a".repeat(1_048_576));
      const snap = await db.get(archive);
      assert.equal(typeof snap.val(), "string");
      const read = calls().find((call) => call.op === "get" && call.path === "archive");
      const stats = resultOf(read);
      assert.ok((stats.bytes ?? 0) >= 1_048_576, `archive bytes ${stats.bytes}`);
      assertRule("firebase.database/listen-on-root");
      assertRule("generic/oversized-payload");
    });

    await scenario(async () => {
      const posts: Record<string, { n: number }> = {};
      for (let i = 0; i < 500; i += 1) posts[`c${i}`] = { n: i };
      const location = db.ref(database, "posts");
      await db.set(location, posts);
      const snap = await db.get(location);
      assert.equal(snap.size, 500);
      const read = calls().find((call) => call.op === "get" && call.path === "posts");
      assert.ok((resultOf(read).children ?? 0) >= 500);
      assert.equal(read?.query, undefined);
      assertRule("firebase.database/download-whole-list");
    });

    await scenario(async () => {
      const list = db.ref(database, "chats/lobby/messages");
      const body = "b".repeat(102_400);
      await db.set(list, { body });
      let hits = 0;
      const unsub = db.onValue(list, () => {
        hits += 1;
      });
      try {
        await waitUntil(() => hits >= 1, "initial list snapshot");
        for (let i = 0; i < 10; i += 1) {
          const before = hits;
          await db.set(db.child(list, "body"), `${body}${i}`);
          await waitUntil(() => hits > before, `list update ${i}`);
        }
      } finally {
        unsub();
      }
      const updates = calls().filter(
        (call) => call.op === "snapshot" && call.path === "chats/lobby/messages" && call.initial !== true,
      );
      assert.ok(updates.length >= 10, `updates ${updates.length}`);
      assert.ok(updates.every((call) => (resultOf(call).bytes ?? 0) >= 102_400));
      assert.ok(calls().some((call) => call.op === "subscribe" && call.path === "chats/lobby/messages"));
      assert.ok(calls().some((call) => call.op === "unsubscribe" && call.path === "chats/lobby/messages"));
      assertRule("firebase.database/value-listener-on-list");
    });

    await scenario(async () => {
      const counter = db.ref(database, "counters/online");
      for (let i = 0; i < 20; i += 1) await db.update(counter, { n: i });
      const writes = calls().filter((call) => call.op === "update" && call.path === "counters/online");
      assert.equal(writes.length, 20);
      assertRule("firebase.database/rtdb-write-hotspot");
    });

    await scenario(async () => {
      const board = db.ref(database, "boards/live");
      const unsubs = [db.onValue(board, () => undefined), db.onValue(board, () => undefined), db.onValue(board, () => undefined)];
      try {
        const subs = calls().filter((call) => call.op === "subscribe" && call.path === "boards/live");
        assert.equal(subs.length, 3);
        assertRule("firebase.database/duplicate-listeners");
      } finally {
        for (const unsub of unsubs) unsub();
      }
    });

    await scenario(async () => {
      await Promise.all(
        Array.from({ length: 10 }, (_, index) => db.get(db.ref(database, `items/${index + 1}`))),
      );
      const reads = calls().filter((call) => call.op === "get" && String(call.path).startsWith("items/"));
      assert.equal(reads.length, 10);
      assertRule("generic/n-plus-one");
    });

    await scenario(async () => {
      const limited = db.query(db.ref(database, "posts"), db.orderByChild("n"), db.limitToLast(25), db.equalTo(1));
      await db.get(limited);
      const read = calls().find((call) => call.op === "query" && call.path === "posts");
      const shape = read?.query as { order_by?: string; limit?: number; limit_to_last?: boolean; filters?: { field?: string; op?: string }[] } | undefined;
      assert.equal(shape?.order_by, "n");
      assert.equal(shape?.limit, 25);
      assert.equal(shape?.limit_to_last, true);
      assert.equal(shape?.filters?.[0]?.field, "n");
      assert.equal(shape?.filters?.[0]?.op, "==");
      assert.equal(findings.some((finding) => finding.rule === "firebase.database/unindexed-query"), false);

      let children = 0;
      const feed = db.ref(database, "feed");
      const unsub = db.onChildAdded(feed, () => {
        children += 1;
      });
      const pushed = db.push(feed, { n: 1 });
      assert.equal(typeof pushed.key, "string");
      await pushed;
      await waitUntil(() => children >= 1, "child_added");
      unsub();
      assert.ok(calls().some((call) => call.op === "create" && String(call.path).startsWith("feed/")));
      assert.ok(calls().some((call) => call.op === "child_added" && call.path === "feed"));
      assert.ok(calls().some((call) => call.op === "unsubscribe" && call.path === "feed"));

      const unsubsBefore = calls().filter((call) => call.op === "unsubscribe" && call.path === "feed").length;
      const onceUnsub = db.onValue(db.ref(database, "feed"), () => undefined, { onlyOnce: true });
      await waitUntil(
        () => calls().filter((call) => call.op === "unsubscribe" && call.path === "feed").length > unsubsBefore,
        "onlyOnce unsubscribe",
      );
      onceUnsub();

      db.goOffline(database);
      db.goOnline(database);
      assert.ok(calls().some((call) => call.op === "go_offline"));
      assert.ok(calls().some((call) => call.op === "go_online"));
    });

    await scenario(async () => {
      // No .indexOn for `pts` under leaderboard in database.rules.json.
      const board = db.ref(database, "leaderboard/season1");
      await db.set(board, { a: { pts: 1 }, b: { pts: 2 }, c: { pts: 3 } });
      let snaps = 0;
      const unsub = db.onValue(db.query(board, db.orderByChild("pts"), db.limitToLast(2)), () => {
        snaps += 1;
      });
      try {
        await waitUntil(() => snaps >= 1, "ordered snapshot");
        await waitUntil(() => calls().some((call) => call.op === "index_warning"), "index warning");
      } finally {
        unsub();
      }
      const warning = calls().find((call) => call.op === "index_warning");
      assert.equal(warning?.path, "leaderboard/season1");
      assert.equal(warning?.order_by_child, "pts");
      assert.equal(typeof warning?.callsite, "string");
      assertRule("firebase.database/unindexed-query");
    });
  } finally {
    console.debug = original;
    await deleteApp(app);
  }
});
