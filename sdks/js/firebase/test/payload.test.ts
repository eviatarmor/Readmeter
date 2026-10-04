import assert from "node:assert/strict";
import test from "node:test";
import { arrayRemove, arrayUnion, deleteField, increment, serverTimestamp } from "firebase/firestore";

import { splitFieldPath, writeSignal } from "../src/core/payload.ts";
import { resetIds } from "../src/core/session.ts";
import { jsValueByteSize } from "../src/core/size.ts";
import { installDocumentUsage, installUsage } from "../src/web/usage.ts";

test("js value sizes follow the storage-size example", () => {
  const fields = {
    type: "Personal",
    done: false,
    priority: 1,
    description: "Learn Cloud Firestore",
  };
  // Field sum is 71. A map adds 32, which a top-level write payload does not.
  assert.equal(jsValueByteSize(fields), 103);
  const signal = writeSignal("set", fields);
  assert.ok(signal);
  assert.equal(signal.max_field_bytes, 34);
  assert.equal(signal.payload_bytes, 71);
  assert.deepEqual(signal.transforms, []);
  assert.match(signal.digest ?? "", /^[0-9a-f]{16}$/);
});

test("transforms are named and suppress the digest", () => {
  const signal = writeSignal("set", {
    n: increment(1),
    tags: arrayUnion("a"),
    gone: arrayRemove("b"),
    at: serverTimestamp(),
    drop: deleteField(),
    nested: { cap: { _methodName: "maximum" }, floor: { _methodName: "minimum" } },
  });
  assert.ok(signal);
  assert.deepEqual(signal.transforms, [
    "array_remove",
    "array_union",
    "delete_field",
    "increment",
    "maximum",
    "minimum",
    "server_timestamp",
  ]);
  assert.equal(signal.digest, undefined);
  assert.equal(writeSignal("set", { n: increment(1) })?.max_field_bytes, 2);
});

test("digest is stable in a session and changes after reset", () => {
  resetIds();
  const a = writeSignal("set", { b: 1, a: "x" });
  const b = writeSignal("set", { a: "x", b: 1 });
  assert.equal(a?.digest, b?.digest);
  const merged = writeSignal("set", { a: "x", b: 1 }, { merge: true });
  assert.notEqual(merged?.digest, a?.digest);
  resetIds();
  const c = writeSignal("set", { b: 1, a: "x" });
  assert.notEqual(c?.digest, a?.digest);
});

test("dotted update paths nest under the first segment", () => {
  assert.deepEqual(splitFieldPath("a.b.c"), ["a", "b", "c"]);
  assert.deepEqual(splitFieldPath("`a.b`.c"), ["a.b", "c"]);
  const signal = writeSignal("update", [{ "profile.name": "Ada" }]);
  assert.ok(signal);
  // "profile" (8) + map 32 + "name" (5) + "Ada" (4) = 49.
  assert.equal(signal.payload_bytes, 49);
  assert.equal(signal.max_field_bytes, 49);
});

test("items_used counts docs read through docs and forEach", () => {
  class Doc {
    data(): number {
      return 1;
    }
    get(): number {
      return 1;
    }
  }
  function snap(): { docs: Doc[]; forEach(cb: (doc: Doc, index: number) => void): void } {
    const docs = [new Doc(), new Doc(), new Doc()];
    return {
      get docs() {
        return docs;
      },
      forEach(cb) {
        docs.forEach((doc, index) => cb(doc, index));
      },
    };
  }
  const viaDocs = snap();
  const docsFlags = installUsage(viaDocs);
  assert.equal(viaDocs.docs[0]?.data(), 1);
  assert.equal(viaDocs.docs[2]?.get(), 1);
  assert.equal(docsFlags?.items_used, 2);
  assert.equal(docsFlags?.read_items, true);

  const viaEach = snap();
  const eachFlags = installUsage(viaEach);
  const seen: number[] = [];
  viaEach.forEach((doc, index) => {
    if (index === 1) doc.data();
    seen.push(index);
  });
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal(eachFlags?.items_used, 1);
});

test("getDoc usage sets items_used when data or get is called", () => {
  class Snap {
    data(): { n: number } {
      return { n: 1 };
    }
    get(field: string): number {
      return field.length;
    }
    exists(): boolean {
      return true;
    }
  }
  const idle = new Snap();
  const idleFlags = installDocumentUsage(idle);
  assert.equal(idle.exists(), true);
  assert.equal(idleFlags?.read_items, true);
  assert.equal(idleFlags?.items_used, 0);

  const read = new Snap();
  const flags = installDocumentUsage(read);
  assert.deepEqual(read.data(), { n: 1 });
  assert.equal(flags?.items_used, 1);
  assert.equal(read.get("n"), 1);
  // Single-document snapshots do not track fields.
  assert.equal(flags?.fields_read, undefined);
});

function fieldSnap(rows: Array<Record<string, unknown>>, make?: (row: Record<string, unknown>) => unknown) {
  class Doc {
    constructor(private readonly row: Record<string, unknown>) {}
    data(): unknown {
      return make ? make(this.row) : { ...this.row };
    }
    get(field: unknown): unknown {
      return typeof field === "string" ? this.row[field.split(".")[0] ?? ""] : undefined;
    }
  }
  const docs = rows.map((row) => new Doc(row));
  return {
    get docs() {
      return docs;
    },
    forEach(cb: (doc: Doc) => void) {
      docs.forEach((doc) => cb(doc));
    },
  };
}

