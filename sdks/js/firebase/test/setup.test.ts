import assert from "node:assert/strict";
import test from "node:test";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";

import { CoreClient, handoff } from "../src/core/client.ts";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "../src/web/firestore.ts";
import { maybeRecordInit } from "../src/web/setup.ts";

/** Settings objects. IndexedDB is not opened; only the wrapper's kind mapping runs. */
function cacheSettings(kind: string): Parameters<typeof initializeFirestore>[1] {
  return { localCache: { kind } } as Parameters<typeof initializeFirestore>[1];
}

function captured(body: () => void): Record<string, unknown>[] {
  const client = new CoreClient();
  const previous = handoff(client, () => {});
  try {
    body();
    return client.takeQueue().map((line) => JSON.parse(line) as Record<string, unknown>);
  } finally {
    handoff(previous, () => {});
  }
}

function initOf(db: object): Record<string, unknown> {
  const calls = captured(() => {
    maybeRecordInit({ firestore: db });
    maybeRecordInit({ firestore: db });
  });
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(calls[0]?.op, "init");
  assert.equal(calls[0]?.path, "projects/demo-readmeter/databases/(default)");
  return calls[0] ?? {};
}

test("init capture reads cache settings from the wrappers", async () => {
  const apps: FirebaseApp[] = [];
  const open = (name: string) => {
    const app = initializeApp({ apiKey: "demo", projectId: "demo-readmeter" }, name);
    apps.push(app);
    return app;
  };
  try {
    const singleCache = persistentLocalCache();
    const single = initOf(initializeFirestore(open("rm-setup-single"), { localCache: singleCache }));
    assert.deepEqual(single.setup, { cache: "persistent", shared_tabs: false });

    const sharedCache = persistentLocalCache({ tabManager: persistentMultipleTabManager() });
    const shared = initOf(initializeFirestore(open("rm-setup-shared"), { localCache: sharedCache }));
    assert.deepEqual(shared.setup, { cache: "persistent", shared_tabs: true });

    const memory = initOf(initializeFirestore(open("rm-setup-memory"), cacheSettings("memory")));
    assert.deepEqual(memory.setup, { cache: "memory", shared_tabs: false });

    const unknown = initOf(initializeFirestore(open("rm-setup-unknown"), cacheSettings("custom")));
    assert.deepEqual(unknown.setup, { cache: "unknown", shared_tabs: false });
  } finally {
    await Promise.all(apps.map((app) => deleteApp(app)));
  }
});
