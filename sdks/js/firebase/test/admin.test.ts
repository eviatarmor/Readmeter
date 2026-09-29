/**
 * Admin shape mapping and withFlush. No emulator.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { instrument, withFlush } from "../src/admin/index.ts";
import { classifyCommit, readStructuredQuery } from "../src/admin/proto.ts";

test("admin operators, offset, and the listen document-id order", () => {
  const request = {
    parent: "projects/p/databases/d/documents",
    structuredQuery: {
      from: [{ collectionId: "posts" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "open" } } },
            { fieldFilter: { field: { fieldPath: "n" }, op: "GREATER_THAN", value: { integerValue: "3" } } },
            { unaryFilter: { field: { fieldPath: "gone" }, op: "IS_NULL" } },
            { fieldFilter: { field: { fieldPath: "score" }, op: "IS_NAN", value: { doubleValue: "NaN" } } },
          ],
        },
      },
      orderBy: [
        { field: { fieldPath: "createdAt" }, direction: "DESCENDING" },
        { field: { fieldPath: "__name__" }, direction: "DESCENDING" },
      ],
      limit: { value: 20 },
      offset: 200,
    },
  };
  const kept = readStructuredQuery(request);
  assert.equal(kept.warn, undefined);
  assert.deepEqual(kept.target, {
    path: "posts",
    query: {
      filters: [
        { field: "status", op: "==", value: "open" },
        { field: "n", op: ">", value: 3 },
        { field: "gone", op: "==", value: null },
        { field: "score", op: "==", value: "NaN" },
      ],
      order_by: [
        { field: "createdAt", direction: "desc" },
        { field: "__name__", direction: "desc" },
      ],
      limit: 20,
      offset: 200,
    },
  });
  const listen = readStructuredQuery(request, true);
  assert.deepEqual(listen.target?.query?.order_by, [{ field: "createdAt", direction: "desc" }]);
});

test("a collection get with no constraints keeps an empty query", () => {
  const read = readStructuredQuery({
    parent: "projects/p/databases/d/documents",
    structuredQuery: { from: [{ collectionId: "posts" }] },
  });
  assert.equal(read.warn, undefined);
  assert.deepEqual(read.target?.query, {});
});

test("a transaction stays commit, including a single update", () => {
  const update = {
    update: { name: "projects/p/databases/d/documents/accounts/acc_1" },
    updateMask: { fieldPaths: ["balance"] },
  };
  assert.deepEqual(classifyCommit({ writes: [update], transaction: new Uint8Array([1]) }), {
    op: "commit",
    path: "accounts/acc_1",
    commit: { writes: 1, deletes: 0, transactional: true },
  });
  assert.deepEqual(classifyCommit({ writes: [update] }), { op: "update", path: "accounts/acc_1" });
  assert.deepEqual(
    classifyCommit({
      writes: [
        { update: { name: "projects/p/databases/d/documents/audit/a1" } },
        { update: { name: "projects/p/databases/d/documents/audit/a2" } },
        { delete: "projects/p/databases/d/documents/audit/gone" },
      ],
    }),
    {
      op: "commit",
      path: "audit",
      commit: { writes: 2, deletes: 1, transactional: false },
    },
  );
});

test("withFlush rethrows the handler error after flush", async () => {
  const err = new Error("handler");
  const wrapped = withFlush(async () => {
    throw err;
  });
  await assert.rejects(wrapped(), (caught) => caught === err);
});

test("instrument returns the same instance and does not throw", () => {
  assert.equal(instrument(undefined), undefined);
  const db = {
    request() {
      return Promise.resolve({});
    },
    requestStream() {
      return Promise.resolve({});
    },
  };
  assert.equal(instrument(db), db);
  assert.equal(instrument(db), db);
});
