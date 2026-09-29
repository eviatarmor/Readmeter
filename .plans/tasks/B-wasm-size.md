# Task B: Production SDK wasm to 80 KiB gzip

Planner: Claude. Executor: Grok. Status: done 2026-09-29 (70,338 B gzip, reviewed).

Today: 90,379 B gzip (budget 92,160 = 90 KiB). Target: **81,920 B (80 KiB) or
less**. Batch B rules add local detectors to the production build, so this
headroom is needed first.

## Where the bytes are (planner measurement, before wasm-opt)

Production build (`--no-default-features --features firebase`), 270 KB raw,
attributed by crate with `twiggy`:

| Share | What | Why it is there |
|---|---|---|
| ~95 KB | `serde_json` | Deserializers for `ClientConfig`, `Bundle`/`RuleSpec`/`ParamValue`, `RawCall` (+ nested raw types), `JsonValue`; `record_json` serializer; error formatting |
| ~48 KB | `core` (much of it `core::fmt`) | Formatting machinery; float formatting alone ~18 KB (`flt2dec` dragon/grisu) |
| ~30 KB | `alloc` | Strings, vecs, `format!` |
| ~27 KB | `.rodata` | String constants (messages, error text, panic locations) |
| ~10 KB | `readmeter_provider_firebase` | normalize + local detectors |
| rest | core/rules/runtime/dlmalloc/hashbrown/postcard/wasm-bindgen | |

**Strategy: no `serde_json` and no float formatting on the SDK path.**
`serde` + `postcard` stay (wire format). The backend (`evaluator`,
`wasm-server`, `rulec`) keeps `serde_json`.

## 0. Read first (mandatory)

1. `AGENTS.md` (all). Rules 1, 2, 6 and 8 matter most here.
2. `.plans/0002-rust-core.md` ("Wasm size").
3. `crates/runtime/src/{lib.rs,config.rs}`, `crates/bindings/{wasm,ffi}/src/lib.rs`,
   `crates/rules/src/{def.rs,catalog.rs,config.rs}`, `crates/rules/src/bin/readmeter-rulec.rs`,
   `crates/provider-api/src/{lib.rs,json.rs}`, `crates/providers/firebase/src/firestore/{raw.rs,normalize.rs}`,
   `scripts/{build-wasm.sh,smoke-wasm.mjs,smoke-ffi.sh}`, `crates/bindings/ffi/tests/c/smoke.c`,
   `apps/ingest/test/helpers.ts`, `.github/workflows/ci.yml`.

## Hard constraints

- **Behavior must not change.** Same envelopes, same `target.key`/`base_key`/
  `fingerprint` hashes, same units, same findings for the same input. The
  conformance fixtures and every existing test must pass unchanged, except
  for call-site changes this brief lists (constructor arguments, bundle format).
- No new third-party dependencies. Hand-written code only, small and tested.
- Library code must not panic on any input (AGENTS rule 2). Recursion must
  be depth-limited.
- Do not touch rule TOMLs, detector logic, the wire format of `Batch`, or
  the Postgres schema.
- Never raise `BUDGET_GZIP`. Lowering it is part of step B6.

Work in two parts. **Stop and report after part 1** (B1 to B2); the planner
reviews before part 2 (B3 to B6).

## Part 1

### B1. Size report tool

Add `scripts/wasm-size-report.sh`:
- Builds the production wasm into `target/twiggy` with
  `CARGO_PROFILE_RELEASE_SMALL_STRIP=false`, runs `twiggy top -n 5000 --format csv`,
  and prints bytes per crate (group by the first `crate[hash]::` in the item
  name; a name containing `serde_json` counts as `serde_json`), plus a
  `float-fmt` line (items containing `flt2dec` or `float`). Custom sections
  and the function-names subsection are excluded.
- Use `python` (available) or `node` for the grouping; no new tools besides `twiggy`.
- Prints nothing else; exits 0. Not wired into CI (twiggy is not installed there).

Run it now and include its output in the report as the "before" column.

### B2. Binary rule bundle for SDKs

SDKs stop parsing JSON bundles.

- In `crates/rules`: `Bundle::encode(&self) -> Result<Vec<u8>, BundleError>` and
  `Bundle::decode(&[u8]) -> Result<Bundle, BundleError>`. Format: magic `b"RB"`,
  `u16` LE `BUNDLE_VERSION = 1`, then postcard. Same header style as
  `readmeter_core::wire` (look at it and match its error handling:
  truncated / bad magic / unsupported version / codec).
