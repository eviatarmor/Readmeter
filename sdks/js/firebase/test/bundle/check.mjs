import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const dist = fileURLToPath(new URL("./dist", import.meta.url));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(dist);
const wasms = files.filter((file) => file.endsWith(".wasm"));
assert.equal(wasms.length, 0, `expected no wasm assets, got ${wasms.join(", ")}`);

const prodB64 = readFileSync(fileURLToPath(new URL("../../wasm/prod/readmeter_wasm_bg.wasm", import.meta.url))).toString("base64");
const devB64 = readFileSync(fileURLToPath(new URL("../../wasm/dev/readmeter_wasm_bg.wasm", import.meta.url))).toString("base64");
assert.notEqual(prodB64, devB64);

const htmlFile = files.find((file) => file.endsWith(".html"));
assert.ok(htmlFile, "bundle index.html");
const html = readFileSync(htmlFile, "utf8");
const entry = html.match(/src="([^"]+\.js)"/);
assert.ok(entry, "entry script in index.html");
const entryBase = entry[1].split("/").pop();
const jsFiles = files.filter((file) => file.endsWith(".js"));

function chunksWith(encoded) {
  return jsFiles.filter((file) => {
    const base = file.split(/[/\\]/).pop();
    if (base === entryBase) return false;
    return readFileSync(file, "utf8").includes(encoded);
  });
}

const prodChunks = chunksWith(prodB64);
const devChunks = chunksWith(devB64);
assert.equal(prodChunks.length, 1, `expected one prod inline chunk, got ${prodChunks.join(", ")}`);
assert.equal(devChunks.length, 1, `expected one dev inline chunk, got ${devChunks.join(", ")}`);
assert.notEqual(prodChunks[0], devChunks[0], "prod and dev inline wasm must be separate chunks");

const prodName = prodChunks[0].split(/[/\\]/).pop();
const devName = devChunks[0].split(/[/\\]/).pop();
const gzip = gzipSync(readFileSync(prodChunks[0])).length;
console.log(`bundle ok: no wasm assets; prod inline chunk ${prodName} gzip ${gzip}; dev inline chunk ${devName}`);
