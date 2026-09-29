import assert from "node:assert/strict";
import test from "node:test";

import { Transport, retryAfterMs, type Scheduler, type Timer } from "../src/core/transport.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("retryAfterMs reads delay-seconds and HTTP dates", () => {
  assert.equal(retryAfterMs("2"), 2000);
  assert.equal(retryAfterMs("0"), 0);
  assert.equal(retryAfterMs("nope"), undefined);
  assert.equal(retryAfterMs(null), undefined);
  const now = Date.parse("2026-09-29T00:00:00Z");
  assert.equal(retryAfterMs("Tue, 29 Sep 2026 00:00:03 GMT", now), 3000);
});

test("503 with Retry-After waits before the next post", async () => {
  const delays: number[] = [];
  const timers: Array<() => void> = [];
  let posts = 0;
  const second = deferred();
  const scheduler: Scheduler = {
    delay(fn, ms): Timer {
      delays.push(ms);
      timers.push(fn);
      return { cancel() {} };
    },
    interval(): Timer {
      return { cancel() {} };
    },
  };
  let batch: Uint8Array | undefined = new Uint8Array([1, 2, 3]);
  const transport = new Transport({
    endpoint: "http://ingest",
    apiKey: "rm_test",
    flushIntervalMs: 10_000,
    maxBatchEvents: 200,
    exitHooks: false,
    scheduler,
    takeBatch: () => {
      const next = batch;
      batch = undefined;
      return next;
    },
    fetchFn: async (url, init) => {
      posts += 1;
      assert.equal(url, "http://ingest/v1/batches");
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.authorization, "Bearer rm_test");
      assert.equal(headers["content-type"], "application/octet-stream");
      if (posts === 1) {
        return new Response("busy", { status: 503, headers: { "retry-after": "2" } });
      }
      second.resolve();
      return new Response("ok", { status: 202 });
    },
  });

  await transport.flush();
  assert.equal(posts, 1);
  assert.equal(transport.pendingCount, 1);
  assert.deepEqual(delays, [2000]);

  timers[0]?.();
  await second.promise;
  // The retry flush shifts the batch in a microtask queued after this await.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(posts, 2);
  assert.equal(transport.pendingCount, 0);
});

test("flush resolves when fetch rejects and keeps the batch", async () => {
  const delays: number[] = [];
  const transport = new Transport({
    endpoint: "http://ingest",
    apiKey: "rm_test",
    flushIntervalMs: 10_000,
    maxBatchEvents: 200,
    exitHooks: false,
    scheduler: {
      delay(_fn, ms) {
        delays.push(ms);
        return { cancel() {} };
      },
      interval: () => ({ cancel() {} }),
    },
    takeBatch: () => new Uint8Array([9]),
    fetchFn: async () => {
      throw new Error("network down");
    },
  });
  await transport.flush();
  assert.equal(transport.pendingCount, 1);
  assert.deepEqual(delays, [1000]);
});

test("keepalive is set on the request", async () => {
  let keepalive: boolean | undefined;
  const transport = new Transport({
    endpoint: "http://ingest/",
    apiKey: "k",
    flushIntervalMs: 10_000,
    maxBatchEvents: 200,
    exitHooks: false,
    scheduler: { delay: () => ({ cancel() {} }), interval: () => ({ cancel() {} }) },
    takeBatch: () => new Uint8Array([1]),
    fetchFn: async (_url, init) => {
      keepalive = init.keepalive;
      return new Response("ok", { status: 202 });
    },
  });
  await transport.flush({ keepalive: true });
  assert.equal(keepalive, true);
});