- `ParamValue` currently has a hand-written `Deserialize` using
  `deserialize_any`, which postcard cannot decode. Do **not** change the JSON
  shape. Instead encode through private mirror types used only by
  `encode/decode` (`enum BinParam { Bool(bool), Int(i64), Float(f64), Str(String) }`,
  one variant per `ParamValue` variant, and a `BinSpec`/`BinBundle`
  with derived `Serialize/Deserialize`), converting to/from the public types.
- `decode` must run `Bundle::validate()` before returning.
- Tests: round trip of the real catalog bundle (`Catalog::load_dir("rules")` in
  a test with the `catalog-toml` feature, like existing tests); truncated,
  bad magic, wrong version, and 20k mutated inputs never panic (copy the
  approach of `mutated_input_never_panics` in `core/src/wire.rs`).
- `readmeter-rulec build` also writes `bundle.bin` next to `bundle.json` (same revision).
- `readmeter-runtime`: replace `Client::from_json(config_json, bundle_json)` with
  `Client::from_bytes(config_json: &[u8], bundle: &[u8])` where `bundle` is
  `bundle.bin`. Keep `Client::new(config, provider, &Bundle)` as is.
- Bindings:
  - wasm: `new Readmeter(configJson: string, bundle: Uint8Array)`; update the module doc comment.
  - ffi: `rm_client_new(config_json, config_len, bundle, bundle_len, out)`: rename the parameter to `bundle`, document it as `bundle.bin` bytes; regenerate `include/readmeter.h` with cbindgen (command in AGENTS.md); update `tests/c/smoke.c` and the ffi Rust tests to pass binary bundles.
- Callers to update: `crates/runtime/tests/{end_to_end.rs,conformance.rs}`,
  `crates/evaluator/src/lib.rs` tests, `crates/bindings/ffi` tests,
  `scripts/smoke-wasm.mjs` (read `target/rules/bundle.bin`),
  `apps/ingest/test/helpers.ts` (SDK side reads `bundle.bin`; the server core
  still receives `bundle.json`), `scripts/smoke-ffi.sh` if it references the bundle.
- The evaluator, `wasm-server` and ingest keep JSON bundles. Do not change them
  beyond tests.

Checks for part 1: section "Checks" below, all of them, plus the C smoke
test (`./scripts/smoke-ffi.sh`; on Windows it needs `CC=cl` from a VS
developer shell; if you cannot get a compiler, say so in the report instead of skipping silently).

Report: B1 output, new gzip size, check results.

## Part 2

### B3. Small JSON reader on the SDK path

- In `crates/provider-api/src/json.rs`: `pub fn parse(input: &[u8]) -> Result<JsonValue, JsonError>`.
  - RFC 8259 JSON. Max nesting depth 64 (`JsonError::TooDeep`). Rejects
    trailing garbage, invalid UTF-8, bad escapes, lone surrogates.
  - Numbers: an integer literal (no `.`/`e`) that fits `u64` is `Uint`,
    a negative one that fits `i64` is `Int`; anything else is `Float` via
    `str::parse::<f64>` (reject non-finite). This must match what the current
    `JsonValue` serde visitor produces for the same text, because it feeds
    `hash_json` and therefore `target.key`.
  - Objects keep key order as written; duplicate keys: last one wins (serde_json behavior).
  - `JsonError` is a small enum with a static description and a byte offset. No `format!` of floats.
- Equivalence test (keeps hashes stable): for every raw call in
  `conformance/fixtures/**/*.json`, every string in the existing hostile-input
  tests, and a set of edge cases (escapes, `\u` surrogate pairs, `-0`,
  `1e3`, `18446744073709551615`, `18446744073709551616`, `-9223372036854775808`,
  deep nesting 64/65, empty containers, unicode keys), `parse(x)` equals the
  current serde-based `JsonValue` deserialization (or both are errors). Keep
  the serde `Deserialize` impl of `JsonValue` for this test and for the
  backend, behind a `serde` cargo feature of `readmeter-provider-api`
  (default off; the evaluator and dev-dependencies enable it).
