/**
 * console.warn pass-through for the Realtime Database missing-index warning.
 * The message text matches `@firebase/database` 1.1.5 (`warnOnListenWarnings_`
 * through `@firebase/logger`'s default handler). No real console is touched.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CALLSITE_CAP,
  forgetQueries,
  installIndexWarning,
  parseIndexWarning,
  rememberQuery,
  rememberedQueries,
  uninstallIndexWarning,
} from "../src/web/database-index.ts";

const PREFIX = "[2026-09-30T10:00:00.000Z]  @firebase/database:";

function sdkMessage(child: string, path: string): string {
  return (
    "FIREBASE WARNING: Using an unspecified index. Your data will be downloaded and filtered on the client. " +
    `Consider adding ".indexOn": "${child}" at ${path} to your security rules for better performance. `
  );
}

function fakeConsole() {
  const seen: { self: unknown; args: unknown[] }[] = [];
  const target = {
    warn(this: unknown, ...args: unknown[]): void {
      seen.push({ self: this, args });
    },
  };
  return { target, seen };
}

test("parses the SDK warning into path and child", () => {
  assert.deepEqual(parseIndexWarning([PREFIX, sdkMessage("pts", "/rooms/r1/scores")]), { path: "rooms/r1/scores", child: "pts" });
  assert.deepEqual(parseIndexWarning([PREFIX, sdkMessage("meta/created", "/")]), { path: "", child: "meta/created" });
  assert.deepEqual(parseIndexWarning([PREFIX, sdkMessage(".value", "/scores")]), { path: "scores", child: "$value" });
  assert.equal(parseIndexWarning([PREFIX, "FIREBASE WARNING: something else"]), undefined);
  assert.equal(parseIndexWarning(["Using an unspecified index, but not the SDK text"]), undefined);
  assert.equal(parseIndexWarning([{ not: "a string" }, 42, undefined]), undefined);
});

test("records the warning and always calls the original with the same this and args", () => {
  forgetQueries();
  const { target, seen } = fakeConsole();
  const recorded: Record<string, unknown>[] = [];
  assert.equal(installIndexWarning(target, (raw) => recorded.push(raw as Record<string, unknown>)), true);

  rememberQuery("rooms/r1/scores", "pts", "src/Board.tsx:12:3");
  const message = sdkMessage("pts", "/rooms/r1/scores");
  target.warn(PREFIX, message);
  const unrelated = { detail: 1 };
  target.warn("something else", unrelated);

  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.self, target);
  assert.deepEqual(seen[0]?.args, [PREFIX, message]);
  assert.equal(seen[1]?.args[1], unrelated, "unrelated arguments pass through by identity");

  assert.equal(recorded.length, 1);
  const call = recorded[0];
  assert.equal(call?.service, "database");
  assert.equal(call?.op, "index_warning");
  assert.equal(call?.path, "rooms/r1/scores");
  assert.equal(call?.order_by_child, "pts");
  assert.equal(call?.callsite, "src/Board.tsx:12:3");
  assert.equal(typeof call?.ts_ms, "number");
  assert.equal(typeof call?.call_id, "number");

  target.warn(PREFIX, sdkMessage("n", "/other"));
  assert.equal(recorded.length, 2);
  assert.equal(recorded[1]?.callsite, undefined, "no listener seen for that path and child");

  assert.equal(uninstallIndexWarning(target), true);
  target.warn(PREFIX, message);
  assert.equal(recorded.length, 2);
  assert.equal(seen.length, 4);
});

test("installs once", () => {
  const { target, seen } = fakeConsole();
  let records = 0;
  assert.equal(installIndexWarning(target, () => records++), true);
  const first = target.warn;
  assert.equal(installIndexWarning(target, () => records++), false);
  assert.equal(target.warn, first);
  target.warn(PREFIX, sdkMessage("pts", "/scores"));
  assert.equal(records, 1);
  assert.equal(seen.length, 1);
  uninstallIndexWarning(target);
});

test("recorder and parse failures are swallowed; original errors reach the caller", () => {
  const { target, seen } = fakeConsole();
  installIndexWarning(target, () => {
    throw new Error("recorder broke");
  });
  assert.doesNotThrow(() => target.warn(PREFIX, sdkMessage("pts", "/scores")));
  const hostile = {
    toString(): string {
      throw new Error("no");
    },
  };
  assert.doesNotThrow(() => target.warn(hostile, Symbol("x")));
  assert.equal(seen.length, 2);
  uninstallIndexWarning(target);

  const failing = {
    warn(..._args: unknown[]): void {
      throw new Error("host warn failed");
    },
  };
  let records = 0;
  installIndexWarning(failing, () => records++);
  assert.throws(() => failing.warn(PREFIX, sdkMessage("pts", "/scores")), /host warn failed/);
  assert.equal(records, 1, "observed even when the original throws");
  uninstallIndexWarning(failing);
});

test("a recorder that warns does not loop", () => {
  const { target, seen } = fakeConsole();
  let records = 0;
  installIndexWarning(target, () => {
    records += 1;
    target.warn(PREFIX, sdkMessage("pts", "/scores"));
  });
  target.warn(PREFIX, sdkMessage("pts", "/scores"));
  assert.equal(records, 1);
  assert.equal(seen.length, 2);
  uninstallIndexWarning(target);
});

test("callsite map is bounded and skips unindexable orders", () => {
  forgetQueries();
  for (let i = 0; i < CALLSITE_CAP + 50; i += 1) rememberQuery(`rooms/${i}/scores`, "pts", `src/A.tsx:${i}:1`);
  assert.equal(rememberedQueries(), CALLSITE_CAP);
  rememberQuery("posts", "$key", "src/B.tsx:1:1");
  rememberQuery("posts", "$priority", "src/B.tsx:1:1");
  rememberQuery("posts", "created", undefined);
  assert.equal(rememberedQueries(), CALLSITE_CAP);

  const { target } = fakeConsole();
  const recorded: Record<string, unknown>[] = [];
  installIndexWarning(target, (raw) => recorded.push(raw as Record<string, unknown>));
  target.warn(PREFIX, sdkMessage("pts", "/rooms/0/scores"));
  target.warn(PREFIX, sdkMessage("pts", `/rooms/${CALLSITE_CAP + 49}/scores`));
  assert.equal(recorded[0]?.callsite, undefined, "oldest entry was dropped");
  assert.equal(recorded[1]?.callsite, `src/A.tsx:${CALLSITE_CAP + 49}:1`);
  uninstallIndexWarning(target);
  forgetQueries();
});
