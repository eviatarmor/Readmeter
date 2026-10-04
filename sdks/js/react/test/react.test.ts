import { container } from "./dom.ts";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { act, createElement, StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deleteApp, initializeApp } from "firebase/app";
import { collection, connectFirestoreEmulator, getFirestore, limit, query, terminate } from "firebase/firestore";
import { currentMount, flush, init, shutdown, sink, type Finding } from "@readmeter/firebase";
import { onSnapshot } from "@readmeter/firebase/firestore";

import {
  ReadmeterProvider,
  useMountId,
  useReadmeterEffect,
  useReadmeterLayoutEffect,
  withMount,
  withReadmeterMount,
} from "../src/index.ts";

const HASH_KEY = "000102030405060708090a0b0c0d0e0f";
const BUNDLE = new Uint8Array(readFileSync(new URL("../../firebase/bundle/bundle.bin", import.meta.url)));

type Raw = Record<string, unknown>;

async function render(node: ReactNode): Promise<Root> {
  const root = createRoot(container());
  await act(async () => {
    root.render(node);
  });
  return root;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

/** Starts the real SDK (dev wasm, window rules) and collects raw calls and findings. */
async function recording(body: (logged: Raw[], findings: Finding[]) => Promise<void>): Promise<void> {
  const debug = console.debug;
  const warn = console.warn;
  const logged: Raw[] = [];
  const findings: Finding[] = [];
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") logged.push(JSON.parse(args[1]) as Raw);
  };
  console.warn = () => {};
  try {
    init({
      apiKey: "rm_test",
      endpoint: "http://127.0.0.1:9",
      hashKey: HASH_KEY,
      bundle: BUNDLE,
      dev: true,
      debug: true,
      platform: "browser",
      onFinding: (finding) => findings.push(finding),
    });
    await flush();
    logged.length = 0;
    await body(logged, findings);
  } finally {
    console.debug = debug;
    console.warn = warn;
    await shutdown();
  }
}

function firestore(name: string) {
  const app = initializeApp({ apiKey: "demo", projectId: "demo-readmeter" }, name);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, "127.0.0.1", 9);
  return {
    db,
    async close() {
      await terminate(db);
      await deleteApp(app);
    },
  };
}

const EMPTY_SNAP = { size: 3, docs: [], metadata: { fromCache: false } };
const doubleMounts = (findings: Finding[]) => findings.filter((f) => f.rule === "generic/react-double-mount");

test("StrictMode keeps one mount id per instance through the simulated remount", async () => {
  const seen: Array<[string, string, number | undefined]> = [];
  const ids = new Map<string, Set<number | undefined>>();
  function Probe({ name }: { name: string }): ReactNode {
    const mount = useMountId();
    const set = ids.get(name) ?? new Set();
    set.add(mount);
    ids.set(name, set);
    useReadmeterEffect(() => {
      seen.push([name, "effect", currentMount()]);
      return () => {
        seen.push([name, "cleanup", currentMount()]);
      };
    }, []);
    useReadmeterLayoutEffect(() => {
      seen.push([name, "layout", currentMount()]);
    }, []);
    return null;
  }
  const root = await render(createElement(StrictMode, null, createElement(Probe, { name: "a" }), createElement(Probe, { name: "b" })));
  assert.equal(currentMount(), undefined);

  // Each instance rendered with exactly one id, and the ids differ.
  const a = [...(ids.get("a") ?? [])];
  const b = [...(ids.get("b") ?? [])];
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(typeof a[0], "number");
  assert.notEqual(a[0], b[0]);

  // StrictMode ran effect, cleanup, effect for each instance. Each hook call
  // owns one id: the same through the simulated remount, different per
  // instance and per hook.
  const effectIds = new Map<string, number | undefined>();
  for (const name of ["a", "b"]) {
    const phases = seen.filter(([n, phase]) => n === name && phase !== "layout");
    assert.deepEqual(
      phases.map(([, phase]) => phase),
      ["effect", "cleanup", "effect"],
    );
    const effect = new Set(phases.map(([, , id]) => id));
    assert.equal(effect.size, 1);
    const id = [...effect][0];
    assert.equal(typeof id, "number");
    effectIds.set(name, id);
    const layout = new Set(seen.filter(([n, phase]) => n === name && phase === "layout").map(([, , id]) => id));
    assert.equal(layout.size, 1);
    assert.notEqual([...layout][0], id);
  }
  assert.notEqual(effectIds.get("a"), effectIds.get("b"));

  // A real unmount runs the cleanup under the same id; a new instance gets a new one.
  seen.length = 0;
  await unmount(root);
  assert.deepEqual(seen, [
    ["a", "cleanup", effectIds.get("a")],
    ["b", "cleanup", effectIds.get("b")],
  ]);
  ids.clear();
  const again = await render(createElement(Probe, { name: "a" }));
  assert.notEqual([...(ids.get("a") ?? [])][0], a[0]);
  await unmount(again);
});

