/**
 * Query-shape reader against the `@firebase/database` 1.1.5 internal shape.
 * No emulator: the object is a stand-in for `QueryImpl._queryParams`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { childCount, jsonBytes, readPath, readQueryShape } from "../src/web/database-shape.ts";

function params(over: Record<string, unknown> = {}) {
  return {
    isDefault: () => false,
    hasStart: () => false,
    hasEnd: () => false,
    hasLimit: () => false,
    isViewFromLeft: () => true,
    getLimit: () => 0,
    getIndexStartValue: () => undefined,
    getIndexEndValue: () => undefined,
    getIndex: () => ({ toString: () => ".priority" }),
    startAfterSet_: false,
    endBeforeSet_: false,
    ...over,
  };
}

function ref(key: string | null, parent: object | null = null) {
  return { key, parent };
}

test("default query and a changed shape record no constraints", () => {
  assert.equal(readQueryShape({ _queryParams: params({ isDefault: () => true }) }), undefined);
  assert.equal(readQueryShape({ _queryParams: { isDefault: "nope" } }), undefined);
  assert.equal(readQueryShape({ ref: ref("posts") }), undefined);
});

test("order, limitToLast, and equalTo come from query params", () => {
  const query = {
    _queryParams: params({
      hasStart: () => true,
      hasEnd: () => true,
      hasLimit: () => true,
      isViewFromLeft: () => false,
      getLimit: () => 25,
      getIndexStartValue: () => "secret-cursor",
      getIndexEndValue: () => "secret-cursor",
      getIndex: () => ({ toString: () => "created" }),
    }),
    ref: ref("posts", ref(null)),
  };
  assert.deepEqual(readQueryShape(query), {
    order_by: "created",
    limit: 25,
    limit_to_last: true,
    start: "secret-cursor",
    end: "secret-cursor",
    filters: [{ field: "created", op: "==", value: "secret-cursor" }],
  });
  assert.equal(readPath(query), "posts");
});

test("index names and a nested path", () => {
  const keyQuery = { _queryParams: params({ getIndex: () => ({ toString: () => ".key" }) }) };
  assert.equal(readQueryShape(keyQuery)?.order_by, "$key");
  const valueQuery = { _queryParams: params({ getIndex: () => ({ toString: () => ".value" }) }) };
  assert.equal(readQueryShape(valueQuery)?.order_by, "$value");
  const priority = {
    _queryParams: params({
      hasLimit: () => true,
      getLimit: () => 3,
      getIndex: () => ({ toString: () => ".priority" }),
    }),
  };
  assert.equal(readQueryShape(priority)?.order_by, "$priority");
  assert.equal(readQueryShape({ _queryParams: params({ getIndex: () => ({ toString: () => ".nope" }) }) }), undefined);
  const nested = {
    ref: ref("owner", ref("42", ref("posts", ref(null)))),
  };
  assert.equal(readPath(nested), "posts/42/owner");
  assert.equal(readPath({ ref: ref(null) }), "");
});

test("compat delegate and snapshot size", () => {
  const query = {
    _delegate: {
      _queryParams: params({
        hasLimit: () => true,
        isViewFromLeft: () => true,
        getLimit: () => 10,
        getIndex: () => ({ toString: () => "score" }),
      }),
    },
  };
  assert.deepEqual(readQueryShape(query), { order_by: "score", limit: 10, limit_to_last: false });
  assert.equal(childCount({ size: 4 }), 4);
  assert.equal(childCount({ numChildren: () => 7 }), 7);
  assert.equal(jsonBytes(undefined), 0);
  assert.equal(jsonBytes(null), 4);
  assert.equal(jsonBytes({ a: 1 }), 7);
});
