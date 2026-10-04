import assert from "node:assert/strict";
import { test } from "node:test";

import { bundleEtag, createApp } from "../src/app.ts";
import { burstFor, TokenBucket } from "../src/rate.ts";
import { collapseFindings } from "../src/store.ts";
import { access, batch, core, growingPages, HASH_KEY, MemoryStore, offsetQuery } from "./helpers.ts";

const KEY = "rm_test_key";

const post = (body: Uint8Array<ArrayBuffer> | string, key?: string) =>
  new Request("http://x/v1/batches", {
    method: "POST",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body,
  });

test("accepts and stores a batch with SDK and evaluator findings", async () => {
  const store = new MemoryStore({ [KEY]: access("proj_a") });
  const app = createApp({ core: await core(), store });
  const calls = [offsetQuery(1), ...growingPages.map((c) => ({ ...c, ts_ms: c.ts_ms + 10 }))];
  const res = await app.request(post(batch(calls), KEY));
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.deepEqual(body, { events: 4, findings: 1, evaluator_findings: 1, dropped_events: 0 });

  const [write] = store.writes;
  assert.ok(write);
  assert.equal(write.project, "proj_a");
  const rules = write.ingested.findings.map((f) => `${f.source}:${f.rule}`);
  assert.deepEqual(rules, [
    "sdk:firebase.firestore/offset-pagination",
    "evaluator:firebase.firestore/missing-cursor",
  ]);
  assert.match(write.ingested.events[0]!.target_key, /^[0-9a-f]{16}$/);
});

test("session ids beyond 2^53 survive as hex", async () => {
  const store = new MemoryStore({ [KEY]: access("proj_a") });
  const app = createApp({ core: await core(), store });
  await app.request(post(batch([offsetQuery(1)], "18446744073709551615"), KEY));
  assert.equal(store.writes[0]?.ingested.batch.session, "ffffffffffffffff");
});

test("rejects bad auth, garbage and oversized batches", async () => {
  const store = new MemoryStore({ [KEY]: access("proj_a") });
  const app = createApp({ core: await core({ maxEvents: 2 }), store });
  const ok = batch([offsetQuery(1)]);

  assert.equal((await app.request(post(ok))).status, 401);
  assert.equal((await app.request(post(ok, "wrong"))).status, 401);

  const garbage = await app.request(post("garbage", KEY));
  assert.equal(garbage.status, 400);
  assert.equal((await garbage.json()).error, "bad_batch");

  const many = await app.request(post(batch([1, 2, 3].map(offsetQuery)), KEY));
  assert.equal(many.status, 413);
  assert.equal((await many.json()).error, "batch_too_large");

  const small = createApp({ core: await core(), store, limits: { maxBodyBytes: 16 } });
  assert.equal((await small.request(post(new Uint8Array(1024), KEY))).status, 413);
  assert.equal(store.writes.length, 0);
});

test("answers 503 with Retry-After when writes back up", async () => {
  let release!: () => void;
  const store = new MemoryStore({ [KEY]: access("p") }, new Promise((r) => (release = r)));
  const app = createApp({ core: await core(), store, limits: { maxInflight: 1 } });
  const first = app.request(post(batch([offsetQuery(1)]), KEY));
  await new Promise((r) => setTimeout(r, 10));
  const second = await app.request(post(batch([offsetQuery(2)]), KEY));
  assert.equal(second.status, 503);
  assert.equal(second.headers.get("retry-after"), "5");
  release();
  assert.equal((await first).status, 202);
});

test("healthz", async () => {
  const app = createApp({ core: await core(), store: new MemoryStore({}) });
  assert.equal((await app.request("/healthz")).status, 200);
});

test("preflight reflects any origin and does not require a key", async () => {
  const app = createApp({ core: await core(), store: new MemoryStore({}) });
  const res = await app.request(
    new Request("http://x/v1/batches", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    }),
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5173");
  const methods = res.headers.get("access-control-allow-methods") ?? "";
  for (const method of ["POST", "GET", "OPTIONS"]) assert.ok(methods.includes(method), methods);
  const headers = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  assert.ok(headers.includes("authorization"), headers);
  assert.ok(headers.includes("content-type"), headers);
  assert.equal(res.headers.get("access-control-max-age"), "600");
  assert.match(res.headers.get("vary") ?? "", /Origin/);
});

