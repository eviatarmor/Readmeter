#!/usr/bin/env bash
# Builds the static library and runs the C smoke test against it.
# Uses $CC (default: cc). On Windows run it from a VS developer shell with CC=cl.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build -p readmeter-ffi --release
cargo run -q -p readmeter-rules --features catalog-toml --bin readmeter-rulec -- build rules target/rules >/dev/null
out=target/ffi-smoke
mkdir -p "$out"
src=crates/bindings/ffi/tests/c/smoke.c
inc=crates/bindings/ffi/include
CC=${CC:-cc}
if [ "$CC" = "cl" ]; then
  cl /nologo /I"$inc" "$src" target/release/readmeter_ffi.lib \
    ws2_32.lib userenv.lib ntdll.lib bcrypt.lib advapi32.lib /Fe"$out/smoke.exe" /Fo"$out/"
  "$out/smoke.exe" target/rules/bundle.bin
else
  "$CC" -I"$inc" "$src" target/release/libreadmeter_ffi.a -lpthread -ldl -lm -o "$out/smoke"
  "$out/smoke" target/rules/bundle.bin
fi
