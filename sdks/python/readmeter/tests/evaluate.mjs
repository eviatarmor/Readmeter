// Decodes Python-flushed batches with the server core (bindings/wasm-server),
// the same code ingest runs. stdin: {wasm_dir, bundle_json, batches: [base64]}.
// stdout: [{events: [{op, template, units}]} | {error}] in batch order.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const input = JSON.parse(readFileSync(0, "utf8"));
const mod = await import(pathToFileURL(path.join(input.wasm_dir, "readmeter_wasm_server.js")).href);
mod.initSync({ module: readFileSync(path.join(input.wasm_dir, "readmeter_wasm_server_bg.wasm")) });
const evaluator = new mod.Evaluator(readFileSync(input.bundle_json, "utf8"), 10000, 1000);

const out = input.batches.map((b64, i) => {
  try {
    const got = JSON.parse(evaluator.ingest(`py-${i}`, Buffer.from(b64, "base64"), "0", "{}"));
    return { events: got.events.map((e) => ({ op: e.op, template: e.template, units: e.units })) };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
});
process.stdout.write(JSON.stringify(out));
