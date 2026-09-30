// Check the actual tarball, including assets which TypeScript cannot validate.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tarball = process.argv[2];
assert.ok(tarball, "Pass the SDK tarball path");
const files = new Set(execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split(/\r?\n/u));
const pkg = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
assert.equal(pkg.license, "MIT");
assert.equal(pkg.private, undefined);
for (const entry of Object.values(pkg.exports)) {
  for (const path of Object.values(entry)) assert.ok(files.has(`package/${path.slice(2)}`), `Missing export ${path}`);
}
for (const kind of ["prod", "dev"]) {
  for (const file of ["readmeter_wasm.js", "readmeter_wasm_bg.wasm", "inline.js"]) {
    assert.ok(files.has(`package/wasm/${kind}/${file}`), `Missing ${kind}/${file}`);
  }
}
assert.ok(files.has("package/bundle/bundle.bin"));
assert.equal(execFileSync("tar", ["-xOf", tarball, "package/LICENSE.md"], { encoding: "utf8" }),
  readFileSync(new URL("../LICENSE.md", import.meta.url), "utf8"));
assert.ok(![...files].some((file) => /(?:^|\/)(?:node_modules|test|src|\.env)(?:\/|$)/u.test(file)));
console.log(`Verified ${pkg.name}@${pkg.version}: exports, wasm, rules, and MIT license`);
