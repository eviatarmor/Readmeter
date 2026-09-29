// Loads the built wasm package in Node and runs one raw call through it.
// Usage: node scripts/smoke-wasm.mjs [pkg-dir] [bundle.bin]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pkg = resolve(process.argv[2] ?? "target/wasm-pkg");
const bundle = readFileSync(process.argv[3] ?? "target/rules/bundle.bin");
const mod = await import(pathToFileURL(join(pkg, "readmeter_wasm.js")).href);
mod.initSync({ module: readFileSync(join(pkg, "readmeter_wasm_bg.wasm")) });

const rm = new mod.Readmeter(
  JSON.stringify({
    provider: "firebase",
    sdk: { name: "smoke", version: "0" },
    session: "18446744073709551615",
    hash_key: "000102030405060708090a0b0c0d0e0f",
    platform: "browser",
  }),
  bundle,
);
const findings = JSON.parse(
  rm.record(
    JSON.stringify({
      service: "firestore", op: "query", ts_ms: Date.now(), path: "users/u1/orders",
      query: { filters: [{ field: "status", op: "==", value: "open" }] },
      result: { docs: 500, bytes: 50000 },
    }),
  ),
);
const batch = rm.flush(Date.now());
const rules = findings.map((f) => f.rule);
if (!rules.includes("firebase.firestore/unbounded-list")) throw new Error(`unexpected findings ${rules}`);
if (!(batch instanceof Uint8Array) || batch[0] !== 0x52 || batch[1] !== 0x4d) throw new Error("bad batch");
let threw = false;
try { rm.record("{"); } catch { threw = true; }
if (!threw) throw new Error("bad input did not throw");
console.log(`ok: ${rm.activeRules().length} active rules, findings ${rules}, batch ${batch.length} B`);

// Optional: send the batch to a running ingest (READMETER_INGEST_URL, READMETER_API_KEY).
const url = process.env.READMETER_INGEST_URL;
if (url) {
  const res = await fetch(`${url}/v1/batches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.READMETER_API_KEY}`,
      "content-type": "application/octet-stream",
    },
    body: batch,
  });
  const body = await res.text();
  if (res.status !== 202) throw new Error(`ingest answered ${res.status}: ${body}`);
  console.log(`ingest: ${res.status} ${body}`);
}
