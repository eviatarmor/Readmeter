import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, SourceMap } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { relativePath, transformCallsites, WRAPPED } from "../src/plugin/transform.ts";
import readmeter from "../src/plugin/vite.ts";
import readmeterLoader, { type LoaderContext } from "../src/plugin/webpack-loader.ts";

const ROOT = "/repo/app";
const pkg = fileURLToPath(new URL("..", import.meta.url));

function run(code: string, file = "src/a.ts"): { code: string; calls: number; map: unknown } {
  const out = transformCallsites(code, { id: `${ROOT}/${file}`, root: ROOT });
  assert.ok(out, "expected a transform");
  return out;
}

/** 1-based line:col of the `nth` occurrence of `needle`. */
function pos(code: string, needle: string, nth = 0): string {
  let at = -1;
  for (let i = 0; i <= nth; i += 1) at = code.indexOf(needle, at + 1);
  assert.ok(at >= 0, `${needle} not found`);
  const before = code.slice(0, at).split("\n");
  return `${before.length}:${(before.at(-1)?.length ?? 0) + 1}`;
}

test("named, aliased and namespace imports get the callee's original line:col", () => {
  const src = [
    `import { getDocs, getDoc as gd, query, collection } from "@readmeter/firebase/firestore";`,
    `import * as rtdb from "@readmeter/firebase/database";`,
    `import { sinkWrite } from "@readmeter/firebase";`,
    ``,
    `export async function load(db) {`,
    `  const snap = await getDocs(query(collection(db, "posts")));`,
    `  const one = await gd(ref);`,
    `  await rtdb.get(r); await rtdb["set"](r, 1); rtdb.ref(db);`,
    `  return sinkWrite(snap, "set");`,
    `}`,
  ].join("\n");
  const out = run(src);
  assert.equal(out.calls, 5);
  assert.ok(out.code.includes(`__rmcs("src/a.ts:${pos(src, "getDocs(")}", getDocs)(query(collection(db, "posts")))`));
  assert.ok(out.code.includes(`__rmcs("src/a.ts:${pos(src, "gd(")}", gd)(ref)`));
  assert.ok(out.code.includes(`__rmcs("src/a.ts:${pos(src, "get(r)")}", rtdb.get)(r)`));
  assert.ok(out.code.includes(`__rmcs("src/a.ts:${pos(src, `"set"]`)}", rtdb["set"])(r, 1)`));
  assert.ok(out.code.includes(`rtdb.ref(db)`), "not wrapped, untouched");
  assert.ok(out.code.includes(`__rmcs("src/a.ts:${pos(src, "sinkWrite(snap")}", sinkWrite)(snap, "set")`));
  assert.ok(out.code.includes(`import { __rmcs as __rmcs } from "@readmeter/firebase/callsite";`));
  // Lines do not move: the runtime import shares a line with an existing import.
  assert.equal(out.code.split("\n").length, src.split("\n").length);
});

test("TSX with generics, JSX, arrow functions and nested calls", () => {
  const src = [
    `"use client";`,
    `import type { Query } from "firebase/firestore";`,
    `import { getDocs, onSnapshot, setDoc } from "@readmeter/firebase/firestore";`,
    `import { useEffect } from "react";`,
    `type Row = { id: string };`,
    `export function List<T extends Row>({ q }: { q: Query<T> }) {`,
    `  useEffect(() => onSnapshot(q, (s) => setDoc(ref, { n: s.size })), [q]);`,
    `  const load = async () => (await getDocs<T>(q)).docs as T[];`,
    `  return <button onClick={() => void setDoc(ref, { at: <i>now</i> as unknown as number })}>{String(load)}</button>;`,
    `}`,
  ].join("\n");
  const out = run(src, "src/List.tsx");
  assert.equal(out.calls, 4);
  assert.ok(out.code.startsWith(`"use client";`), "directive stays first");
  assert.ok(out.code.includes(`__rmcs("src/List.tsx:${pos(src, "onSnapshot(q")}", onSnapshot)(q, (s) => __rmcs("src/List.tsx:${pos(src, "setDoc(ref, { n")}", setDoc)(ref,`));
  assert.ok(out.code.includes(`__rmcs("src/List.tsx:${pos(src, "getDocs<T>")}", getDocs)<T>(q)`));
  assert.ok(out.code.includes(`void __rmcs("src/List.tsx:${pos(src, "setDoc(ref, { at")}", setDoc)(ref`));
});

