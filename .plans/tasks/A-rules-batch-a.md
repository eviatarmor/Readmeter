# Task A: Rule batch A (17 rules, no new signals)

Planner: Claude. Executor: Grok. Status: done 2026-09-29 (all three groups reviewed).

Implement 17 new rules (TOML + Rust detector + tests + conformance fixture)
and one change to an existing detector. Everything needed is already in
the envelope; **do not change `crates/core`, the raw-call schema,
`normalize.rs`, `billing.rs`, the wire format, or any budget/limit.**

Work in three groups, in order (group 3 has 6 rules after the planner review: 4.1 to 4.6). Finish a group (all checks green), then
start the next. Stop and report after each group; the planner reviews before
you continue.

## 0. Read first (mandatory)

1. `AGENTS.md` (all of it; "Rules you must not break" and "Adding a rule" apply to every step).
2. `.plans/0003-rule-catalog.md` (severity model, batch A table).
3. Existing examples to copy, per kind:
   - Local Firestore detector: `crates/providers/firebase/src/firestore/detectors/offset_pagination.rs`, `unbounded_list.rs`
   - Window Firestore detector: `.../detectors/write_hotspot.rs`, `missing_cursor.rs`
   - Generic window detectors: `crates/rules/src/detectors/duplicate_read.rs`, `listener_leak.rs`, `polling.rs`
   - Registration: `crates/providers/firebase/src/firestore/detectors/mod.rs`, `crates/rules/src/detectors/mod.rs`
   - TOML: `rules/firebase/firestore/write-hotspot.toml`, `rules/generic/polling-instead-of-subscription.toml`
   - Helpers: `crates/rules/src/window.rs` (`KeyedWindow`, `BoundedMap`), `crates/rules/src/testing.rs` (`EnvBuilder`, `single_rule_engine`, `run`, `int`, `float`)
   - Envelope: `crates/core/src/envelope.rs`; billing: `crates/providers/firebase/src/firestore/billing.rs`
   - Fixtures: `conformance/README.md`, `conformance/fixtures/firebase/firestore/count-via-fetch.json`
   - Raw-call schema (for fixtures): `crates/providers/firebase/src/firestore/raw.rs`

## 1. Conventions (apply to every rule)

**Files.** For rule `firebase.firestore/<name>`:
- `rules/firebase/firestore/<name>.toml`
- `crates/providers/firebase/src/firestore/detectors/<name_with_underscores>.rs`
- register in `crates/providers/firebase/src/firestore/detectors/mod.rs` (keep alphabetical order in both the `mod` list and `all()`)
- `conformance/fixtures/firebase/firestore/<name>.json`

**TOML.** Required keys in this order, matching existing files:
`id, title, provider, service, severity, category, evaluation, status,
summary, description, fix`, then optional `docs`, `[params]`, `[[examples]]`.
- `provider = "firebase"`, `service = "firestore"`, `status = "stable"`, `default_enabled` omitted (defaults to true).
- `category` is one of: `reads, writes, realtime, pagination, payload, aggregation, hotspots, reliability`.
- `title`: short, sentence case, no trailing period. `summary`: one sentence, ends with a period.
- `description`: 2 to 5 lines, explains *why it costs money* in Firestore billing terms (reads per doc returned, writes/deletes per op, egress bytes).
- `fix`: concrete, names the Firestore API to use.
- `docs`: only `https://firebase.google.com/docs/...` URLs you are confident exist; if unsure, omit `docs` entirely. Never invent URLs.
- One `[[examples]]` with `lang = "ts"`, `bad` and `good` using the **modular web SDK** (`getDocs(query(...))`, `onSnapshot`, ...), using `'''` strings like existing files.
- Every threshold is a `[params]` entry. Param names are snake_case with units in the name (`window_ms`, `min_docs`, `max_avg_doc_bytes`). Integers for counts/ms, floats only for ratios/rates.

