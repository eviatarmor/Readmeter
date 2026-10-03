import assert from "node:assert/strict";
import { test } from "node:test";

import { flush, init, shutdown, type InitOptions } from "../src/index.ts";
import { HASH_KEY, bundleBytes } from "./bundle.ts";

class FakeWindow {
  readonly listeners = new Map<string, Array<() => void>>();
  readonly location = { pathname: "/", search: "", hash: "" };
  readonly calls: string[] = [];
  readonly history: Record<string, unknown>;
  readonly originalPush: (...args: unknown[]) => void;
  readonly originalReplace: (...args: unknown[]) => void;

  constructor() {
    const self = this;
    this.originalPush = function (_state: unknown, _title: unknown, url?: unknown) {
      self.calls.push("push");
      if (typeof url === "string") self.go(url);
    };
    this.originalReplace = function (_state: unknown, _title: unknown, url?: unknown) {
      self.calls.push("replace");
      if (typeof url === "string") self.go(url);
    };
    this.history = { pushState: this.originalPush, replaceState: this.originalReplace };
  }

  go(url: string): void {
    const parsed = new URL(url, "https://app.example.com");
    this.location.pathname = parsed.pathname;
    this.location.search = parsed.search;
    this.location.hash = parsed.hash;
  }

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
}

type Globals = { document?: unknown; window?: unknown };

function start(extra: Partial<InitOptions> = {}): void {
  init({
    apiKey: "rm_test",
    endpoint: "http://127.0.0.1:9",
    hashKey: HASH_KEY,
    bundle: bundleBytes(),
    debug: true,
    platform: "browser",
    ...extra,
  });
}

async function withWindow(win: unknown, body: (logged: Array<Record<string, unknown>>) => Promise<void>): Promise<void> {
  const host = globalThis as Globals;
  const previous = host.window;
  const original = console.debug;
  const logged: Array<Record<string, unknown>> = [];
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") {
      logged.push(JSON.parse(args[1]) as Record<string, unknown>);
    }
  };
  host.window = win;
  try {
    await body(logged);
  } finally {
    console.debug = original;
    await shutdown();
    if (previous === undefined) delete host.window;
    else host.window = previous;
  }
}

const navigations = (logged: Array<Record<string, unknown>>) => logged.filter((raw) => raw.op === "navigate");

test("pushState, replaceState, popstate and hashchange report route changes once", { timeout: 30_000 }, async () => {
  const win = new FakeWindow();
  await withWindow(win, async (logged) => {
    start();
    await flush();
    logged.length = 0;

    const history = win.history as { pushState: (...a: unknown[]) => void; replaceState: (...a: unknown[]) => void };
    assert.notEqual(history.pushState, win.originalPush);
    history.pushState({}, "", "/users/u_123?tab=orders#top");
    // Same path, new query: not a route change.
    history.replaceState({}, "", "/users/u_123?tab=billing");
    history.pushState({}, "", "/settings");
    win.go("/users/u_9");
    win.fire("popstate");
    // A plain anchor is not a route.
    win.go("/users/u_9#section");
    win.fire("hashchange");
    // Hash routers keep the route in the fragment.
    win.go("/#/inbox/42?x=1");
    win.fire("hashchange");

    assert.deepEqual(win.calls, ["push", "replace", "push"]);
    const routes = navigations(logged).map((raw) => raw.route);
    assert.deepEqual(routes, ["/users/u_123", "/settings", "/users/u_9", "/inbox/42"]);
    for (const raw of navigations(logged)) {
      assert.equal(typeof raw.ts_ms, "number");
      assert.equal(typeof raw.call_id, "number");
      assert.ok(!String(raw.route).includes("?") && !String(raw.route).includes("#"));
    }
  });
});

test("history patches are idempotent and undone by re-init and shutdown", { timeout: 30_000 }, async () => {
  const win = new FakeWindow();
  await withWindow(win, async (logged) => {
    start();
    start();
    await flush();
    const history = win.history as { pushState: (...a: unknown[]) => void };
    logged.length = 0;
    history.pushState({}, "", "/a");
    assert.equal(navigations(logged).length, 1);
    assert.deepEqual(win.calls, ["push"]);
    assert.equal(win.count("popstate"), 1);
    assert.equal(win.count("hashchange"), 1);

    await shutdown();
    assert.equal(win.history.pushState, win.originalPush);
    assert.equal(win.history.replaceState, win.originalReplace);
    assert.equal(win.count("popstate"), 0);
    logged.length = 0;
    history.pushState({}, "", "/b");
    assert.equal(navigations(logged).length, 0);
  });
});

test("a wrapper installed on top of ours is left in place and not doubled", { timeout: 30_000 }, async () => {
  const win = new FakeWindow();
  await withWindow(win, async (logged) => {
    start();
    await flush();
    const ours = win.history.pushState as (...a: unknown[]) => unknown;
    const theirs = function (this: unknown, ...args: unknown[]) {
      return ours.apply(this, args);
    };
    win.history.pushState = theirs;

    await shutdown();
    assert.equal(win.history.pushState, theirs);
    logged.length = 0;
    (win.history.pushState as (...a: unknown[]) => void)({}, "", "/x");
    assert.equal(navigations(logged).length, 0);

    start();
    await flush();
    assert.equal(win.history.pushState, theirs);
    logged.length = 0;
    (win.history.pushState as (...a: unknown[]) => void)({}, "", "/y");
    assert.deepEqual(navigations(logged).map((raw) => raw.route), ["/y"]);
  });
});

test("routes: false and hostile hosts never patch or throw", { timeout: 30_000 }, async () => {
  const win = new FakeWindow();
  await withWindow(win, async (logged) => {
    start({ routes: false });
    await flush();
    assert.equal(win.history.pushState, win.originalPush);
    logged.length = 0;
    (win.history.pushState as (...a: unknown[]) => void)({}, "", "/z");
    assert.equal(navigations(logged).length, 0);
  });

  const frozen = new FakeWindow();
  Object.freeze(frozen.history);
  await withWindow(frozen, async () => {
    assert.doesNotThrow(() => start());
    await flush();
    assert.doesNotThrow(() => (frozen.history.pushState as (...a: unknown[]) => void)({}, "", "/q"));
  });

  const throwing = new FakeWindow();
  throwing.go = () => {};
  Object.defineProperty(throwing, "location", {
    get() {
      throw new Error("blocked");
    },
  });
  await withWindow(throwing, async () => {
    assert.doesNotThrow(() => start());
    await flush();
    assert.doesNotThrow(() => (throwing.history.pushState as (...a: unknown[]) => void)({}, "", "/q"));
  });

  // The host's own pushState errors still reach the host, unchanged.
  const failing = new FakeWindow();
  const error = new Error("SecurityError");
  failing.history.pushState = () => {
    throw error;
  };
  await withWindow(failing, async () => {
    start();
    await flush();
    assert.throws(() => (failing.history.pushState as (...a: unknown[]) => void)({}, "", "/q"), (thrown) => thrown === error);
  });
});

test("an invalid routes option disables the SDK without throwing", async () => {
  const original = console.error;
  const errors: string[] = [];
  console.error = (message: unknown) => {
    errors.push(String(message));
  };
  try {
    assert.doesNotThrow(() => start({ routes: "yes" as unknown as boolean }));
    assert.ok(errors.some((line) => line.includes("routes must be a boolean")));
  } finally {
    console.error = original;
    await shutdown();
  }
});