test("shadowed names, type-only imports and unrelated imports are left alone", () => {
  const src = [
    `import { get, set } from "@readmeter/firebase/database";`,
    `import type { getDocs } from "@readmeter/firebase/firestore";`,
    `import { getDocs as other } from "firebase/firestore";`,
    `function a(get) { return get(1); }`,
    `function b() { const { set } = obj; set(2); }`,
    `function c() { if (x) { let get = f; get(3); } return get(4); }`,
    `for (const set of list) set(5);`,
    `try { x(); } catch (get) { get(6); }`,
    `class K { m() { var set = 1; set(7); } }`,
    `other(8);`,
    `optional?.(get); get?.(9); new set(10);`,
  ].join("\n");
  const out = run(src);
  assert.equal(out.calls, 1, out.code);
  assert.ok(out.code.includes(`__rmcs("src/a.ts:${pos(src, "get(4)")}", get)(4)`));
  assert.ok(out.code.includes("return get(1)"));
  assert.ok(out.code.includes("other(8)"));
});

test("no-op on unrelated code, node_modules, virtual modules and non-script files", () => {
  const firebaseOnly = `import { getDocs } from "firebase/firestore";\ngetDocs(q);\n`;
  assert.equal(transformCallsites(firebaseOnly, { id: `${ROOT}/src/a.ts`, root: ROOT }), undefined);
  const ours = `import { getDocs } from "@readmeter/firebase/firestore";\ngetDocs(q);\n`;
  assert.equal(transformCallsites(ours, { id: `${ROOT}/node_modules/x/index.js`, root: ROOT }), undefined);
  assert.equal(transformCallsites(ours, { id: `\0virtual:${ROOT}/a.ts`, root: ROOT }), undefined);
  assert.equal(transformCallsites(ours, { id: `${ROOT}/src/a.css`, root: ROOT }), undefined);
  assert.equal(transformCallsites(ours, { id: `${ROOT}/src/a.d.ts`, root: ROOT }), undefined);
  assert.equal(transformCallsites(`import { init } from "@readmeter/firebase";\ninit({});\n`, { id: `${ROOT}/src/a.ts`, root: ROOT }), undefined);
  assert.equal(transformCallsites(`import { getDocs } from "@readmeter/firebase/firestore";\nconst = ;`, { id: `${ROOT}/src/a.ts`, root: ROOT }), undefined, "syntax errors are left to the bundler");
  // Query strings (Vite) are stripped from the label.
  const q = transformCallsites(ours, { id: `${ROOT}/src/a.ts?v=123`, root: ROOT });
  assert.ok(q?.code.includes(`"src/a.ts:2:1"`));
});

test("helper name avoids collisions with user code", () => {
  const out = run(`import { getDocs } from "@readmeter/firebase/firestore";\nconst __rmcs = 1;\ngetDocs(__rmcs);\n`);
  assert.ok(out.code.includes(`import { __rmcs as __rmcs1 }`));
  assert.ok(out.code.includes(`__rmcs1("src/a.ts:3:1", getDocs)(__rmcs)`));
});

test("sourcemap maps the rewritten call back to the original position", () => {
  const src = `import { getDocs } from "@readmeter/firebase/firestore";\n\nexport const f = async (q) =>\n  (await getDocs(q)).size;\n`;
  const out = run(src);
  const map = JSON.parse(JSON.stringify(out.map)) as { sources: string[]; sourcesContent: string[]; mappings: string };
  assert.deepEqual(map.sources.map((s) => s.replace(/\\/g, "/")).at(-1)?.endsWith("src/a.ts"), true);
  assert.equal(map.sourcesContent[0], src);
  assert.ok(map.mappings.length > 0);
  const lines = out.code.split("\n");
  const line = lines.findIndex((l) => l.includes("getDocs)(q)"));
  const col = (lines[line] ?? "").indexOf("getDocs)(q)");
  const entry = new SourceMap(map as never).findEntry(line, col) as { originalLine: number; originalColumn: number };
  assert.equal(`${entry.originalLine + 1}:${entry.originalColumn + 1}`, pos(src, "getDocs(q)"));
});

test("relative paths use forward slashes and handle Windows roots", () => {
  assert.equal(relativePath("C:\\Users\\me\\app\\src\\a.ts", "C:\\Users\\me\\app"), "src/a.ts");
  assert.equal(relativePath("c:/Users/me/app/src/a.ts", "C:/Users/me/app/"), "src/a.ts");
  assert.equal(relativePath("/repo/packages/ui/b.ts", "/repo/app"), "../packages/ui/b.ts");
  assert.equal(relativePath("/repo/app/a.ts", "/repo/app"), "a.ts");
});

test("every wrapped name is a function exported by its module", async () => {
  const modules: Record<string, string> = {
    "@readmeter/firebase": "../src/index.ts",
    "@readmeter/firebase/firestore": "../src/web/firestore.ts",
    "@readmeter/firebase/database": "../src/web/database.ts",
    "@readmeter/firebase/storage": "../src/web/storage.ts",
    "@readmeter/firebase/auth": "../src/web/auth.ts",
    "@readmeter/firebase/functions": "../src/web/functions.ts",
  };
  assert.deepEqual(Object.keys(WRAPPED).sort(), Object.keys(modules).sort());
  for (const [source, names] of Object.entries(WRAPPED)) {
    const mod = (await import(modules[source] ?? "")) as Record<string, unknown>;
    for (const name of names) assert.equal(typeof mod[name], "function", `${source} ${name}`);
  }
});