**Detector code.**
- `pub const ID: &str = "<full id>";` and `pub fn build(p: &Params) -> Result<Box<dyn Detector>, ParamError>`. Parse every param in `build` with `p.u64(..)` / `p.f64(..)`; clamp nonsense (`.max(1)`) like existing detectors.
- Doc comment on the detector struct: one or two lines saying what it detects (copy the style of `write_hotspot.rs`).
- Only count billed calls where the rule is about billed reads: use the module's `billed(env)` helper (not from cache, not an error).
- State: only `KeyedWindow`, `BoundedMap`, or a `HashMap` with an explicit hard cap that clears on overflow (pattern: `listener_leak.rs`, `MAX_TRACKED = 16_384`). Key state by session first: `(env.ctx.session, ...)`.
- After emitting for a group, remove that group's window state (pattern: `write_hotspot.rs`) so one pattern yields one finding.
- Message style: lowercase start, template in backticks, short statement of what happened with numbers, then `; ` and the fix in a few words. Example: ``"`posts` count() scanned 120000 index entries (120 reads) per call; keep a counter document"``.
- Evidence keys: snake_case, numbers via `.evidence("key", value)`.
- `wasted`: only when the waste is computable as stated in the rule spec below. Units are `"reads"`, `"writes"`, `"deletes"`, `"egress_bytes"` (use `crate::firestore::billing::{READS, ...}` constants if visible from the detector module, else the string literal as other detectors do).
- No `unwrap`, `expect`, `panic`, indexing that can panic, or `as` casts that can truncate silently where overflow matters (use `saturating_*`, `checked_div`).
- Window detectors: `#[cfg(feature = "window")]` on the `pub mod` line **and** on the `all()` entry. Local detectors: not gated.

**Tests (in each detector file, `#[cfg(test)] mod tests`).**
- At least: one firing test, one close non-firing test (same scenario, one condition missing), and for window rules one test showing sessions do not mix (same pattern split across two sessions does not fire).
- If the rule computes `wasted`, assert the exact amount.
- Use `EnvBuilder`, `single_rule_engine(ID, build, &[params...])`, `run`. Pass the same default params as the TOML.
- If `EnvBuilder` lacks a setter you need (for example `mount`, `collection_group`, commit ops), add a small setter to `crates/rules/src/testing.rs` in the same fluent style. That is the only change allowed in `crates/rules/src` besides group 2's polling change and generic detectors.

**Conformance fixture (one per rule).**
- Realistic web scenario in `description` (what the app code does).
- `"platform": "browser"`, `"evaluations": ["local", "window"]`.
- `expect_findings` is **exact and ordered**: if another existing rule also fires on your calls, either list it or change the calls so it does not (prefer changing the calls; keep fixtures focused).
- `expect_envelopes` must list every call with its exact `units`.

## 2. Group 1: local rules (4)

### 2.1 `firebase.firestore/expensive-aggregation`
- severity `medium`, category `aggregation`, evaluation `local`.
- Params: `min_index_entries = 50000`.
- Fires on: `Op::Aggregate`, billed, `result.index_entries >= min_index_entries`.
- Message: aggregation over N index entries costs `reads` per call; keep a counter document or cache the value.
- Evidence: `index_entries`, `reads` (from `env.units`).
- Wasted: none.
- Fix text: maintain a counter doc updated with `increment()` (or a Cloud Function), or cache the count client-side.
- Non-firing test: 49_999 entries; also a cached aggregate.

### 2.2 `firebase.firestore/oversized-limit`
- severity `high`, category `reads`, evaluation `local`.
- Params: `max_limit = 500`, `min_docs = 200`.
- Fires on: `Op::Query` or `Op::Snapshot { initial: true }`, billed, `query.limit >= max_limit`, `items >= min_docs`, and `env.ctx.platform != Platform::Server` (server jobs legitimately read large pages).
- Unbounded (no limit) is `unbounded-list`'s job: this rule requires `limit.is_some()`.
- Message: `limit(N)` on `template` returned M documents in one read; a UI rarely shows more than a page.
- Evidence: `limit`, `docs`. Wasted: none.
- Fix: page with `limit(25..50)` + `startAfter(lastDoc)`.
- Non-firing tests: limit 499; server platform.

