// Check the actual tarball, including assets which TypeScript cannot validate.
// Usage: node scripts/check-sdk-package.mjs <tarball> [<tarball> ...]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tarballs = process.argv.slice(2);
assert.ok(tarballs.length > 0, "Pass at least one SDK tarball path");
const license = readFileSync(new URL("../LICENSE.md", import.meta.url), "utf8");
const firebase = JSON.parse(readFileSync(new URL("../sdks/js/firebase/package.json", import.meta.url), "utf8"));

for (const tarball of tarballs) {
  const files = new Set(execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split(/\r?\n/u));
  const pkg = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.private, undefined);
  for (const entry of Object.values(pkg.exports)) {
    for (const path of typeof entry === "string" ? [entry] : Object.values(entry)) assert.ok(files.has(`package/${path.slice(2)}`), `Missing export ${path}`);
  }
  if (pkg.name === "@readmeter/firebase") {
    for (const kind of ["prod", "dev"]) {
      for (const file of ["readmeter_wasm.js", "readmeter_wasm_bg.wasm", "inline.js"]) {
        assert.ok(files.has(`package/wasm/${kind}/${file}`), `Missing ${kind}/${file}`);
      }
    }
    assert.ok(files.has("package/bundle/bundle.bin"));
  } else if (pkg.name === "@readmeter/react") {
    assert.equal(pkg.version, firebase.version, "@readmeter/react is released in lockstep with @readmeter/firebase");
    assert.equal(pkg.peerDependencies?.["@readmeter/firebase"], `^${firebase.version}`);
    assert.ok(!JSON.stringify(pkg).includes("workspace:"), "workspace: protocol left in the published manifest");
  } else {
    assert.fail(`Unexpected package ${pkg.name}`);
  }
  assert.equal(execFileSync("tar", ["-xOf", tarball, "package/LICENSE.md"], { encoding: "utf8" }), license);
  assert.ok(![...files].some((file) => /(?:^|\/)(?:node_modules|test|src|\.env)(?:\/|$)/u.test(file)));
  console.log(`Verified ${pkg.name}@${pkg.version}: exports, assets, and MIT license`);
}