test("vite plugin uses the resolved root and runs before other transforms", () => {
  const plugin = readmeter();
  assert.equal(plugin.enforce, "pre");
  plugin.configResolved({ root: ROOT });
  const out = plugin.transform(`import { getDocs } from "@readmeter/firebase/firestore";\ngetDocs(q);\n`, `${ROOT}/src/x.js`);
  assert.ok(out?.code.includes(`"src/x.js:2:1"`));
  assert.ok(out?.map);
  assert.equal(plugin.transform(`export const a = 1;`, `${ROOT}/src/y.js`), undefined);
  const fixed = readmeter({ root: "/elsewhere" });
  fixed.configResolved({ root: ROOT });
  assert.ok(fixed.transform(`import { getDocs } from "@readmeter/firebase/firestore";\ngetDocs(q);\n`, "/elsewhere/z.ts")?.code.includes(`"z.ts:2:1"`));
});

function fakeContext(resourcePath: string, rootContext: string): { ctx: LoaderContext; result: unknown[] } {
  const result: unknown[] = [];
  const ctx: LoaderContext = {
    resourcePath,
    resourceQuery: "",
    rootContext,
    sourceMap: true,
    getOptions: () => ({}),
    callback: (...args: unknown[]) => {
      result.push(...args);
    },
  };
  return { ctx, result };
}

test("webpack loader: transforms, passes through untouched files, returns a map", () => {
  const src = `import { getDocs } from "@readmeter/firebase/firestore";\ngetDocs(q);\n`;
  const { ctx, result } = fakeContext(path.join(pkg, "src", "page.tsx"), pkg);
  readmeterLoader.call(ctx, src);
  assert.equal(result[0], null);
  assert.ok(String(result[1]).includes(`"src/page.tsx:2:1"`));
  assert.ok(result[2], "sourcemap");

  const plain = fakeContext(path.join(pkg, "src", "page.tsx"), pkg);
  readmeterLoader.call(plain.ctx, "export const a = 1;", "in-map");
  assert.deepEqual(plain.result.slice(0, 3), [null, "export const a = 1;", "in-map"]);
});

test("webpack build: loader injects callsites the runtime consumes", { timeout: 120_000 }, async () => {
  const dist = path.join(pkg, "dist");
  const loader = path.join(dist, "plugin", "webpack-loader.js");
  const callsiteRuntime = path.join(dist, "callsite.js");
  const coreCallsite = path.join(dist, "core", "callsite.js").replace(/\\/g, "/");
  try {
    readFileSync(loader);
  } catch {
    assert.fail("build the package first (dist/plugin/webpack-loader.js missing)");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "readmeter-webpack-"));
  try {
    writeFileSync(
      path.join(dir, "stub-firestore.mjs"),
      `import { callsite } from ${JSON.stringify(coreCallsite)};\nexport function getDocs(q) { return { site: callsite(), q }; }\n`,
    );
    writeFileSync(
      path.join(dir, "app.mjs"),
      [
        `import { getDocs as load } from "@readmeter/firebase/firestore";`,
        `export const run = () => [load(1), (() => load(2))()];`,
        ``,
      ].join("\n"),
    );
    const require = createRequire(import.meta.url);
    const webpack = require("webpack") as typeof import("webpack");
    const stats = await new Promise<import("webpack").Stats>((resolve, reject) => {
      webpack(
        {
          mode: "production",
          context: dir,
          target: "node",
          devtool: "source-map",
          entry: "./app.mjs",
          output: { path: path.join(dir, "out"), filename: "app.cjs", library: { type: "commonjs2" } },
          resolve: {
            alias: {
              "@readmeter/firebase/firestore$": path.join(dir, "stub-firestore.mjs"),
              "@readmeter/firebase/callsite$": callsiteRuntime,
            },
          },
          module: { rules: [{ test: /\.m?js$/, exclude: /node_modules|[\\/]dist[\\/]/, enforce: "pre", use: loader }] },
        },
        (error, result) => (error || !result ? reject(error ?? new Error("no stats")) : resolve(result)),
      );
    });
    assert.ok(!stats.hasErrors(), stats.toString({ all: false, errors: true }));
    const built = readFileSync(path.join(dir, "out", "app.cjs"), "utf8");
    assert.ok(built.includes(`"app.mjs:2:27"`), built);
    const mod = require(path.join(dir, "out", "app.cjs")) as { run: () => Array<{ site?: string; q: number }> };
    const [first, second] = mod.run();
    assert.deepEqual(first, { site: "app.mjs:2:27", q: 1 });
    assert.deepEqual(second, { site: "app.mjs:2:43", q: 2 });
    const map = JSON.parse(readFileSync(path.join(dir, "out", "app.cjs.map"), "utf8")) as { sources: string[] };
    assert.ok(map.sources.some((s) => s.endsWith("app.mjs")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
