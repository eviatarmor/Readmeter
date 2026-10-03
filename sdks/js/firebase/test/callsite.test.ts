import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  __rmcs,
  allowStackCallsites,
  callsite,
  callsiteFromStack,
  captureStack,
  inRenderFromStack,
  readSite,
  takeInjected,
} from "../src/core/callsite.ts";

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

const DEPS = "http://localhost:5173/node_modules/.vite/deps/react-dom_client.js";

function v8(name: string, file = DEPS, line = 100): string {
  return `    at ${name} (${file}:${line}:5)`;
}

function gecko(name: string, file = DEPS, line = 100): string {
  return `${name}@${file}:${line}:5`;
}

test("v8 render frames mark the call as in render", () => {
  const stack = [
    "Error",
    v8("readSite", "http://localhost:5173/node_modules/@readmeter/firebase/dist/core/callsite.js"),
    v8("getDocs", "http://localhost:5173/node_modules/@readmeter/firebase/dist/web/firestore.js"),
    v8("Badge", "http://localhost:5173/src/Badge.tsx", 7),
    v8("Object.react_stack_bottom_frame"),
    v8("renderWithHooks"),
    v8("updateFunctionComponent"),
    v8("beginWork"),
  ].join("\n");
  assert.equal(inRenderFromStack(stack), true);
  const again = ["Error", v8("Badge", "http://localhost:5173/src/Badge.tsx", 7), v8("renderWithHooksAgain")].join("\n");
  assert.equal(inRenderFromStack(again), true);
});

test("firefox and safari render frames mark the call as in render", () => {
  const firefox = [gecko("getDocs"), gecko("Badge", "http://localhost:5173/src/Badge.tsx", 7), gecko("react_stack_bottom_frame"), gecko("renderWithHooks"), gecko("beginWork")].join("\n");
  assert.equal(inRenderFromStack(firefox), true);
  const nested = [gecko("Badge/<"), gecko("Object.renderWithHooks")].join("\n");
  assert.equal(inRenderFromStack(nested), true);
  const safari = ["getDocs@http://localhost:5173/node_modules/firebase.js:1:2", "Badge@http://localhost:5173/src/Badge.tsx:7:3", `renderWithHooks@${DEPS}:100:5`].join("\n");
  assert.equal(inRenderFromStack(safari), true);
});

test("effect frames do not count, even when a render frame sits below", () => {
  const effect = [
    "Error",
    v8("getDocs"),
    v8("Badge.useEffect", "http://localhost:5173/src/Badge.tsx", 9),
    v8("Object.react_stack_bottom_frame"),
    v8("commitHookEffectListMount"),
    v8("commitPassiveMountOnFiber"),
    v8("flushPassiveEffects"),
    v8("renderWithHooks"),
  ].join("\n");
  assert.equal(inRenderFromStack(effect), false);
  const gEffect = [gecko("getDocs"), gecko("Badge/<"), gecko("commitHookEffectListMount"), gecko("commitRoot")].join("\n");
  assert.equal(inRenderFromStack(gEffect), false);
});

test("event handlers and non-React stacks are not in render", () => {
  const handler = [
    "Error",
    v8("getDocs"),
    v8("onClick", "http://localhost:5173/src/Badge.tsx", 12),
    v8("executeDispatch"),
    v8("processDispatchQueue"),
    v8("dispatchEventForPluginEventSystem"),
    v8("dispatchEvent"),
  ].join("\n");
  assert.equal(inRenderFromStack(handler), false);
  assert.equal(inRenderFromStack(["Error", v8("main", "file:///app/index.js", 3), "    at file:///app/index.js:1:1"].join("\n")), false);
  assert.equal(inRenderFromStack(["@http://x/a.js:1:1", "main@http://x/a.js:2:2"].join("\n")), false);
  // A user function whose name only contains the React name does not count.
  assert.equal(inRenderFromStack(v8("myRenderWithHooksHelper")), false);
  assert.equal(inRenderFromStack(undefined), false);
  assert.equal(inRenderFromStack(""), false);
});