test("origin allowlist allows a match and a missing Origin, denies others", async () => {
  const store = new MemoryStore({
    [KEY]: access("proj_a", ["http://ok.test"]),
  });
  const app = createApp({ core: await core(), store });
  const send = (origin?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEY}` };
    if (origin) headers.origin = origin;
    return app.request(
      new Request("http://x/v1/batches", { method: "POST", headers, body: batch([offsetQuery(1)]) }),
    );
  };

  const denied = await send("http://evil.test");
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "origin_not_allowed");
  assert.equal(denied.headers.get("access-control-allow-origin"), "http://evil.test");

  const allowed = await send("http://ok.test");
  assert.equal(allowed.status, 202);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://ok.test");
  assert.match(allowed.headers.get("vary") ?? "", /Origin/);

  assert.equal((await send()).status, 202);
  assert.equal(store.writes.length, 2);
});

test("an empty origin list allows every Origin", async () => {
  const app = createApp({ core: await core(), store: new MemoryStore({ [KEY]: access("proj_a") }) });
  const res = await app.request(
    new Request("http://x/v1/batches", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, origin: "https://anywhere.example" },
      body: batch([offsetQuery(1)]),
    }),
  );
  assert.equal(res.status, 202);
});

test("accepts beacon bodies with octet-stream or no content type", async () => {
  const store = new MemoryStore({ [KEY]: access("proj_a") });
  const app = createApp({ core: await core(), store });
  const bytes = batch([offsetQuery(1)]);
  const octet = await app.request(
    new Request("http://x/v1/batches", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/octet-stream" },
      body: bytes,
    }),
  );
  assert.equal(octet.status, 202);
  const bare = new Request("http://x/v1/batches", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}` },
    body: batch([offsetQuery(2)]),
  });
  assert.equal(bare.headers.get("content-type"), null);
  assert.equal((await app.request(bare)).status, 202);
  assert.equal(store.writes.length, 2);
});

test("answers 429 with Retry-After when the project bucket is empty", async () => {
  const store = new MemoryStore({ [KEY]: access("proj_a") });
  const app = createApp({
    core: await core(),
    store,
    limits: { ratePerMin: 1, rateBurst: 1 },
  });
  assert.equal((await app.request(post(batch([offsetQuery(1)]), KEY))).status, 202);
  const limited = await app.request(post(batch([offsetQuery(2)]), KEY));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "rate_limited");
  const retry = Number(limited.headers.get("retry-after"));
  assert.ok(retry >= 1, `retry-after ${retry}`);
  assert.equal(store.writes.length, 1);
});

test("all keys of a project share one bucket; other projects are separate", async () => {
  const store = new MemoryStore({
    k1: access("proj_a"),
    k2: access("proj_a"),
    k3: access("proj_b"),
  });
  const app = createApp({ core: await core(), store, limits: { ratePerMin: 1, rateBurst: 1 } });
  assert.equal((await app.request(post(batch([offsetQuery(1)]), "k1"))).status, 202);
  const shared = await app.request(post(batch([offsetQuery(2)]), "k2"));
  assert.equal(shared.status, 429);
  assert.equal((await shared.json()).error, "rate_limited");
  assert.equal((await app.request(post(batch([offsetQuery(3)]), "k3"))).status, 202);
});

test("a project's own rate_per_min replaces the default, with a proportional burst", async () => {
  const store = new MemoryStore({ fast: access("proj_fast", [], HASH_KEY, 12), slow: access("proj_slow") });
  // Default 6/min with burst 1; 12/min gets burst ceil(12 * 1 / 6) = 2.
  const app = createApp({ core: await core(), store, limits: { ratePerMin: 6, rateBurst: 1 } });
  const send = async (key: string) => (await app.request(post(batch([offsetQuery(1)]), key))).status;
  assert.deepEqual([await send("fast"), await send("fast"), await send("fast")], [202, 202, 429]);
  assert.deepEqual([await send("slow"), await send("slow")], [202, 429]);
});

