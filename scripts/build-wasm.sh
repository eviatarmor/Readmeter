#!/usr/bin/env bash
# Builds the SDK wasm artifact and reports its size against the budget.
# Needs: rustup target add wasm32-unknown-unknown; cargo install wasm-bindgen-cli
# (same version as Cargo.lock); Node (wasm-opt comes from the npm `binaryen` package).
set -euo pipefail

# Ratchet: lower this whenever the build shrinks. Raised for the three local
# batch B rules (measured gzip 75,730 B, rounded up to the next 256).
BUDGET_GZIP=${BUDGET_GZIP:-75776}
OUT=${OUT:-target/wasm-pkg}
FEATURES=${FEATURES:-firebase}

cd "$(dirname "$0")/.."

# serde_json's deserializers and error path (float formatting) dominate the
# SDK binary. Parsing and writing JSON on this path is hand-written.
tree=$(cargo tree -p readmeter-wasm --no-default-features --features "$FEATURES" -e normal)
if [[ "$tree" == *serde_json* ]]; then
  echo "error: serde_json is in the SDK wasm dependency tree (features: $FEATURES)" >&2
  printf '%s\n' "$tree" >&2
  exit 1
fi

cargo build -p readmeter-wasm --target wasm32-unknown-unknown --profile release-small \
  --no-default-features --features "$FEATURES"
wasm-bindgen --target web --out-dir "$OUT" \
  target/wasm32-unknown-unknown/release-small/readmeter_wasm.wasm
npx -y -p binaryen@latest wasm-opt -Oz --strip-debug --strip-producers \
  --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  "$OUT/readmeter_wasm_bg.wasm" -o "$OUT/readmeter_wasm_bg.wasm"

raw=$(wc -c < "$OUT/readmeter_wasm_bg.wasm")
gz=$(gzip -9 -c "$OUT/readmeter_wasm_bg.wasm" | wc -c)
echo "readmeter_wasm_bg.wasm: raw ${raw} B, gzip ${gz} B (budget ${BUDGET_GZIP} B)"
if [ "$gz" -gt "$BUDGET_GZIP" ]; then
  echo "over budget by $((gz - BUDGET_GZIP)) B" >&2
  exit 1
fi
