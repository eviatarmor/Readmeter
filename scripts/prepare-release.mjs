// Validate the tag before spending time building or publishing artifacts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tag = process.argv[2];
const pkg = JSON.parse(readFileSync(new URL("../sdks/js/firebase/package.json", import.meta.url)));
assert.match(tag ?? "", /^v\d+\.\d+\.\d+$/u, "Release tags must be stable versions such as v0.1.0");
assert.equal(tag, `v${pkg.version}`, "Tag must match the Firebase SDK package version");
const source = readFileSync(new URL("../sdks/js/firebase/src/version.ts", import.meta.url), "utf8");
assert.equal(source.match(/SDK_VERSION = "([^"]+)"/u)?.[1], pkg.version, "SDK telemetry version must match package.json");
assert.equal(pkg.license, "MIT");
assert.equal(pkg.publishConfig.access, "public");
console.log(`Releasing ${pkg.name}@${pkg.version}`);
