#!/usr/bin/env bash
# Builds the server-side core (decode + window and aggregate rules) for the TypeScript
# backend into apps/ingest/wasm. No size budget: this never ships to customers.
# Needs: rustup target add wasm32-unknown-unknown; wasm-bindgen-cli (Cargo.lock version).
set -euo pipefail

OUT=${OUT:-apps/ingest/wasm}

cd "$(dirname "$0")/.."
cargo build -p readmeter-wasm-server --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir "$OUT" \
  target/wasm32-unknown-unknown/release/readmeter_wasm_server.wasm
echo "built $OUT/readmeter_wasm_server_bg.wasm ($(wc -c < "$OUT/readmeter_wasm_server_bg.wasm") B)"