### 2.3 `firebase.firestore/large-docs-in-list`
- severity `medium`, category `payload`, evaluation `local`.
- Params: `min_docs = 10`, `max_avg_doc_bytes = 20480`, `upper_avg_doc_bytes = 102400`.
- Fires on: `Op::Query` or `Op::Snapshot { initial: true }`, billed, `items >= min_docs`, and `max_avg_doc_bytes <= bytes / items < upper_avg_doc_bytes`.
- `upper_avg_doc_bytes` equals `generic/oversized-payload`'s `max_avg_item_bytes` default: at or above it, that rule reports the call, so this one stays silent. Say so in the TOML description in one sentence.
- Message: documents in list `template` average N bytes; the web SDK always downloads whole documents.
- Evidence: `docs`, `avg_doc_bytes`, `bytes`. Wasted: `egress_bytes = bytes - items * max_avg_doc_bytes` (saturating).
- Fix: move heavy fields into a subcollection or a separate detail document; keep a small summary doc for lists.

### 2.4 `firebase.firestore/fanout-writes`
- severity `info`, category `writes`, evaluation `local`.
- Params: `min_writes = 100`.
- Fires on: `Op::Commit { writes, deletes, .. }` with `writes + deletes >= min_writes`.
- Message: one commit wrote N documents from a client; each user action costs N writes.
- Evidence: `writes`, `deletes`, `transactional`. Wasted: none.
- Fix: review denormalization; move fan-out to a Cloud Function triggered once, or store the shared data once and reference it.

After group 1: run the checks in section 5, including the wasm size gate
(these four are local, so they ship in the production SDK). **If the size
gate fails, do not change `BUDGET_GZIP`**; report the number and stop.

## 3. Group 2: window rules, reads and listeners (7) + one change

All in the Firestore provider, all `#[cfg(feature = "window")]`.

"Doc read" means `Op::Get`. "Read" means `Op::Get | Op::Query`. Two calls
refer to the same thing when `(env.ctx.session, env.target.key)` is equal.
Before writing detectors, check in `normalize.rs` how `target.key` and
`query.base_key` are computed for `get`, `query`, `subscribe` and
`aggregate` on the same path/filters, and state in your report whether a
`subscribe` and a `query` with the same path and filters get the same
`target.key` (they must for 3.1/3.2; if they do not, stop and report).

### 3.0 Change: `generic/polling-instead-of-subscription` ignores aggregations
Aggregations cannot be subscribed to, so this rule's fix is wrong for them;
3.4 covers polled aggregations. In `crates/rules/src/detectors/polling.rs`,
skip `Op::Aggregate`. Add a test: regularly polled aggregate does not fire.
Add one sentence to the TOML description: aggregation polling is reported
by `firebase.firestore/polled-aggregation`.

### 3.1 `firebase.firestore/get-while-listening`
- severity `medium`, category `realtime`.
- Params: none needed beyond a cap; use `listener_leak.rs`'s bounded-map pattern.
- State: open listeners `(session, listener) -> target.key`, and active counts `(session, key) -> n`. `Subscribe` adds, `Unsubscribe` removes.
- Fires on: billed read whose `(session, key)` has an active listener.
- Message: `template` read from the server while a listener on the same query is open; read the listener's data instead.
- Evidence: `active_listeners`. Wasted: all of `env.units` (`wasted_units`).
- Fix: read from the listener's latest snapshot (shared store), or `getDocsFromCache`.
- Non-firing: same read after `Unsubscribe`; cached read.

