import assert from "node:assert/strict";
import test from "node:test";

import { documentByteSize, documentNameSize, valueByteSize } from "../src/core/size.ts";

test("string, integer and the documented document example", () => {
  assert.equal(valueByteSize({ stringValue: "a" }), 2);
  assert.equal(valueByteSize({ integerValue: "1" }), 8);
  assert.equal(valueByteSize({ integerValue: 1 }), 8);
  assert.equal(valueByteSize({ doubleValue: 1.5 }), 8);
  assert.equal(valueByteSize({ booleanValue: false }), 1);
  assert.equal(valueByteSize({ nullValue: null }), 1);
  assert.equal(valueByteSize({ timestampValue: "2020-01-01T00:00:00Z" }), 8);
  assert.equal(valueByteSize({ geoPointValue: { latitude: 1, longitude: 2 } }), 16);
  assert.equal(valueByteSize({ bytesValue: "aGk=" }), 2);
  assert.equal(valueByteSize({ vectorValue: { values: [1, 2, 3] } }), 24);

  // users/jeff/tasks/my_task_id from the Firestore storage-size docs: 44 + 71 + 32.
  assert.equal(documentNameSize("users/jeff/tasks/my_task_id"), 44);
  const fields = {
    type: { stringValue: "Personal" },
    done: { booleanValue: false },
    priority: { integerValue: 1 },
    description: { stringValue: "Learn Cloud Firestore" },
  };
  assert.equal(documentByteSize("users/jeff/tasks/my_task_id", fields), 147);

  // path "c/d" is 20, field name "a" is 2, value "a" is 2, plus 32.
  assert.equal(documentByteSize("c/d", { a: { stringValue: "a" } }), 56);
});

test("maps add 32 bytes and arrays sum their values", () => {
  assert.equal(valueByteSize({ mapValue: { fields: { first: { stringValue: "Ada" } } } }), 42);
  const inner = { mapValue: { fields: { a: { stringValue: "a" } } } };
  assert.equal(valueByteSize(inner), 36);
  assert.equal(valueByteSize({ mapValue: { fields: { inner } } }), 74);
  assert.equal(
    valueByteSize({ arrayValue: { values: [{ integerValue: 1 }, { booleanValue: true }] } }),
    9,
  );
  assert.equal(
    valueByteSize({ referenceValue: "projects/p/databases/(default)/documents/users/jeff/tasks/my_task_id" }),
    44,
  );
});

test("unknown shapes and a thrown encoder do not throw", () => {
  assert.equal(valueByteSize(null), 0);
  assert.equal(valueByteSize({}), 0);
  assert.equal(documentByteSize("col/doc", null), documentNameSize("col/doc") + 32);
});
