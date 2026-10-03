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

// @readmeter/react ships in lockstep with @readmeter/firebase.
const react = JSON.parse(readFileSync(new URL("../sdks/js/react/package.json", import.meta.url)));
assert.equal(react.version, pkg.version, "@readmeter/react version must match @readmeter/firebase");
assert.equal(react.peerDependencies["@readmeter/firebase"], `^${pkg.version}`, "@readmeter/react must peer-depend on this release");
assert.equal(react.license, "MIT");
assert.equal(react.publishConfig.access, "public");
console.log(`Releasing ${pkg.name}@${pkg.version} and ${react.name}@${react.version}`);