test("burst scales with the per-minute rate", () => {
  const base = { ratePerMin: 600, rateBurst: 100 };
  assert.equal(burstFor(600, base), 100);
  assert.equal(burstFor(60, base), 10);
  assert.equal(burstFor(120, base), 20);
  assert.equal(burstFor(1, base), 1);
});

const browser = (opts: { ip: string; origin?: string; forwardedFor?: string; key?: string }) => {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? KEY}` };
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.forwardedFor !== undefined) headers["x-forwarded-for"] = opts.forwardedFor;
  return [
    new Request("http://x/v1/batches", { method: "POST", headers, body: batch([offsetQuery(1)]) }),
    undefined,
    { incoming: { socket: { remoteAddress: opts.ip } } },
  ] as const;
};

test("limits browser requests per client IP", async () => {
  const store = new MemoryStore({ [KEY]: access("proj_a") });
  // Per-IP 1/min: burst ceil(1 * 100 / 600) = 1. The project limit stays high.
  const app = createApp({ core: await core(), store, limits: { ratePerIpPerMin: 1 } });
  const origin = "https://app.example";
  assert.equal((await app.request(...browser({ ip: "10.0.0.1", origin }))).status, 202);
  const limited = await app.request(...browser({ ip: "10.0.0.1", origin }));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal((await app.request(...browser({ ip: "10.0.0.2", origin }))).status, 202);
  // No Origin: a server caller, only the project limit applies.
  assert.equal((await app.request(...browser({ ip: "10.0.0.1" }))).status, 202);
  // Limited before the key lookup.
  assert.equal((await app.request(...browser({ ip: "10.0.0.1", origin, key: "bad" }))).status, 429);
  assert.equal(store.writes.length, 3);

  const off = createApp({ core: await core(), store, limits: { ratePerIpPerMin: 0 } });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await off.request(...browser({ ip: "10.0.0.9", origin }))).status, 202);
  }
});

test("X-Forwarded-For is ignored unless trustProxy is on", async () => {
  const origin = "https://app.example";
  const store = new MemoryStore({ [KEY]: access("proj_a") });
  const direct = createApp({ core: await core(), store, limits: { ratePerIpPerMin: 1 } });
  assert.equal((await direct.request(...browser({ ip: "10.0.0.1", origin, forwardedFor: "1.1.1.1" }))).status, 202);
  assert.equal((await direct.request(...browser({ ip: "10.0.0.1", origin, forwardedFor: "2.2.2.2" }))).status, 429);

  const proxied = createApp({ core: await core(), store, limits: { ratePerIpPerMin: 1, trustProxy: true } });
  const viaProxy = (forwardedFor: string) =>
    Promise.resolve(proxied.request(...browser({ ip: "10.0.0.1", origin, forwardedFor }))).then((r) => r.status);
  assert.equal(await viaProxy("1.1.1.1"), 202);
  assert.equal(await viaProxy("2.2.2.2"), 202);
  // The last entry is the one the proxy appended; a client-sent first entry does not matter.
  assert.equal(await viaProxy("9.9.9.9, 1.1.1.1"), 429);
  // Without the header the socket address is used.
  assert.equal((await proxied.request(...browser({ ip: "10.0.0.7", origin }))).status, 202);
});

test("token bucket evicts the least recently used key", () => {
  const bucket = new TokenBucket(60, 1, 2);
  assert.equal(bucket.take("a", 0), null);
  assert.equal(bucket.take("b", 0), null);
  assert.equal(bucket.take("a", 0), 1);
  assert.equal(bucket.take("c", 0), null);
  assert.equal(bucket.size, 2);
  // b was least recently used and is gone; a kept its empty bucket.
  assert.equal(bucket.take("a", 0), 1);
  assert.equal(bucket.take("b", 0), null);
});

test("token bucket waits at least one second and refills", () => {
  const bucket = new TokenBucket(60, 1);
  assert.equal(bucket.take("k", 1_000), null);
  assert.equal(bucket.take("k", 1_000), 1);
  assert.equal(bucket.take("k", 2_000), null);
});

test("bundle etag is the first 16 hex chars of sha256", () => {
  assert.equal(bundleEtag(new TextEncoder().encode("abc")), "ba7816bf8f01cfea");
});

test("GET /v1/bundle returns bytes, etag, and 304", async () => {
  const body = new Uint8Array([1, 2, 3, 4]);
  const etag = bundleEtag(body);
  const store = new MemoryStore({ [KEY]: access("proj_a", ["http://ok.test"]) });
  const app = createApp({ core: await core(), store, bundle: { body, etag } });
  const headers = { authorization: `Bearer ${KEY}`, origin: "http://ok.test" };

  const denied = await app.request(new Request("http://x/v1/bundle", { headers: { ...headers, origin: "http://no.test" } }));
  assert.equal(denied.status, 403);

  const res = await app.request(new Request("http://x/v1/bundle", { headers }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.equal(res.headers.get("etag"), etag);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://ok.test");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), body);

  const cached = await app.request(
    new Request("http://x/v1/bundle", { headers: { ...headers, "if-none-match": `"${etag}"` } }),
  );
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get("etag"), etag);
  assert.equal(await cached.text(), "");
});

test("GET /v1/config returns the project id and hash key", async () => {
  const app = createApp({
    core: await core(),
    store: new MemoryStore({ [KEY]: access("proj_a", ["http://ok.test"]) }),
  });
  const ok = await app.request(
    new Request("http://x/v1/config", {
      headers: { authorization: `Bearer ${KEY}`, origin: "http://ok.test" },
    }),
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { project: "proj_a", hash_key: HASH_KEY });

  const noOrigin = await app.request(
    new Request("http://x/v1/config", { headers: { authorization: `Bearer ${KEY}` } }),
  );
  assert.equal(noOrigin.status, 200);

  const denied = await app.request(
    new Request("http://x/v1/config", {
      headers: { authorization: `Bearer ${KEY}`, origin: "http://no.test" },
    }),
  );
  assert.equal(denied.status, 403);
  assert.equal((await app.request(new Request("http://x/v1/config"))).status, 401);
});

test("project overrides disable and retune backend rules", async () => {
  const missing = (store: MemoryStore) =>
    store.writes.flatMap((w) => w.ingested.findings).filter((f) => f.rule === "firebase.firestore/missing-cursor");

  const disabled = new MemoryStore({ [KEY]: access("proj_a") });
  disabled.overrides = [
    {
      rule: "firebase.firestore/missing-cursor",
      enabled: false,
      severity: null,
      params: null,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  ];
  const off = await createApp({ core: await core(), store: disabled }).request(post(batch(growingPages), KEY));
  assert.equal(off.status, 202);
  assert.equal(missing(disabled).length, 0);

  const raised = new MemoryStore({ [KEY]: access("proj_a") });
  raised.overrides = [
    {
      rule: "firebase.firestore/missing-cursor",
      enabled: null,
      severity: null,
      params: { min_pages: 10 },
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    },
  ];
  const tuned = await createApp({ core: await core(), store: raised }).request(post(batch(growingPages), KEY));
  assert.equal(tuned.status, 202);
  assert.equal(missing(raised).length, 0);

  const lowered = new MemoryStore({ [KEY]: access("proj_a") });
  lowered.overrides = [
    {
      rule: "firebase.firestore/missing-cursor",
      enabled: null,
      severity: "low",
      params: null,
      updatedAt: new Date("2026-01-03T00:00:00Z"),
    },
  ];
  const sev = await createApp({ core: await core(), store: lowered }).request(post(batch(growingPages), KEY));
  assert.equal(sev.status, 202);
  assert.equal(missing(lowered).length, 1);
  assert.equal(missing(lowered)[0]?.severity, "low");
});

test("collapseFindings merges repeats of one dedupe key", () => {
  const f = (ts_ms: number, callsite: string | null, message = "m") => ({
    rule: "r",
    severity: "high" as const,
    source: "sdk" as const,
    ts_ms,
    provider: "p",
    service: "s",
    template: "t",
    session: "s1",
    callsite,
    callsite_label: null,
    message,
    evidence: {},
    wasted: {},
  });
  const out = collapseFindings([f(5, null), f(9, null, "last"), f(1, null), f(3, "c")]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    { first: out[0]!.first, last: out[0]!.last, count: out[0]!.count, msg: out[0]!.row.message },
    { first: 1, last: 9, count: 3, msg: "last" },
  );
});