test("fields_read counts one numeric field summed through data()", () => {
  const snap = fieldSnap([
    { amount: 2, status: "open" },
    { amount: 3, status: "open" },
  ]);
  const flags = installUsage(snap);
  assert.deepEqual(flags && [flags.fields_read, flags.fields_numeric], [0, false]);
  let total = 0;
  snap.forEach((doc) => {
    total += (doc.data() as { amount: number }).amount;
  });
  assert.equal(total, 5);
  assert.equal(flags?.items_used, 2);
  assert.equal(flags?.fields_read, 1);
  assert.equal(flags?.fields_numeric, true);
});

test("fields_read sees get() paths, spreads and non-numeric values", () => {
  const rows = [{ amount: 2, status: "open", meta: { n: 1 } }];

  const viaGet = fieldSnap(rows);
  const getFlags = installUsage(viaGet);
  assert.equal(viaGet.docs[0]?.get("amount"), 2);
  assert.equal(viaGet.docs[0]?.get("meta.n"), rows[0]?.meta);
  // `meta.n` counts as `meta`; the value returned here is an object.
  assert.equal(getFlags?.fields_read, 2);
  assert.equal(getFlags?.fields_numeric, false);

  const viaPath = fieldSnap(rows);
  const pathFlags = installUsage(viaPath);
  viaPath.docs[0]?.get({ segments: ["amount"] });
  assert.equal(pathFlags?.fields_read, 0);
  assert.equal(pathFlags?.fields_numeric, false);

  const spread = fieldSnap(rows);
  const spreadFlags = installUsage(spread);
  const copy = { ...(spread.docs[0]?.data() as object) };
  assert.deepEqual(copy, rows[0]);
  assert.equal(spreadFlags?.fields_read, 3);
  assert.equal(spreadFlags?.fields_numeric, false);

  const text = fieldSnap([{ status: "open" }]);
  const textFlags = installUsage(text);
  assert.equal((text.docs[0]?.data() as { status: string }).status, "open");
  assert.equal(textFlags?.fields_read, 1);
  assert.equal(textFlags?.fields_numeric, false);
});

test("instrumented data() objects behave like plain objects", () => {
  const snap = fieldSnap([{ amount: 2, status: "open" }]);
  installUsage(snap);
  const data = snap.docs[0]?.data() as Record<string, unknown>;
  assert.deepEqual(Object.keys(data), ["amount", "status"]);
  assert.deepEqual(structuredClone(data), { amount: 2, status: "open" });
  assert.equal(JSON.stringify(data), '{"amount":2,"status":"open"}');
  data.amount = 7;
  assert.equal(data.amount, 7);
  const desc = Object.getOwnPropertyDescriptor(data, "amount");
  assert.equal(desc?.value, 7);
  assert.equal(desc?.writable, true);
  assert.equal(desc?.enumerable, true);
  delete data.status;
  assert.deepEqual(structuredClone(data), { amount: 7 });
  data.extra = 1;
  assert.deepEqual(Object.keys(data), ["amount", "extra"]);
});

test("odd data() results are left alone and never throw", () => {
  class Order {
    amount = 1;
  }
  const odd: Array<() => unknown> = [
    () => Object.freeze({ amount: 1 }),
    () => Object.seal({ amount: 1 }),
    () => new Order(),
    () => [1, 2],
    () => undefined,
    () => 5,
    () => Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, i])),
    () => Object.defineProperty({ amount: 1 }, "fixed", { value: 2, enumerable: true, configurable: false }),
  ];
  for (const make of odd) {
    const snap = fieldSnap([{}], () => make());
    const flags = installUsage(snap);
    const data = snap.docs[0]?.data() as Record<string, unknown> | undefined;
    if (data && typeof data === "object") void JSON.stringify(data);
    assert.equal(flags?.fields_numeric, false);
  }
  const nullProto = fieldSnap([{}], () => Object.assign(Object.create(null) as object, { amount: 4 }));
  const nullFlags = installUsage(nullProto);
  assert.equal((nullProto.docs[0]?.data() as { amount: number }).amount, 4);
  assert.equal(nullFlags?.fields_read, 1);
  assert.equal(nullFlags?.fields_numeric, true);
});

test("admin proto write stats map transforms and omit the digest", async () => {
  const { protoWriteSignal } = await import("../src/core/payload.ts");
  const plain = protoWriteSignal({
    writes: [
      {
        update: {
          name: "projects/p/databases/(default)/documents/users/u",
          fields: { name: { stringValue: "Ada" } },
        },
      },
    ],
  });
  assert.equal(plain?.max_field_bytes, 9);
  assert.equal(plain?.payload_bytes, 9);
  assert.match(plain?.digest ?? "", /^[0-9a-f]{16}$/);

  const transformed = protoWriteSignal({
    writes: [
      {
        update: { name: "projects/p/databases/(default)/documents/users/u", fields: { n: { integerValue: "1" } } },
        updateTransforms: [{ fieldPath: "n", increment: { integerValue: "1" } }, { fieldPath: "tags", appendMissingElements: {} }],
        transform: { fieldTransforms: [{ fieldPath: "gone", removeAllFromArray: {} }, { fieldPath: "at", setToServerValue: "REQUEST_TIME" }] },
      },
    ],
  });
  assert.deepEqual(transformed?.transforms, ["array_remove", "array_union", "increment", "server_timestamp"]);
  assert.equal(transformed?.digest, undefined);
  // "n" is 2, integer is 8.
  assert.equal(transformed?.payload_bytes, 10);
});
