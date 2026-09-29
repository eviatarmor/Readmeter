import assert from "node:assert/strict";
import test from "node:test";

import { recordRaw } from "../src/core/client.ts";
import { flush, init, shutdown, sink, sinkListener, sinkWrite, type InitOptions } from "../src/index.ts";

test("sink stubs return the value the caller keeps using", () => {
  const snap = { size: 3 };
  const ref = { path: "users/a" };
  const listener = (value: unknown) => value;
  assert.equal(sink(ref, snap), snap);
  assert.equal(sinkWrite(ref, "set"), ref);
  assert.equal(sinkListener(ref, listener), listener);
});

test("bad config logs once and never throws", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => {
    lines.push(String(message));
  };
  try {
    assert.doesNotThrow(() => init(undefined as unknown as InitOptions));
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /disabled/);
    assert.doesNotThrow(() => recordRaw({ op: "query" }));
    await flush();
    await shutdown();
  } finally {
    console.error = original;
  }
});

test("an out-of-range sampleRate disables the SDK", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => {
    lines.push(String(message));
  };
  try {
    init({ apiKey: "rm_test", endpoint: "http://127.0.0.1:9", sampleRate: 2 });
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /sampleRate/);
    await shutdown();
  } finally {
    console.error = original;
  }
});
