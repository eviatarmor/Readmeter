import assert from "node:assert/strict";
import test from "node:test";

import { CoreClient, QUEUE_CAP, handoff, recordRaw } from "../src/core/client.ts";
import type { WasmHandle } from "../src/core/wasm.ts";

function fakeHandle(): WasmHandle & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    record(raw: string): string {
      calls.push(raw);
      return "[]";
    },
    flush(): Uint8Array | undefined {
      return undefined;
    },
    activeRules(): string[] {
      return [];
    },
    free(): void {},
  };
}

test("queue drops the oldest call past 1000", () => {
  const client = new CoreClient();
  for (let i = 0; i < QUEUE_CAP + 1; i++) client.record({ n: i });
  assert.equal(client.depth, QUEUE_CAP);
  const handle = fakeHandle();
  assert.equal(client.attach(handle), QUEUE_CAP);
  assert.equal(handle.calls.length, QUEUE_CAP);
  assert.equal(JSON.parse(handle.calls[0] ?? "{}").n, 1);
  assert.equal(JSON.parse(handle.calls[QUEUE_CAP - 1] ?? "{}").n, QUEUE_CAP);
});

test("handoff keeps calls that have not reached wasm", () => {
  const first = new CoreClient();
  first.record({ n: 1 });
  const queued = first.takeQueue();
  const second = new CoreClient();
  second.restore(queued);
  const handle = fakeHandle();
  second.attach(handle);
  assert.deepEqual(handle.calls, [JSON.stringify({ n: 1 })]);
});

test("handoff moves the singleton queue onto the new client", () => {
  recordRaw({ n: 4 });
  const next = new CoreClient();
  const previous = handoff(next, () => {});
  const handle = fakeHandle();
  assert.equal(next.attach(handle), 1);
  assert.equal(JSON.parse(handle.calls[0] ?? "{}").n, 4);
  previous.free();
  handoff(new CoreClient(), () => {});
});

test("a disabled client drops calls and does not throw", () => {
  const client = new CoreClient();
  client.record({ n: 1 });
  client.disable();
  assert.equal(client.depth, 0);
  const result = client.record({ n: 2 });
  assert.deepEqual(result, { findings: [], wrote: false });
  const handle = fakeHandle();
  assert.equal(client.attach(handle), 0);
  assert.equal(handle.calls.length, 0);
});

test("dev mode warns and reports findings from a fake core", () => {
  const seen: string[] = [];
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const client = new CoreClient({
      dev: true,
      onFinding: (finding) => seen.push(finding.rule),
    });
    const handle: WasmHandle = {
      record(): string {
        return JSON.stringify([
          { rule: "firebase.firestore/unbounded-list", severity: "critical", template: "orders", message: "no limit", wasted: { reads: 10 } },
        ]);
      },
      flush: () => undefined,
      activeRules: () => [],
      free: () => {},
    };
    client.attach(handle);
    const result = client.record({ op: "query" });
    assert.equal(result.wrote, true);
    assert.equal(result.findings[0]?.rule, "firebase.firestore/unbounded-list");
    assert.deepEqual(seen, ["firebase.firestore/unbounded-list"]);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = original;
  }
});
