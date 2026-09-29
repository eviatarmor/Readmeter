# 0002: Rust core

Status: in progress. Last updated 2026-09-29.

## Crates

| Crate | Role | Depends on |
|---|---|---|
| `readmeter-core` | `Envelope`, `Op`, `Target`, `QueryShape`, `ResultStats`, `ResultUsage`, `Finding`, `Severity`, `Units`, `VecMap`, `KeyedHasher`, `Buffer`, `Sampler`, `Batch` wire format | serde, postcard, siphasher |
| `readmeter-rules` | `RuleDef`, `RuleSpec`, `Catalog`, `Bundle`, `RuleConfig`/overrides, `Params`, `Detector`, `Registry`, `Engine` (scope match + cooldown), `window` helpers, generic detectors (window ones behind feature `window`), `readmeter-rulec` bin | core |
| `readmeter-provider-api` | `Provider` trait, `NormalizeContext`, `JsonValue`, canonical `hash_json` | core, rules, serde_json |
| `readmeter-provider-firebase` | Firestore raw schema, normalization (templates, id shapes, keys, fingerprints), billing units, Firestore detectors | provider-api |
| `readmeter-cost` | `PriceTable` from `pricing/*.toml`, `estimate()` | core, toml |
| `readmeter-runtime` | `Client`: normalize, local engine, sampling, buffer, flush; `provider_by_id` | all of the above except cost |
| `readmeter-ffi` | C ABI: `rm_client_new/record/flush/free`, `rm_buf_free`, `rm_last_error` | runtime |
| `readmeter-wasm` | `Readmeter` class: `new`, `record`, `flush`, `activeRules` | runtime |
| `readmeter-evaluator` | Server side: `Evaluator::ingest` (decode, limits, window rules per project) returning JSON-safe rows (`rows.rs`, hashes as hex) | core, rules, provider-api, providers |
| `readmeter-wasm-server` | wasm-bindgen `Evaluator` class for the TypeScript ingest (`new(bundle, maxEvents, maxFindings)`, `ingest(project, bytes)`) | evaluator |

The core is a library, never a service (see D16 in 0001). Backend
services are TypeScript and call it through `readmeter-wasm-server`.

## Data flow in the client

1. Shim builds raw-call JSON (see `providers/firebase/src/firestore/raw.rs`).
2. `Provider::normalize` parses it, templates the path, classifies the id,
   hashes path + filter values + paging into `target.key`, hashes without
   paging into `query.base_key`, hashes the value-free shape into
   `query.fingerprint`, hashes the callsite, computes `Units`.
3. `Engine::observe` runs every enabled rule whose scope matches, then
   throttles repeats (same rule + session + callsite/template within
   `cooldown_ms`).
4. Event goes to the buffer if the session is sampled; findings always do.
5. `flush(now)` returns `RM` + version + postcard bytes for the host to POST.

## Raw-call contract for shims (Firestore)

Required: `service`, `op`, `ts_ms`, `path`. Optional: `collection_group`,
`query` (filters with values, order_by, limit, limit_to_last, offset,
start/end cursor values, select, aggregations), `result` (docs, bytes,
from_cache, index_entries), `commit`, `initial` (snapshots), `usage`
(for `op: "usage"`), `error`, `duration_us`, `call_id`, `callsite`,
`listener`, `mount`, `attempt`. Unknown fields are ignored.

Shim duties the core cannot do itself:
- Send `query` on `subscribe` and `snapshot` events too, so listener rules see the shape.
- Report `usage` after a result is consumed (proxy `size`/`empty`/`docs`
  access on the snapshot) for `count-via-fetch` and
  `emptiness-check-without-limit`.
- Send stable `listener` ids and `call_id`s, and `callsite` where the
  language can get it cheaply (stack in dev, build-time transform in prod).

## Done

- [x] Workspace, lints (`unwrap`/`expect`/`panic` denied, `unsafe` only in ffi), `release-small` profile
- [x] Core types, keyed hashing with framing, buffer with drop-oldest, session sampler, wire encode/decode
- [x] Rule model, TOML catalog loader with id/scope validation, overrides with param type checks
- [x] Engine with scope matching, evaluation filter, cooldown dedupe, `unavailable()` report
- [x] Bounded window helpers
- [x] 9 generic detectors, 10 Firestore detectors, all with tests
- [x] Firestore normalization + billing with leak test
- [x] Runtime client, JSON config (64-bit ids accepted as strings for JS)
- [x] C ABI with panic guard and thread-local errors; wasm-bindgen wrapper
- [x] End-to-end tests over the real `rules/` catalog: every detector has a TOML, every enabled non-aggregate rule has a detector
- [x] Pricing table format + Firestore table (unverified numbers)

