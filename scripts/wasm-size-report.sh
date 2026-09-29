#!/usr/bin/env bash
# Bytes per crate in the production SDK wasm, before wasm-opt.
# Needs: wasm32-unknown-unknown, wasm-bindgen-cli, twiggy, python.
# Not used in CI (twiggy is not installed there).
set -euo pipefail
cd "$(dirname "$0")/.."

out=target/twiggy
mkdir -p "$out"

# v0 mangling demangles to crate[hash]:: so items can be grouped by crate.
# strip=false keeps the name section twiggy reads.
CARGO_PROFILE_RELEASE_SMALL_STRIP=false \
RUSTFLAGS="${RUSTFLAGS:-} -C symbol-mangling-version=v0" \
  cargo build -p readmeter-wasm --target wasm32-unknown-unknown --profile release-small \
  --no-default-features --features firebase,database,storage >&2

wasm-bindgen --target web --out-dir "$out" \
  target/wasm32-unknown-unknown/release-small/readmeter_wasm.wasm >&2

csv="$out/top.csv"
twiggy top -n 5000 --format csv "$out/readmeter_wasm_bg.wasm" >"$csv"

python - "$csv" <<'PY'
import csv
import re
import sys

crate_re = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\[[0-9a-fA-F]+\]::")
crates = {}
float_fmt = 0

with open(sys.argv[1], newline="") as f:
    reader = csv.DictReader(f)
    fields = reader.fieldnames or []
    if "Name" not in fields or "ShallowSize" not in fields:
        sys.stderr.write("wasm-size-report: unexpected twiggy csv header\n")
        sys.exit(1)
    for row in reader:
        name = row["Name"]
        if "custom section" in name or "function names" in name or "function-names" in name:
            continue
        size = int(row["ShallowSize"])
        if "flt2dec" in name or "float" in name:
            float_fmt += size
        if "serde_json" in name:
            crate = "serde_json"
        else:
            match = crate_re.search(name)
            if match is None:
                continue
            crate = match.group(1)
        crates[crate] = crates.get(crate, 0) + size

for crate, size in sorted(crates.items(), key=lambda kv: (-kv[1], kv[0])):
    print(f"{size} {crate}")
print(f"{float_fmt} float-fmt")
PY
