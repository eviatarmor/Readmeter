import assert from "node:assert/strict";
import { test } from "node:test";

import { flush, init, shutdown } from "../src/index.ts";
import { HASH_KEY, bundleBytes } from "./bundle.ts";

class FakeHost {
  readonly listeners = new Map<string, Array<() => void>>();
  visibilityState = "visible";

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    const at = list.indexOf(listener);
    if (at >= 0) list.splice(at, 1);
  }

  fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  count(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  total(): number {
    let n = 0;
    for (const list of this.listeners.values()) n += list.length;
    return n;
  }
}

type Globals = { document?: unknown; window?: unknown };

function start(): void {
  init({
    apiKey: "rm_test",
    endpoint: "http://127.0.0.1:9",
    hashKey: HASH_KEY,
    bundle: bundleBytes(),
    debug: true,
    platform: "browser",
  });
}

async function withHosts(
  doc: unknown,
  win: unknown,
  body: (logged: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const host = globalThis as Globals;
  const previous = { document: host.document, window: host.window };
  const original = console.debug;
  const logged: Array<Record<string, unknown>> = [];
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") {
      logged.push(JSON.parse(args[1]) as Record<string, unknown>);
    }
  };
  host.document = doc;
  host.window = win;
  try {
    await body(logged);
  } finally {
    console.debug = original;
    await shutdown();
    if (previous.document === undefined) delete host.document;
    else host.document = previous.document;
    if (previous.window === undefined) delete host.window;
    else host.window = previous.window;
  }
}

test("offline, online, freeze and resume are reported as connection events", { timeout: 30_000 }, async () => {
  const doc = new FakeHost();
  const win = new FakeHost();
  await withHosts(doc, win, async (logged) => {
    start();
    await flush();
    logged.length = 0;

    win.fire("offline");
    win.fire("online");
    doc.fire("freeze");
    doc.fire("resume");

    assert.deepEqual(
      logged.map((raw) => [raw.op, raw.online]),
      [
        ["connection", false],
        ["connection", true],
        ["connection", false],
        ["connection", true],
      ],
    );
    for (const raw of logged) {
      assert.equal(typeof raw.ts_ms, "number");
      assert.equal(typeof raw.call_id, "number");
      assert.equal("visible" in raw, false);
    }
    const ids = logged.map((raw) => raw.call_id as number);
    assert.deepEqual([...ids].sort((a, b) => a - b), ids);
    assert.equal(new Set(ids).size, ids.length);

    // Page visibility still works next to the new listeners.
    logged.length = 0;
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    assert.equal(logged.length, 1);
    assert.equal(logged[0]?.op, "page");
    assert.equal(logged[0]?.visible, false);
  });
});

test("re-init replaces host listeners and shutdown removes them", { timeout: 30_000 }, async () => {
  const doc = new FakeHost();
  const win = new FakeHost();
  await withHosts(doc, win, async (logged) => {
    start();
    start();
    await flush();
    for (const type of ["visibilitychange", "freeze", "resume"]) assert.equal(doc.count(type), 1, type);
    for (const type of ["offline", "online"]) assert.equal(win.count(type), 1, type);

    logged.length = 0;
    win.fire("offline");
    assert.equal(logged.length, 1);

    await shutdown();
    assert.equal(doc.total(), 0);
    assert.equal(win.total(), 0);
    logged.length = 0;
    win.fire("online");
    doc.fire("resume");
    assert.equal(logged.length, 0);
  });
});

test("missing or hostile hosts never throw into the app", { timeout: 30_000 }, async () => {
  await withHosts(undefined, undefined, async () => {
    assert.doesNotThrow(start);
    await flush();
  });

  const throwing = {
    addEventListener(): void {
      throw new Error("blocked");
    },
    removeEventListener(): void {
      throw new Error("blocked");
    },
  };
  await withHosts(throwing, throwing, async () => {
    assert.doesNotThrow(start);
    await flush();
    await assert.doesNotReject(shutdown());
  });

  // A window without addEventListener (e.g. a partial polyfill) is skipped.
  const doc = new FakeHost();
  await withHosts(doc, {}, async (logged) => {
    start();
    await flush();
    logged.length = 0;
    doc.fire("freeze");
    assert.equal(logged.length, 1);
    assert.equal(logged[0]?.online, false);
  });
});