test("captureStack reaches deep frames and restores stackTraceLimit", () => {
  const previous = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 10;
    const deep = (n: number): string | undefined => (n === 0 ? captureStack() : deep(n - 1));
    const stack = deep(30) ?? "";
    assert.ok(stack.split("\n").length > 30, "expected more than the default 10 frames");
    assert.equal(Error.stackTraceLimit, 10);

    Error.stackTraceLimit = 80;
    captureStack();
    assert.equal(Error.stackTraceLimit, 80);
  } finally {
    Error.stackTraceLimit = previous;
  }
});

test("captureStack does not throw when stackTraceLimit cannot be set", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
  try {
    Object.defineProperty(Error, "stackTraceLimit", {
      configurable: true,
      get: () => 5,
      set: () => {
        throw new Error("locked");
      },
    });
    assert.doesNotThrow(() => captureStack());
    assert.doesNotThrow(() => readSite());
  } finally {
    if (descriptor) Object.defineProperty(Error, "stackTraceLimit", descriptor);
  }
});

test("readSite never throws and reports render from a live stack", () => {
  const previous = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 10;
    const renderWithHooks = (): ReturnType<typeof readSite> => {
      const deep = (n: number): ReturnType<typeof readSite> => (n === 0 ? readSite() : deep(n - 1));
      return deep(15);
    };
    const inside = renderWithHooks();
    assert.equal(inside.inRender, true);
    assert.match(inside.site ?? "", /callsite\.test\.ts:\d+:\d+$/);
    assert.equal(readSite().inRender, false);
    assert.equal(Error.stackTraceLimit, 10);
  } finally {
    Error.stackTraceLimit = previous;
  }
});

test("an injected callsite wins, is consumed once, and does not leak", () => {
  const seen: Array<string | undefined> = [];
  const wrapped = (a: number, b: number): number => {
    seen.push(callsite());
    seen.push(callsite());
    return a + b;
  };
  assert.equal(__rmcs("src/a.ts:3:7", wrapped)(1, 2), 3);
  assert.equal(seen[0], "src/a.ts:3:7");
  assert.match(seen[1] ?? "", /callsite\.test\.ts:\d+:\d+$/, "second call falls back to the stack");
  assert.equal(takeInjected(), undefined);

  // Nested: the inner call takes its own site; the outer one keeps its own.
  const outer = (inner: string | undefined): [string | undefined, string | undefined] => [callsite(), inner];
  const inner = (): string | undefined => callsite();
  const [outerSite, innerSite] = __rmcs("src/a.ts:1:1", outer)(__rmcs("src/a.ts:1:20", inner)());
  assert.equal(outerSite, "src/a.ts:1:1");
  assert.equal(innerSite, "src/a.ts:1:20");

  // Unconsumed sites are dropped after the call, also when it throws.
  assert.throws(() => __rmcs("src/a.ts:9:9", () => {
    throw new Error("boom");
  })(), /boom/);
  assert.equal(takeInjected(), undefined);
  __rmcs("src/a.ts:9:9", () => undefined)();
  assert.equal(takeInjected(), undefined);

  // `this` and non-functions pass through.
  const host = { n: 5, get(this: { n: number }) { return this.n; } };
  assert.equal(__rmcs("x:1:1", host.get).call(host), 5);
  const notFn = { a: 1 };
  assert.equal(__rmcs("x:1:1", notFn), notFn);
});

test("readSite uses the injected callsite", () => {
  const got = __rmcs("src/b.tsx:4:2", () => readSite())();
  assert.equal(got.site, "src/b.tsx:4:2");
  assert.equal(got.inRender, false);
});

test("production browsers capture no stacks", () => {
  allowStackCallsites(false);
  try {
    assert.equal(callsite(), undefined);
    assert.deepEqual(readSite(), { site: undefined, inRender: false });
    const renderWithHooks = (): ReturnType<typeof readSite> => readSite();
    assert.deepEqual(renderWithHooks(), { site: undefined, inRender: false });
    assert.equal(__rmcs("src/c.ts:1:1", () => callsite())(), "src/c.ts:1:1");
    assert.deepEqual(__rmcs("src/c.ts:2:1", () => readSite())(), { site: "src/c.ts:2:1", inRender: false });
  } finally {
    allowStackCallsites(true);
  }
});
