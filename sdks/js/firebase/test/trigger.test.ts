/**
 * trigger-cascade: withFlush derives the trigger pattern from a Firestore
 * event in memory and counts committed writes that match it. Only the count
 * is on the raw invoke. No emulator: a fake Firestore RPC funnel.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { flush, init, shutdown, type Finding } from "../src/index.ts";
import { instrument, withFlush } from "../src/admin/index.ts";
import { matchesTrigger, triggerPattern } from "../src/admin/trigger.ts";
import { HASH_KEY, bundleBytes } from "./bundle.ts";

const DOCS = "projects/demo/databases/(default)/documents/";
const RULE = "firebase.functions/trigger-cascade";
const V1_WRITE = "providers/cloud.firestore/eventTypes/document.write";

const raw: Record<string, unknown>[] = [];
const logged: string[] = [];
const findings: Finding[] = [];
const originalDebug = console.debug;
const previousTarget = process.env.FUNCTION_TARGET;

let failNext = false;
const db = instrument({
  request(_method: string, _request: unknown) {
    if (failNext) {
      failNext = false;
      return Promise.reject(Object.assign(new Error("denied"), { code: 7 }));
    }
    return Promise.resolve({});
  },
  requestStream() {
    return Promise.resolve({});
  },
});

function set(path: string): Record<string, unknown> {
  return { update: { name: `${DOCS}${path}`, fields: { touched: { booleanValue: true } } } };
}

function commit(...writes: Record<string, unknown>[]): Promise<unknown> {
  return db.request("commit", { database: "projects/demo/databases/(default)", writes });
}

function v2Event(document: string, params: Record<string, string>): Record<string, unknown> {
  return { type: "google.cloud.firestore.document.v1.written", document, params, data: {} };
}

async function invokes(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  await flush();
  raw.length = 0;
  findings.length = 0;
  await run();
  await flush();
  return raw.filter((call) => call.service === "functions" && call.op === "invoke");
}

before(() => {
  process.env.FUNCTION_TARGET = "onPost";
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") {
      logged.push(args[1]);
      raw.push(JSON.parse(args[1]) as Record<string, unknown>);
    }
  };
  init({
    apiKey: "rm_test",
    endpoint: "http://127.0.0.1:9",
    hashKey: HASH_KEY,
    bundle: bundleBytes(),
    dev: false,
    debug: true,
    platform: "server",
    onFinding(finding) {
      findings.push(finding);
    },
  });
});

after(async () => {
  console.debug = originalDebug;
  if (previousTarget === undefined) delete process.env.FUNCTION_TARGET;
  else process.env.FUNCTION_TARGET = previousTarget;
  await shutdown();
});

test("a v2 event becomes a pattern with a wildcard at each param id", () => {
  const pattern = triggerPattern([v2Event("users/u1/posts/p1", { uid: "u1", pid: "p1" })]);
  assert.deepEqual(pattern, ["users", null, "posts", null]);
  assert.ok(pattern);
  assert.equal(matchesTrigger(pattern, "users/u2/posts/p9"), true);
  assert.equal(matchesTrigger(pattern, "users/u2/drafts/p9"), false);
  assert.equal(matchesTrigger(pattern, "users/u2"), false);
  assert.equal(matchesTrigger(pattern, "users/u2/posts/p9/comments/c1"), false);
});

test("a literal trigger segment stays literal", () => {
  const pattern = triggerPattern([v2Event("config/main/items/abc", { id: "abc" })]);
  assert.deepEqual(pattern, ["config", "main", "items", null]);
});

test("v1 change and snapshot events use the ref path and context params", () => {
  const change = { before: { ref: { path: "posts/abc" } }, after: { ref: { path: "posts/abc" } } };
  assert.deepEqual(triggerPattern([change, { params: { id: "abc" }, eventType: V1_WRITE }]), ["posts", null]);
  const snapshot = { ref: { path: "posts/abc" } };
  const created = "providers/cloud.firestore/eventTypes/document.create";
  assert.deepEqual(triggerPattern([snapshot, { params: { id: "abc" }, eventType: created }]), ["posts", null]);
  const resource = { name: `${DOCS}posts/abc`, service: "firestore.googleapis.com" };
  assert.deepEqual(triggerPattern([{}, { params: { id: "abc" }, eventType: V1_WRITE, resource }]), ["posts", null]);
});

test("callable, HTTP, and Realtime Database events are not Firestore triggers", () => {
  assert.equal(triggerPattern([{ data: { id: "abc" }, rawRequest: {} }]), undefined);
  assert.equal(triggerPattern([{ method: "POST", body: {} }, { end() {} }]), undefined);
  assert.equal(triggerPattern([]), undefined);
  assert.equal(triggerPattern([null, undefined]), undefined);
  const rtdb = { ref: { path: "posts/abc" } };
  assert.equal(
    triggerPattern([rtdb, { params: { id: "abc" }, eventType: "providers/google.firebase.database/eventTypes/ref.write" }]),
    undefined,
  );
  assert.equal(triggerPattern([{ type: "google.firebase.database.ref.v1.written", document: "posts/abc", params: {} }]), undefined);
  assert.equal(triggerPattern([v2Event("posts", {})]), undefined);
});

test("writes to the trigger's collection are counted; other collections and subcollections are not", async () => {
  const handler = withFlush(async (_event: unknown) => {
    await commit(set("posts/abc"));
    await commit(set("postSummaries/abc"));
    await commit(set("posts/abc/comments/c1"));
    return null;
  });
  const calls = await invokes(() => handler(v2Event("posts/abc", { id: "abc" })));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.trigger_writes, 1);
  const finding = findings.find((item) => item.rule === RULE);
  assert.ok(finding, `missing ${RULE}; have ${findings.map((item) => item.rule).join(", ")}`);
  assert.equal(finding.wasted.invocations, 1);
});

test("batch commits count each matching write and a failed commit counts none", async () => {
  const handler = withFlush(async (_change: unknown, _context: unknown) => {
    await commit(set("posts/def"), set("posts/ghi"), { delete: `${DOCS}posts/old` }, set("audit/a1"));
    failNext = true;
    await commit(set("posts/xyz")).catch(() => undefined);
    return null;
  });
  const change = { before: { ref: { path: "posts/abc" } }, after: { ref: { path: "posts/abc" } } };
  const calls = await invokes(() => handler(change, { params: { id: "abc" }, eventType: V1_WRITE }));
  assert.equal(calls[0]?.trigger_writes, 3);
});

test("a transaction commit counts its matching writes", async () => {
  const handler = withFlush(async (_event: unknown) => {
    await db.request("commit", { transaction: new Uint8Array([1]), writes: [set("posts/abc"), set("counters/posts")] });
    return null;
  });
  const calls = await invokes(() => handler(v2Event("posts/abc", { id: "abc" })));
  assert.equal(calls[0]?.trigger_writes, 1);
});

test("a handler without a trigger event records no trigger_writes", async () => {
  const handler = withFlush(async (_request: unknown) => {
    await commit(set("posts/abc"), set("posts/def"));
    return { ok: true };
  });
  const calls = await invokes(() => handler({ data: { id: "abc" }, rawRequest: {} }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.trigger_writes, undefined);
  assert.equal(findings.some((item) => item.rule === RULE), false);
});

test("a trigger that writes elsewhere records no trigger_writes", async () => {
  const handler = withFlush(async (_event: unknown) => {
    await commit(set("postSummaries/abc"));
    return null;
  });
  const calls = await invokes(() => handler(v2Event("posts/abc", { id: "abc" })));
  assert.equal(calls[0]?.trigger_writes, undefined);
});

test("the invoke record carries only the count, never the trigger pattern or the event path", () => {
  const invokesLogged = logged.filter((json) => json.includes('"op":"invoke"'));
  assert.ok(invokesLogged.length > 0);
  for (const json of invokesLogged) {
    assert.equal(json.includes("posts"), false, json);
    assert.equal(json.includes("abc"), false, json);
  }
});
