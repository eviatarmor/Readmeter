#!/usr/bin/env bash
# Prod + dev SDK wasm, the default rule bundle, then tsc to dist/.
# Run from anywhere: bash sdks/js/firebase/scripts/build.sh
set -euo pipefail

root=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$root"

mkdir -p sdks/js/firebase/wasm/prod sdks/js/firebase/wasm/dev sdks/js/firebase/bundle

OUT=sdks/js/firebase/wasm/prod FEATURES=firebase,database,storage ./scripts/build-wasm.sh
OUT=sdks/js/firebase/wasm/dev FEATURES=firebase,database,storage,window BUDGET_GZIP=999999999 ./scripts/build-wasm.sh

cargo run -q -p readmeter-rules --features catalog-toml --bin readmeter-rulec -- build rules target/rules
cp target/rules/bundle.bin sdks/js/firebase/bundle/bundle.bin

cd sdks/js/firebase
# Browser builds load base64 from inline.js. The glue's wasm URL is an asset
# trigger for Vite, and pre-bundling breaks it, so the default init path throws.
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";

const needle = "module_or_path = new URL('readmeter_wasm_bg.wasm', import.meta.url);";
const replacement = 'throw new Error("call initSync with module bytes");';

for (const kind of ["prod", "dev"]) {
  const wasm = readFileSync(`wasm/${kind}/readmeter_wasm_bg.wasm`);
  writeFileSync(`wasm/${kind}/inline.js`, `export default ${JSON.stringify(wasm.toString("base64"))};\n`);
  const gluePath = `wasm/${kind}/readmeter_wasm.js`;
  const glue = readFileSync(gluePath, "utf8");
  if (!glue.includes(needle)) {
    console.error(`glue wasm URL missing in ${gluePath}`);
    process.exit(1);
  }
  if (glue.split(needle).length !== 2) {
    console.error(`glue wasm URL appears more than once in ${gluePath}`);
    process.exit(1);
  }
  writeFileSync(gluePath, glue.replace(needle, replacement));
}
EOF
pnpm exec tsc -p tsconfig.build.json
