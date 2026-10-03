// Checks the minimal app built by ./vite.config.ts:
// 1. the Vite plugin injected callsites for the wrapped calls;
// 2. the JS glue (everything a production page loads except the wasm) fits the budget;
// 3. at runtime, with `wasmUrl` set and the inline wasm chunks deleted, the SDK
//    streams the wasm from the URL and the batch carries the injected callsite labels.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * JS glue budget, gzip bytes. The target is 10 KB on top of the wasm; the
 * glue measured 14,607 B when this check landed, so this is a ratchet at that
 * size rounded up to 512 B. Lower it as the glue shrinks; do not raise it
 * without a reason in the commit. Biggest contributors then (minified bytes):
 * index.js 13%, web/usage.js 10%, web/shape.js 10%, core/transport.js 9%,
 * web/sink.js 8%, admin/shape.js 7% (sink accepts Admin SDK targets),
 * core/wasm.js 7%, core/callsite.js 7%.
 */
const GLUE_BUDGET_GZIP = 14_848;

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const dist = here("./dist");
const source = readFileSync(here("./main.js"), "utf8");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** 1-based `line:col` of `needle` in main.js. */
function pos(needle) {
  const at = source.indexOf(needle);
  assert.ok(at >= 0, needle);
  const lines = source.slice(0, at).split("\n");
  return `${lines.length}:${lines.at(-1).length + 1}`;
}

const label = (needle) => `test/bundle/app/main.js:${pos(needle)}`;
const files = walk(dist);
const js = files.filter((file) => file.endsWith(".js"));
const main = readFileSync(`${dist}/main.js`, "utf8");

// 1. Injected callsites.
const expected = {
  set: label(`recordWrite(ref, "set")`),
  delete: label(`recordWrite(ref, "delete")`),
  getDocs: label("getDocs(q)"),
  getDoc: label("getDoc(r)"),
};
for (const [name, site] of Object.entries(expected)) {
  assert.ok(main.includes(site), `missing injected callsite for ${name}: ${site}`);
}

// 2. Glue size. The wasm ships as one base64 chunk per build (or a .wasm file
// with `wasmUrl`); the dev build's glue is never loaded in production.
const prodWasm = readFileSync(here("../../../wasm/prod/readmeter_wasm_bg.wasm"));
const devWasm = readFileSync(here("../../../wasm/dev/readmeter_wasm_bg.wasm"));
const inline = js.filter((file) => {
  const text = readFileSync(file, "utf8");
  return text.includes(prodWasm.toString("base64")) || text.includes(devWasm.toString("base64"));
});
assert.equal(inline.length, 2, `expected two inline wasm chunks, got ${inline.join(", ")}`);
const glueChunks = js.filter((file) => file.includes("readmeter_wasm"));
assert.equal(glueChunks.length, 2, `expected prod and dev wasm-bindgen glue chunks, got ${glueChunks.join(", ")}`);

const gz = (file) => gzipSync(readFileSync(file)).length;
// main.js picks the build with `dev ? import(devGlue) : import(prodGlue)`; both glue
// chunks are the same size within a few bytes, so count the larger one.
const glueChunk = glueChunks.reduce((a, b) => (gz(a) >= gz(b) ? a : b));
const loaded = js.filter((file) => !inline.includes(file) && !glueChunks.includes(file)).concat(glueChunk);
const sizes = loaded.map((file) => ({ file: file.slice(dist.length + 1), gzip: gz(file), raw: statSync(file).size }));
const glue = sizes.reduce((sum, entry) => sum + entry.gzip, 0);
for (const entry of sizes) console.log(`  ${entry.file}: raw ${entry.raw} B, gzip ${entry.gzip} B`);
const prodInline = inline.find((file) => readFileSync(file, "utf8").includes(prodWasm.toString("base64")));
console.log(
  `JS glue: gzip ${glue} B (budget ${GLUE_BUDGET_GZIP} B); prod wasm: file gzip ${gzipSync(prodWasm).length} B, inline chunk gzip ${gz(prodInline)} B`,
);
assert.ok(glue <= GLUE_BUDGET_GZIP, `JS glue ${glue} B gzip exceeds ${GLUE_BUDGET_GZIP} B`);

// 3. Runtime with wasmUrl. Without the inline chunks, any import of them fails
// and the SDK disables itself, so a batch proves the URL path never touched them.
for (const file of inline) rmSync(file);

const wasmRequests = [];
const batches = [];
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/prod.wasm") {
    wasmRequests.push(req.url);
    res.writeHead(200, { "content-type": "application/wasm" });
    res.end(prodWasm);
    return;
  }
  if (req.method === "POST" && req.url === "/v1/batches") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      batches.push(Buffer.concat(chunks));
      res.writeHead(202, { "content-type": "application/json" });
      res.end("{}");
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const errors = [];
const originalError = console.error;
console.error = (...args) => {
  errors.push(args.join(" "));
};
try {
  const app = await import(pathToFileURL(`${dist}/main.js`).href);
  const { initializeApp, deleteApp } = await import("firebase/app");
  const { getFirestore, doc } = await import("firebase/firestore");
  const fbApp = initializeApp({ apiKey: "demo", projectId: "demo-readmeter" }, "readmeter-bundle-app");
  try {
    const builds = [];
    app.init({
      apiKey: "rm_bundle_check",
      endpoint: origin,
      hashKey: "000102030405060708090a0b0c0d0e0f",
      bundle: new Uint8Array(readFileSync(here("../../../bundle/bundle.bin"))),
      // Browser platform outside dev: no stack capture, so labels can only come from the plugin.
      platform: "browser",
      flushIntervalMs: 60_000,
      wasmUrl: (build) => {
        builds.push(build);
        return `${origin}/${build}.wasm`;
      },
    });
    app.run(doc(getFirestore(fbApp), "posts", "p01"));
    await app.flush();
    await app.shutdown();
    assert.deepEqual(errors, [], "SDK stayed enabled");
    assert.deepEqual(builds, ["prod"]);
    assert.deepEqual(wasmRequests, ["/prod.wasm"], "wasm fetched once from wasmUrl");
    assert.ok(batches.length >= 1, "a batch was posted");
    const body = Buffer.concat(batches).toString("latin1");
    assert.ok(body.includes(expected.set), `batch carries ${expected.set}`);
    assert.ok(body.includes(expected.delete), `batch carries ${expected.delete}`);
  } finally {
    await deleteApp(fbApp);
  }
} finally {
  console.error = originalError;
  server.close();
}

console.log(`app bundle ok: callsites injected and recorded, wasm from wasmUrl (${wasmRequests.length} request), inline chunks not loaded`);