### 3.2 `firebase.firestore/get-then-listen`
- severity `medium`, category `realtime`.
- Params: `window_ms = 10000`.
- State: `BoundedMap<(session, key), Units>` of billed reads (TTL `window_ms`).
- Fires on: `Subscribe` whose `(session, key)` had a billed read within `window_ms`; remove the entry.
- Message: `template` fetched with a one-time read, then subscribed within N ms; the listener's first snapshot bills the same documents again.
- Evidence: `gap_ms`. Wasted: the stored read's units.
- Fix: use only `onSnapshot`; its first snapshot is the initial load.
- Non-firing: subscribe after `window_ms`; different query.

### 3.3 `firebase.firestore/read-after-write`
- severity `low`, category `reads`.
- Params: `window_ms = 2000`.
- State: `BoundedMap<(session, key), u64>` of `Create | Set | Update` timestamps (not `Delete`, not `Commit`).
- Fires on: billed `Op::Get` of the same key within `window_ms`.
- Message: `template` document read back N ms after this client wrote it.
- Evidence: `gap_ms`. Wasted: `env.units`.
- Fix: keep the written data in local state; `onSnapshot` listeners already see local writes immediately.

### 3.4 `firebase.firestore/polled-aggregation`
- severity `medium`, category `aggregation`.
- Params: `window_ms = 600000`, `min_repeats = 5`, `min_interval_ms = 2000`.
- State: `KeyedWindow<(session, key), Units>` of billed `Op::Aggregate`.
- Fires when the window holds `>= min_repeats` samples and every gap between consecutive samples is `>= min_interval_ms` (bursts are someone else's rule).
- Message: aggregation on `template` ran N times in M ms; aggregations cannot be listened to.
- Evidence: `repeats`, `window_ms`. Wasted: units of every sample after the first.
- Fix: keep a counter document updated with `increment()` and listen to it.

### 3.5 `firebase.firestore/count-then-fetch`
- severity `low`, category `aggregation`.
- Params: `window_ms = 5000`.
- State: `BoundedMap<(session, base_key), Units>` of billed `Op::Aggregate` whose `query.aggregations` contains `"count"`.
- Fires on: billed `Op::Query` with no aggregations and the same `query.base_key` within `window_ms`.
- Message: `template` counted with count() and then fetched; `snapshot.size` of the fetch already has the count.
- Evidence: `gap_ms`. Wasted: the count's units.
- Fix: drop the count() call when you fetch the documents anyway.

### 3.6 `firebase.firestore/listener-per-item`
- severity `high`, category `realtime`.
- Params: `max_active = 25`.
- Doc listener = `Subscribe` with `env.query.is_none()`. Verify in `normalize.rs` that a document `onSnapshot` has no query shape; if it does, use whatever distinguishes a doc path, and report it.
- State: `(session, listener) -> template group` and `(session, template group) -> count` of open **doc** listeners, capped like `listener_leak.rs`. Group by template string (use `readmeter_rules::detectors::local_hash`).
- Fires when a count reaches `max_active` (exactly at the crossing; the engine cooldown handles repeats).
- Message: N single-document listeners open on `template`; one query listener over the set bills the same documents with one listener.
- Evidence: `active`. Wasted: none.
- Fix: one `onSnapshot(query(collection, where(documentId(), 'in', ids)))` (chunks of 30) or a query on a shared field.
- Non-firing: 24 listeners; 25 across two sessions; unsubscribes lowering the count.

### 3.7 `firebase.firestore/hot-listener`
- severity `high`, category `realtime`.
- Params: `window_ms = 60000`, `max_changed_docs = 200`.
- State: `KeyedWindow<(session, listener), u64>` of `items` from billed `Snapshot { initial: false }`.
- Fires when the sum in the window reaches `max_changed_docs`.
- Message: listener on `template` received N changed documents in M ms; every change bills a read on every client listening.
- Evidence: `changed_docs`, `window_ms`. Wasted: none.
- Fix: narrow the query (filters, smaller `limit`), batch/throttle the writers, or listen to a summary document.

## 4. Group 3: window rules, writes and sessions (6) + one fix

### 4.0 Fix (planner decision after group 2): `base_key` excludes aggregations
Group 2 found that `query.base_key` hashes aggregations, so a `count()` and
the `getDocs` of the same query never share it and `count-then-fetch`
cannot fire. Decision:

- `query.base_key` = service, collection-group flag, path, filters with
  values, ordering, `select`. **No aggregations, no paging.**
- `target.key` = `base_key` inputs + aggregations + paging, so a count and a
  fetch of the same query keep **different** `target.key`s (duplicate-read,
  polling and friends must not merge them).
- This is the one allowed change to `normalize.rs` in this task. Update the
  doc comment on `hash_query_base` and the doc comment on
  `QueryShape::base_key` in `crates/core/src/envelope.rs` (comment only; no
  type change, no `SCHEMA_VERSION` bump: nothing has shipped).
- Tests in `normalize.rs`: count and fetch of the same query share
  `base_key` and differ in `target.key`; existing "paging excluded from base
  key" test still passes.
- Update `conformance/fixtures/firebase/firestore/count-then-fetch.json` so
  `expect_findings` contains `firebase.firestore/count-then-fetch` with the
  count's `wasted` units. Re-run all fixtures; if another fixture changes
  findings because of this, report it instead of editing it.

### 4.1 `firebase.firestore/query-per-keystroke`
- severity `medium`, category `reads`.
- Params: `window_ms = 3000`, `min_distinct = 4`.
- Group: `(session, query.fingerprint, callsite_key(env))` (the fingerprint is the value-free shape; `callsite_key` is in `readmeter_rules::detectors`). Only `Op::Query | Op::Subscribe` with a query shape that has at least one filter, billed for queries.
- State: `KeyedWindow<group, (u64 /*target.key*/, Units)>`.
- Fires when the window holds `>= min_distinct` distinct `target.key`s.
- Message: N queries with the same shape and different values on `template` within M ms from one callsite; typing issues a query per keystroke.
- Evidence: `distinct_queries`, `window_ms`. Wasted: units of every sample except the last.
- Fix: debounce input (300 ms+), require a minimum length, and cache results per term.
- Must not overlap `generic/duplicate-read` (same key) or `generic/n-plus-one` (single-doc gets): the tests show identical keys do not fire this rule.

### 4.2 `firebase.firestore/write-per-keystroke`
- severity `medium`, category `writes`.
- Params: `window_ms = 5000`, `min_writes = 5`.
- Group: `(session, target.key, callsite_key(env))`, ops `Set | Update` only.
- Fires when the window holds `>= min_writes`.
- Message: one `template` document written N times in M ms from one callsite; each keystroke or drag event is a billed write.
- Evidence: `writes`, `window_ms`. Wasted: `writes = count - 1`.
- Fix: debounce and write on blur/submit, or keep drafts local.
- Relation to `write-hotspot` (10 s, >10 writes): both may fire on a long burst. That is acceptable (different fix); say so in one sentence in this TOML's description.

### 4.3 `firebase.firestore/tiny-batches`
- severity `low`, category `writes`.
- Params: `window_ms = 2000`, `min_commits = 10`, `max_writes_per_commit = 2`.
- Group: `(session, callsite_key(env))`, op `Commit` with `writes + deletes <= max_writes_per_commit` and `transactional == false`.
- Fires when the window holds `>= min_commits`.
- Message: N batches of at most K writes each from one callsite in M ms; combine them into one `writeBatch`.
- Evidence: `commits`, `window_ms`. Wasted: none (writes cost the same; this is latency).
- Fix: collect writes and commit one `writeBatch` (up to 500 ops).

### 4.4 `firebase.firestore/client-side-bulk-delete`
- severity `low`, category `writes`.
- Params: `window_ms = 60000`, `min_deletes = 100`.
- Group: `(session, local_hash(template))`. Count `Op::Delete` as 1 and `Op::Commit { deletes, .. }` as `deletes`.
- State: `KeyedWindow<group, u64>`, sum of deletes.
- Fires when the sum reaches `min_deletes`.
- Message: N documents in `template` deleted from a client in M ms.
- Evidence: `deletes`, `window_ms`. Wasted: none.
- Fix: a TTL policy, or a server-side recursive delete (`firebase firestore:delete` / Admin SDK `recursiveDelete`).

### 4.5 `firebase.firestore/manual-ttl-cleanup`
- severity `medium`, category `writes`.
- Params: `window_ms = 60000`, `min_deletes = 20`.
- State: `BoundedMap<(session, local_hash(template)), Units>` set by a billed `Op::Query` that has a filter with op `<` or `<=` (a "find old docs" query). Delete template: a delete targets the document template (`posts/{id}`), the query targets the collection (`posts`). Match by stripping the last `/{...}` segment from the delete's template. Put that helper in the detector file with its own test.
- Count deletes (as in 4.4) against a stored query within `window_ms`; fire when they reach `min_deletes`; remove the entry.
- Message: `template` queried by an age filter and N results deleted from the client; a TTL policy deletes expired documents without the reads.
- Evidence: `deletes`. Wasted: the stored query's units.
- Fix: a TTL policy on the timestamp field.
- Relation to 4.4: both can fire on the same cleanup; acceptable (4.4 is low, this one names the specific fix). Say so in the TOML.

### 4.6 `firebase.firestore/initial-load-fanout`
- severity `medium`, category `reads`.
- Params: `window_ms = 5000`, `max_distinct = 30`.
- State: `BoundedMap<session, (start_ts, Vec<u64> /* distinct keys, capped at max_distinct */, fired: bool)>`. Session start is the first envelope seen for that session (any op).
- Count distinct `target.key` of billed reads and billed `Snapshot { initial: true }` whose `ts_ms - start_ts <= window_ms`. Fire once per session when the count reaches `max_distinct`.
- Message: N distinct reads in the first M ms of the session; page load fans out across many documents and queries.
- Evidence: `distinct_reads`, `window_ms`. Wasted: none.
- Fix: denormalize a page document, serve public data with a Firestore bundle, or defer below-the-fold reads.

## 5. Checks (run after every group; all must pass)

```sh
cargo fmt --all
cargo clippy --workspace --all-features --all-targets -- -D warnings
cargo clippy -p readmeter-wasm -p readmeter-ffi --no-default-features --features firebase -- -D warnings
cargo test --workspace --all-features
cargo run -q -p readmeter-rules --features catalog-toml --bin readmeter-rulec -- check rules
./scripts/build-wasm.sh        # size gate; do not change BUDGET_GZIP
```

After group 3 also run the backend tests (the server core embeds the new window rules):

```sh
cargo run -q -p readmeter-rules --features catalog-toml --bin readmeter-rulec -- build rules target/rules
./scripts/build-wasm-server.sh
pnpm typecheck && pnpm test
```

## 6. Plans to update (only these edits)

- `.plans/0003-rule-catalog.md`: move each finished rule's row from "Batch A" into the "Must-have rules (v1)" Firebase table with `stable`; keep the batch A heading with a note "done" when all are moved.
- `.plans/0006-firebase-web.md`: tick "New detectors" only if all 17 are done.
- Nothing else in `.plans/` or `AGENTS.md`.

## 7. Report (after each group)

Plain text, in this order:
1. Rules done (ids) and files created/changed.
2. Check results (pass/fail per command; wasm gzip size in bytes).
3. The `normalize.rs` findings requested in section 3 (group 2 only).
4. Anything you could not do as specified, and why. Do not work around a spec you think is wrong; report it.
