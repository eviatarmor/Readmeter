import assert from "node:assert/strict";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase/app";

import { __rmcs } from "../src/callsite.ts";
import { flush, init, shutdown } from "../src/index.ts";
import { collection, doc, getFirestore, query } from "../src/web/firestore.ts";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "../src/web/functions.ts";
import { sink, sinkWrite } from "../src/web/sink.ts";
import { HASH_KEY, bundleBytes } from "./bundle.ts";

// Production browser: no stacks, so every callsite below must come from `__rmcs`.
test("injected callsites reach raw calls in a production browser build", { timeout: 30_000 }, async () => {
  const logged: Array<Record<string, unknown>> = [];
  const original = console.debug;
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") logged.push(JSON.parse(args[1]) as Record<string, unknown>);
  };
  const app = initializeApp({ apiKey: "demo", projectId: "demo-readmeter" }, "readmeter-plugin-runtime");
  try {
    init({
      apiKey: "rm_test",
      endpoint: "http://127.0.0.1:9",
      hashKey: HASH_KEY,
      bundle: bundleBytes(),
      debug: true,
      platform: "browser",
    });
    await flush();
    logged.length = 0;

    const db = getFirestore(app);
    const ref = doc(db, "posts", "p01");
    sinkWrite(ref, "set");
    __rmcs("src/Post.tsx:7:3", sinkWrite)(ref, "update");
    const snap = { size: 0, docs: [], metadata: { fromCache: false } };
    __rmcs("src/Post.tsx:9:3", sink)(query(collection(db, "posts")), snap);
    assert.deepEqual(
      logged.map((call) => [call.op, call.callsite]),
      [
        ["init", undefined],
        ["set", undefined],
        ["update", "src/Post.tsx:7:3"],
        ["query", "src/Post.tsx:9:3"],
      ],
    );

    // httpsCallable: the callable's invocation has no site of its own here,
    // so it uses the `httpsCallable(...)` site the plugin injected.
    logged.length = 0;
    const fns = getFunctions(app, "us-central1");
    connectFunctionsEmulator(fns, "127.0.0.1", 9);
    const echo = __rmcs("src/api.ts:3:14", httpsCallable)(fns, "echo");
    await echo({ n: 1 }).catch(() => undefined);
    await echo({ n: 2 }).catch(() => undefined);
    const callables = logged.filter((call) => call.op === "callable");
    assert.equal(callables.length, 2);
    for (const call of callables) assert.equal(call.callsite, "src/api.ts:3:14");
  } finally {
    console.debug = original;
    await shutdown();
    await deleteApp(app);
  }
});