- Typed extraction instead of serde derives:
  - `crates/providers/firebase/src/firestore/raw.rs`: replace
    `#[derive(Deserialize)]` on the raw types with `RawCall::from_json(&JsonValue) -> Result<RawCall, NormalizeError>`
    (and helpers per nested type). Same field names, same defaults (`attempt`
    defaults to 1, missing = default), unknown fields ignored, wrong types
    are errors. `normalize` calls `json::parse` then `RawCall::from_json`.
  - `crates/runtime/src/config.rs`: `ClientConfig::from_json(&JsonValue)`,
    same fields and defaults, **unknown fields rejected** (today it is
    `deny_unknown_fields`), 64-bit values accept numbers or decimal strings
    (today's `u64_flexible`), `sample_rate` must be within `0..=1`.
  - Put small shared helpers (`get_str`, `get_u64`, `get_bool`, ...) in `json.rs` so both use them.
- Tests: every existing normalize and config test passes; add tests for
  wrong types, unknown config field, `session` as string and number.

### B4. Findings returned by `record`

- `Client::record_json` returns a JSON array written by a small hand-written
  writer (in `runtime`, with string escaping), containing per finding only:
  `rule`, `severity`, `template`, `message`, `wasted` (object of unit ->
  integer). `evidence` is **not** included locally; it still goes in the
  batch (postcard). No floats are written.
- Update the wasm and ffi doc comments to say exactly which fields are returned.
- Test: output parses with serde_json (dev-dependency) and has exactly those fields; escaping of quotes, backslashes, control chars and non-ASCII.

### B5. Remove what is left

- Remove `serde_json` from `[dependencies]` of `readmeter-runtime`,
  `readmeter-provider-api` (unless behind the `serde` feature),
  `readmeter-provider-firebase`, `readmeter-rules` (it is already optional
  behind `catalog-toml`; keep that), `readmeter-core`. It may stay in
  `[dev-dependencies]` anywhere and in `[dependencies]` of `evaluator`,
  `wasm-server`, and the `rulec` bin.
- Gate (add to `scripts/build-wasm.sh`, before building): 
  `cargo tree -p readmeter-wasm --no-default-features --features "$FEATURES" -e normal`
  must not contain `serde_json`; fail with a clear message if it does.
- Run `scripts/wasm-size-report.sh`. If `float-fmt` is still above ~2 KB,
  find the callers (`twiggy paths <wasm> <item>`) and remove float formatting
  from the SDK path: typically `{}` of an `f64` in a local detector message
  or an error `Display`. Replace with integer formatting (for ratios, format
  as a percentage integer or per-mille). Do not change any detector's
  decision logic; message text may change only in how a number is printed,
  and tests asserting that message must be updated to match.
- Also look for other large items in the report that are clearly on the
  error path (e.g. `Debug` impls reached only through error formatting) and
  report them; change them only if the change is local and obviously safe.

### B6. Ratchet and docs

- Lower `BUDGET_GZIP` in `scripts/build-wasm.sh` to the new gzip size
  rounded **up** to the next multiple of 1024. If it is at or below 81,920,
  set it to the rounded value and note "target reached" in the comment.
- `.plans/0002-rust-core.md`, "Wasm size": add rows to the size table for
  B2, B3+B4, B5 (raw and gzip), replace the options list with what is left
  (if the target is reached: "Target reached; keep the ratchet"), and add
  to "Done": binary bundle, SDK JSON reader, no serde_json on the SDK path.
- `AGENTS.md`, rule 6: replace the sentence listing `serde_json::Value` with:
  "On the SDK path there is no `serde_json` (the build script checks); parse
  JSON with `readmeter_provider_api::json` and write it by hand. Avoid
  `BTreeMap` (use `readmeter_core::VecMap`), `#[serde(untagged)]`, and
  formatting floats." Keep the rest of rule 6.
- `AGENTS.md`, Commands: add `./scripts/wasm-size-report.sh` with a one-line comment.
- Nothing else in `.plans/` or `AGENTS.md`.

## Checks (after each part; all must pass)

```sh
cargo fmt --all
cargo clippy --workspace --all-features --all-targets -- -D warnings
cargo clippy -p readmeter-wasm -p readmeter-ffi --no-default-features --features firebase -- -D warnings
cargo test --workspace --all-features
cargo run -q -p readmeter-rules --features catalog-toml --bin readmeter-rulec -- check rules
cargo run -q -p readmeter-rules --features catalog-toml --bin readmeter-rulec -- build rules target/rules
./scripts/build-wasm.sh && node scripts/smoke-wasm.mjs
FEATURES=firebase,window OUT=target/wasm-pkg-dev BUDGET_GZIP=999999999 ./scripts/build-wasm.sh
./scripts/build-wasm-server.sh
pnpm typecheck && pnpm test      # with DATABASE_URL=postgres://readmeter:readmeter@127.0.0.1:5442/readmeter (docker compose up -d --wait postgres)
./scripts/smoke-ffi.sh           # see B2 note about the C compiler
```

CI (`.github/workflows/ci.yml`) must keep working: if a job's commands
change (bundle.bin, new gate), update the workflow in the same change.

## Report (after each part)

1. What changed (files), in two or three lines per step.
2. Size table: raw and gzip after each step you finished, plus the size-report output.
3. Check results, one line per command.
4. Anything not done as specified, and why. Do not work around the brief; report.