- [x] Slim SDK bundle: `RuleSpec` (id, scope, severity, evaluation, status, params) instead of full `RuleDef`; bundle 4.7 KB vs catalog 25 KB
- [x] `readmeter-rulec` (`check`, `build` -> `catalog.json` + `bundle.json`, content-hash revision)
- [x] Conformance fixtures (7 Firestore scenarios) + Rust runner (`crates/runtime/tests/conformance.rs`)
- [x] `window` cargo feature: production SDK builds carry only local detectors
- [x] `cbindgen` header (`crates/bindings/ffi/include/readmeter.h`) + C smoke test (`scripts/smoke-ffi.sh`, passes with MSVC)
- [x] wasm build pipeline (`scripts/build-wasm.sh`: wasm-bindgen + wasm-opt, gzip size gate) + Node smoke test
- [x] Robustness tests: 20k mutated batches into `Batch::decode`; hostile raw calls (overflow, deep nesting, bad UTF-16) into `normalize`
- [x] `crates/evaluator`: window rules per project, bounded project count, `ingest()` with limits and JSON-safe rows
- [x] `crates/bindings/wasm-server` + `scripts/build-wasm-server.sh` for the TypeScript backend
- [x] Replaced the Rust `apps/ingest` with TypeScript (Hono + Drizzle + Postgres, see 0005); verified live: wasm SDK in Node, ingest, rows in Postgres
- [x] CI workflow: fmt, clippy (all features + production feature set), tests, rule check, wasm size gate + smoke, header drift, C smoke
- [x] Binary bundle (`bundle.bin`) for SDKs
- [x] SDK JSON reader (`readmeter_provider_api::json`)
- [x] No `serde_json` on the SDK path

## Wasm size

Production SDK (`firebase`, no `window`), after `wasm-opt -Oz`, gzip -9:

| Step | Raw | Gzip |
|---|---|---|
| Baseline (`release-small`, no wasm-opt) | 367 KB | 124 KB |
| wasm-bindgen + wasm-opt | 281 KB | 115 KB |
| Window detectors behind a feature | 241 KB | 100 KB |
| No `#[serde(untagged)]` on the SDK path | 239 KB | 98.7 KB |
| `VecMap` instead of `BTreeMap` | 222 KB | 93.6 KB |
| `JsonValue` instead of `serde_json::Value` | 214 KB | 90.0 KB |
| Small cleanups | 213 KB | **89.3 KB** |
| Binary bundle (B2) | 207 KB | 89.2 KB |
| SDK JSON reader + finding JSON (B3+B4) | 141.2 KB (144,629 B) | 68.7 KB (70,338 B) |
| No `serde_json` on the SDK path (B5) | 141.2 KB (144,629 B) | 68.7 KB (70,338 B) |

B5 did not change the linked binary: `serde_json` was already gone once the
SDK stopped calling it, and `float-fmt` was 448 B. Dev build (with window
rules) is reported by the dev-size check. The CI gate is 70,656 B (69 KiB).

Target reached; keep the ratchet.

## Next

- [x] Wasm size under 80 KiB (Task B: 70.3 KB gzip; gate ratchets at 69 KiB)
- [ ] Rule bundle signing (ed25519) and CDN publishing; SDKs verify before use
- [ ] Evaluator: per-project rule overrides (from Postgres, set by console-api)
- [ ] Verify Firestore prices and set `checked_on`; verify every `docs` URL in `rules/`
- [ ] Aggregate-rule engine for the backend (`generic/hot-callsite`, `firebase.firestore/multi-client-write-hotspot`), likely as SQL over `events` in Postgres
- [ ] Init event from shims (SDK settings) to unlock `firebase.firestore/persistence-disabled`
- [ ] Reconnect signal from shims to unlock `firebase.firestore/listener-reconnect-rebill`
- [ ] First SDK shim: `@readmeter/firebase` (web modular SDK) against `conformance/fixtures`

## Known limits

- `write-hotspot` sees one session; the cross-client version is an aggregate rule.
- `n-plus-one` cannot link the reads to the list that caused them; it
  detects the burst. Linking needs callsite parent info from shims.
- `count-via-fetch` and `emptiness-check-without-limit` depend on shims
  reporting `usage`; without it they never fire.
- The evaluator keeps one engine per project in the ingest process;
  detectors key state by session. With more than one ingest instance, one
  project's batches must reach the same instance (route by API key), or
  window rules miss patterns split across instances. State is lost on
  restart (only in-flight windows).
- Dev SDK builds may run window rules locally, so the evaluator can
  re-report the same finding; storage dedupes.
- `Batch::decode` accepts exactly `SCHEMA_VERSION` 1; the first schema bump
  must add a decoder for the old version before shipping.
