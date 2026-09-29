import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callsite, callsiteFromStack } from "../src/core/callsite.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function frame(file: string, line: number, col: number): string {
  return `    at fn (${file}:${line}:${col})`;
}

test("skips this package and node_modules", () => {
  const stack = [
    "Error",
    frame(path.join(root, "src", "core", "client.ts"), 10, 5),
    frame(path.join(root, "node_modules", "firebase", "index.js"), 3, 1),
    frame(path.join(root, "test", "callsite.test.ts"), 14, 9),
  ].join("\n");
  const got = callsiteFromStack(stack);
  assert.equal(got, `${path.join(root, "test", "callsite.test.ts")}:14:9`);
});

test("reads firefox frames and file urls", () => {
  const stack = ["user@http://localhost:5173/node_modules/firebase/index.js:1:1", "user@http://localhost:5173/src/Orders.tsx:14:9"].join("\n");
  assert.equal(callsiteFromStack(stack), "http://localhost:5173/src/Orders.tsx:14:9");
});

test("returns undefined when every frame is internal", () => {
  const stack = frame(path.join(root, "src", "index.ts"), 1, 1);
  assert.equal(callsiteFromStack(stack), undefined);
  assert.equal(callsiteFromStack(undefined), undefined);
});

test("live stack points at this test file", () => {
  const got = callsite();
  assert.ok(got, "expected a callsite");
  assert.match(got, /callsite\.test\.ts:\d+:\d+$/);
  assert.equal(got.includes("node_modules"), false);
});