test("ReadmeterProvider is optional and can turn tagging off", async () => {
  const seen: Array<number | undefined> = [];
  function Probe(): ReactNode {
    const mount = useMountId();
    useEffect(() => withMount(mount, () => void seen.push(mount, currentMount())), [mount]);
    return null;
  }
  // No provider at all, then an enabled one.
  for (const node of [createElement(Probe), createElement(ReadmeterProvider, null, createElement(Probe))]) {
    seen.length = 0;
    const root = await render(node);
    assert.equal(typeof seen[0], "number");
    assert.equal(seen[1], seen[0]);
    await unmount(root);
  }

  seen.length = 0;
  const off = await render(createElement(ReadmeterProvider, { enabled: false }, createElement(Probe)));
  assert.deepEqual(seen, [undefined, undefined]);
  await unmount(off);
});

test("withMount tags synchronous work only and passes errors and values through", () => {
  assert.equal(
    withMount(7, () => currentMount()),
    7,
  );
  assert.equal(
    withMount(undefined, () => currentMount()),
    undefined,
  );
  const error = new Error("app");
  assert.throws(
    () =>
      withMount(7, () => {
        throw error;
      }),
    (thrown) => thrown === error,
  );
  assert.equal(currentMount(), undefined);
  // No init: the SDK is idle and nothing throws.
  assert.equal(withMount(7, () => sink({ path: "x" }, 5)), 5);
});

test("StrictMode onSnapshot in an effect: one mount, and react-double-mount fires", { timeout: 60_000 }, async () => {
  const { db, close } = firestore("readmeter-react-snapshot");
  try {
    await recording(async (logged, findings) => {
      function Todos(): ReactNode {
        useReadmeterEffect(() => onSnapshot(query(collection(db, "todos"), limit(50)), () => undefined), []);
        return null;
      }
      const root = await render(createElement(StrictMode, null, createElement(Todos)));
      await unmount(root);

      const listener = logged.filter((raw) => raw.op === "subscribe" || raw.op === "unsubscribe");
      assert.deepEqual(
        listener.map((raw) => raw.op),
        ["subscribe", "unsubscribe", "subscribe", "unsubscribe"],
      );
      const mounts = new Set(listener.map((raw) => raw.mount));
      assert.equal(mounts.size, 1);
      assert.equal(typeof [...mounts][0], "number");
      // Two listeners, one component instance.
      assert.equal(new Set(listener.map((raw) => raw.listener)).size, 2);

      const found = doubleMounts(findings);
      assert.equal(found.length, 1, JSON.stringify(findings));
      assert.equal(found[0]?.template, "todos");
      assert.match(found[0]?.message ?? "", /same component instance/);
    });
  } finally {
    await close();
  }
});

test("reads in effects: same mount fires, sibling mounts do not", { timeout: 60_000 }, async () => {
  const { db, close } = firestore("readmeter-react-reads");
  try {
    const todos = query(collection(db, "todos"), limit(10));

    function Tagged(): ReactNode {
      useReadmeterEffect(() => {
        sink(todos, EMPTY_SNAP);
      }, []);
      return null;
    }
    function Untagged(): ReactNode {
      useEffect(() => {
        sink(todos, EMPTY_SNAP);
      }, []);
      return null;
    }

    // One instance under StrictMode reads twice with the same mount.
    await recording(async (logged, findings) => {
      await unmount(await render(createElement(StrictMode, null, createElement(Tagged))));
      const reads = logged.filter((raw) => raw.op === "query");
      assert.equal(reads.length, 2);
      assert.equal(reads[0]?.mount, reads[1]?.mount);
      assert.equal(doubleMounts(findings).length, 1, JSON.stringify(findings));
    });

    // Two sibling instances each read once: different mounts, no finding.
    await recording(async (logged, findings) => {
      await unmount(await render(createElement("div", null, createElement(Tagged), createElement(Tagged))));
      const reads = logged.filter((raw) => raw.op === "query");
      assert.equal(reads.length, 2);
      assert.notEqual(reads[0]?.mount, reads[1]?.mount);
      assert.deepEqual(doubleMounts(findings), []);
    });

    // The same siblings without mount ids look like a double read.
    await recording(async (logged, findings) => {
      await unmount(await render(createElement("div", null, createElement(Untagged), createElement(Untagged))));
      assert.equal(logged.filter((raw) => raw.op === "query" && raw.mount === undefined).length, 2);
      assert.equal(doubleMounts(findings).length, 1);
    });
  } finally {
    await close();
  }
});

test("withReadmeterMount tags reads made during render", { timeout: 60_000 }, async () => {
  const { db, close } = firestore("readmeter-react-render");
  try {
    await recording(async (logged) => {
      const todos = query(collection(db, "todos"), limit(5));
      const Badge = withReadmeterMount(function Badge({ label }: { label: string }): ReactNode {
        const [n] = useState(1);
        sink(todos, EMPTY_SNAP);
        return createElement("span", null, `${label}${n}`);
      });
      assert.equal(Badge.displayName, "withReadmeterMount(Badge)");
      const root = await render(createElement("div", null, createElement(Badge, { label: "a" }), createElement(Badge, { label: "b" })));
      const reads = logged.filter((raw) => raw.op === "query");
      assert.equal(reads.length, 2);
      assert.equal(typeof reads[0]?.mount, "number");
      assert.notEqual(reads[0]?.mount, reads[1]?.mount);
      assert.equal(currentMount(), undefined);
      await unmount(root);
    });
  } finally {
    await close();
  }
});
