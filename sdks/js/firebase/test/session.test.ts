import assert from "node:assert/strict";
import test from "node:test";

import { newSessionId, nextCallId, nextListenerId, nextTransactionId, resetIds } from "../src/core/session.ts";

test("session id is a decimal u64", () => {
  const id = newSessionId();
  assert.match(id, /^[0-9]+$/);
  const n = BigInt(id);
  assert.ok(n >= 0n);
  assert.ok(n <= 0xffffffffffffffffn);
  assert.notEqual(id, newSessionId());
});

test("call and listener ids increment and reset independently", () => {
  resetIds();
  assert.equal(nextCallId(), 1);
  assert.equal(nextCallId(), 2);
  assert.equal(nextListenerId(), 1);
  assert.equal(nextListenerId(), 2);
  resetIds();
  assert.equal(nextCallId(), 1);
  assert.equal(nextListenerId(), 1);
  assert.equal(nextTransactionId(), 1);
  assert.equal(nextTransactionId(), 2);
  resetIds();
  assert.equal(nextTransactionId(), 1);
});
