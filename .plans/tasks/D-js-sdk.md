# Task D: JS SDK `@readmeter/firebase` (web + Cloud Functions)

Planner: Claude. Executor: Grok. Status: done 2026-09-29 (3 parts reviewed). Follow-up: inline wasm costs ~89.6 KB gzip vs 70.3 KB as a file; add an optional `wasmUrl` for apps that can serve the file.

Goal: a developer adds Readmeter to a Firebase **web app** (modular SDK,
`firebase/firestore`) and to **Cloud Functions / Node backends**
(`firebase-admin/firestore`, which is `@google-cloud/firestore`), and every
Firestore call turns into raw calls for the Rust core, batches sent to
ingest, and findings in Postgres. Capture design: `.plans/0004-sdk-surface.md`
(web: drop-in wrapper on `sink`; server: interception). Read it.

## 0. Read first

1. `AGENTS.md`; `.plans/0004-sdk-surface.md`; `.plans/0006-firebase-web.md`.
2. Raw-call contract: `crates/providers/firebase/src/firestore/raw.rs` and
   `.plans/0002-rust-core.md` ("Raw-call contract for shims").
3. `conformance/README.md` and every file in `conformance/fixtures/firebase/firestore/`.
4. `crates/bindings/wasm/src/lib.rs` (JS API after Task B: `new Readmeter(configJson, bundle: Uint8Array)`,
   `record(rawJson) -> string` (findings JSON: rule, severity, template, message, wasted),
   `flush(nowMs) -> Uint8Array | undefined`, `activeRules()`), `crates/runtime/src/config.rs` (config fields).
5. `apps/ingest/src/app.ts` (endpoints `POST /v1/batches`, `GET /v1/config`, `GET /v1/bundle`; auth, CORS, status codes 401/403/429/503 and `Retry-After`) and `.plans/0005-backend.md`.

Verified SDK internals (planner, firebase 12.19.0 / firebase-admin 14.5.0 /
@google-cloud/firestore 9.2.0) are listed in section 6. Re-verify against the
installed versions and keep the guards described there.

## 1. Package layout

```
sdks/js/firebase/                 package "@readmeter/firebase", ESM, TypeScript, part of the pnpm workspace
  package.json                    exports: ".", "./firestore", "./admin"; peerDependencies (optional):
                                  firebase >=10 <13, firebase-admin >=12, @google-cloud/firestore >=7
  src/
    index.ts                      init, flush, shutdown, sink, sinkWrite, sinkListener, types
    core/client.ts                owns the wasm Readmeter instance, queue before ready, dev console output
    core/wasm.ts                  loads prod or dev wasm (browser: fetch URL; node: fs), initSync
    core/transport.ts             batching timer, POST, backoff, keepalive flush, node exit hooks
    core/session.ts               session id (u64 decimal string, crypto random), call ids, listener ids
    core/callsite.ts              first stack frame outside this package and node_modules, "file:line:col"
    core/size.ts                  Firestore storage-size estimator over proto Values
    web/firestore.ts              drop-in: `export * from "firebase/firestore"` + wrapped functions
    web/shape.ts                  web Query -> raw `query` object (internals, version-guarded)
    admin/index.ts                instrument(firestore) for firebase-admin / @google-cloud/firestore
    admin/shape.ts                admin StructuredQuery / queryOptions -> raw `query`
  wasm/prod/, wasm/dev/           copied from Task B build outputs by the build script (git-ignored)
  bundle/bundle.bin               default rule bundle copied from target/rules (git-ignored)
  scripts/build.sh                runs build-wasm.sh twice (prod, dev) + rulec build, copies, then tsc to dist/
  test/                           node:test tests (see section 5)
```

`pnpm --filter @readmeter/firebase build` produces `dist/` + `wasm/` + `bundle/`;
`pnpm --filter @readmeter/firebase pack` produces a tarball a user can
`npm install ./readmeter-firebase-0.1.0.tgz` in their own app. Package
`files`: `dist`, `wasm`, `bundle`, `README.md`.

## 2. Public API

```ts
import { init, flush, shutdown, sink, sinkWrite, sinkListener } from "@readmeter/firebase";

init({
  apiKey: "rm_...",               // ingest key (Bearer)
  hashKey?: "32 hex chars",       // per project, from `pnpm run rm key create`; when omitted, fetched once from GET {endpoint}/v1/config
  endpoint: "http://127.0.0.1:8090",
  dev?: boolean,                  // default false; true: dev wasm (window rules locally) + console.warn findings
  sampleRate?: number,            // 0..1, default 1
  flushIntervalMs?: number,       // default 10000
  maxBatchEvents?: number,        // default 200, flush early at this count
  bundle?: Uint8Array,            // override default bundle.bin; otherwise the packaged bundle is used and
                                  // GET {endpoint}/v1/bundle is fetched in the background (If-None-Match) for the next start
  platform?: "browser" | "server" | "mobile",  // default: detected (window/document -> browser, else server)
  onFinding?: (f) => void,        // local findings callback
  debug?: boolean,                // logs raw calls to console.debug
}): void                          // never throws; bad config -> console.error once, SDK disabled

await flush();                    // send what is buffered now (resolves even on network error)
await shutdown();                 // flush + stop timers
```

Rules for the whole SDK (from AGENTS rule 2, JS side): never throw into the
host app, never change what the wrapped Firestore call returns or throws,
never await anything on the host's critical path except the wrapped call
itself. All Readmeter work after the call is wrapped in `try/catch`, errors
go to a single rate-limited `console.debug` when `debug` is on.

Before `init` or while wasm loads, raw calls go to an in-memory queue capped
at 1000 (drop oldest). Wasm loading starts in `init` and is async.

### sink API (manual, any SDK version)

```ts
const snap = sink(q, await getDocs(q));            // returns its second argument
sink(ref, await getDoc(ref));
sinkWrite(ref, "set" | "update" | "create" | "delete");
const unsub = onSnapshot(q, sinkListener(q, (s) => render(s)));
```

`sink` accepts web or admin Query / DocumentReference / AggregateQuery and
their snapshots; it builds the raw call from them (shape + result stats) and
records it with `duration_us` omitted.

## 3. Web drop-in (`@readmeter/firebase/firestore`)

`export * from "firebase/firestore"` and override these named exports with
wrappers that call the real function and then record. Signatures and return
values must be identical (re-export the original types; wrappers typed as
`typeof original`):

| Function | Raw op | Notes |
|---|---|---|
| `getDocs`, `getDocsFromServer`, `getDocsFromCache` | `query` | result: `docs = snap.size`, `bytes` = estimator, `from_cache = snap.metadata.fromCache` |
| `getDoc`, `getDocFromServer`, `getDocFromCache` | `get` | `docs = exists ? 1 : 0` |
| `getCountFromServer`, `getAggregateFromServer` | `aggregate` | `aggregations`: `count`, `sum:<field>`, `avg:<field>`; `index_entries` = count value when a count is present, else omit |
| `setDoc` | `set` | |
| `updateDoc` | `update` | |
| `addDoc` | `create` | path = the new doc path |
| `deleteDoc` | `delete` | |
| `writeBatch` | `commit` on `commit()` | writes = set+update mutations, deletes = delete mutations, `transactional: false` |
| `runTransaction` | `commit` with `transactional: true` | wrap the user function: count attempts (`attempt` = number of times it ran); count `transaction.set/update/delete` calls of the successful attempt |
| `onSnapshot` | `subscribe`, then `snapshot` per callback, `unsubscribe` when the returned function is called | all overloads (ref or query, optional options, observer object or callbacks); `initial: true` for the first snapshot; later snapshots: `docs = docChanges().length` (queries) or 1 (docs); skip snapshots with `hasPendingWrites` local-only changes where `metadata.fromCache` and no doc changes |

Every recorded call has: `service: "firestore"`, `ts_ms` (Date.now at call
start), `duration_us` (performance.now delta, integer), `call_id` (increment),
`callsite`, and `error` (Firestore error `code`, e.g. `permission-denied`) when the call rejects
(record, then rethrow the same error).

Usage tracking (for `count-via-fetch`, `emptiness-check-without-limit`):
for `getDocs*` results, return the real snapshot but record, 1 s after the
call resolves (or at the next flush, whichever is first), a `usage` raw call
with the same `call_id` and `{ read_items, read_size, read_empty }`, where
`read_items` means `docs`, `forEach` or `docChanges` was accessed. Detect
access by defining accessors on the snapshot **instance** that delegate to
the prototype getters (do not use a `Proxy`; `instanceof` and private fields
must keep working). If defining accessors fails (frozen object, future
SDK), skip usage tracking for that call.

## 4. Admin / Cloud Functions (`@readmeter/firebase/admin`)

```ts
import { init, flush } from "@readmeter/firebase";
import { instrument, withFlush } from "@readmeter/firebase/admin";
const db = instrument(getFirestore());         // returns the same instance
export const fn = onRequest(withFlush(async (req, res) => { ... }));  // flushes before the handler's promise resolves
```

Interception point: patch the instance's `request(methodName, request, ...)`
and `requestStream(methodName, bidirectional, request, ...)` methods (the
funnel every RPC goes through; section 6). This sees documented
`google.firestore.v1` protos, so it covers `get`, `getAll`, queries,
aggregations, `BulkWriter`, `recursiveDelete`, batches and transactions
without double counting.

- `commit` (unary): writes = `update` writes, deletes = `delete` writes;
  `transactional` = request has `transaction`. Path: common collection of
  the writes (first write's document path when they differ). For a single
  write, record `set`/`update`/`create` instead of `commit` (`update` when
  `updateMask` is present, `create` when `currentDocument.exists === false`,
  else `set`), and `delete` for a single delete.
- `runQuery` / `runAggregationQuery` (stream): build `query` from
  `structuredQuery` (`from`, `where`, `orderBy`, `limit`, `offset`,
  `startAt`, `endAt`, `select`); map operators to the web strings (`EQUAL` ->
  `==`, `NOT_EQUAL` -> `!=`, `LESS_THAN` -> `<`, `LESS_THAN_OR_EQUAL` -> `<=`,
  `GREATER_THAN` -> `>`, `GREATER_THAN_OR_EQUAL` -> `>=`, `IN` -> `in`,
  `NOT_IN` -> `not-in`, `ARRAY_CONTAINS` -> `array-contains`,
  `ARRAY_CONTAINS_ANY` -> `array-contains-any`, unary `IS_NULL` -> `==` with
  value null, `IS_NAN` -> `==` with value "NaN"); composite filters are flattened.
  Count `document` responses and estimated bytes; record when the stream ends
  or errors. Aggregation: `index_entries` = count result when present.
- `batchGetDocuments` (stream): one doc -> `get`; many docs -> one `get` per
  doc (they are separate billed reads; n-plus-one needs them).
- `listen` (bidi): `addTarget` with a query -> `subscribe`; documents target
  -> `subscribe` per document. Count `documentChange` per target; a
  `targetChange` of type `CURRENT` ends the initial snapshot (`initial: true`),
  later `NO_CHANGE` with a read time ends a non-initial snapshot.
  `removeTarget` / stream end -> `unsubscribe`. If this proves unreliable in
  the emulator, record `subscribe`/`unsubscribe` only and say so in the report.
- Tap streams without changing their flow: wrap with an object-mode
  `Transform` that passes chunks through, forward `error`, return the
  transform in the same paused state the caller expects. Never add a `data`
  listener to the original stream.
- Callsite: patch the public methods (`Query.prototype.get`, `stream`,
  `onSnapshot`, `DocumentReference.prototype.get/set/update/create/delete/onSnapshot`,
  `WriteBatch.prototype.commit`, `AggregateQuery.prototype.get`,
  `Firestore.prototype.getAll/runTransaction`) **only** to capture the
  callsite into an `AsyncLocalStorage` context; the RPC hook reads it.
  These patches record nothing themselves.
- `platform: "server"`. `withFlush(handler)` awaits `flush()` after the
  handler settles (success or error) and rethrows handler errors unchanged.
  Node: also flush on `beforeExit` and on `SIGTERM` (best effort).

## 5. Tests

- Unit (no network): raw-call builders for web and admin shapes, operator
  mapping, size estimator (known sizes from Firestore docs: `"a"` string field
  in a doc, ints, maps), callsite parser, queue cap, transport backoff on 503
  with `Retry-After`, never-throws (wasm missing, bad config, fetch rejects).
- **Conformance from TypeScript**: a runner that, for each fixture, replays
  the fixture's `calls` through the SDK's core client (wasm) and checks
  `expect_findings` rules, proving the JS binding matches the Rust runner.
- **Emulator tests** (`test/emulator/*.test.ts`, run by
  `pnpm --filter @readmeter/firebase test:emulator`, which uses
  `npx -y firebase-tools@latest emulators:exec --only firestore --project demo-readmeter`):
  - web: for the scenarios in fixtures `unbounded-list`, `offset-pagination`,
    `missing-cursor`, `count-via-fetch`, `get-then-listen`, `listener-per-item`,
    `query-per-keystroke`, `write-per-keystroke`, `transaction-and-batch`:
    run the real web SDK against the emulator through the drop-in, capture
    raw calls (debug hook), and assert they equal the fixture `calls`
    after normalizing `ts_ms`, `call_id`, `listener`, `callsite`,
    `duration_us`, and `bytes` (bytes: assert > 0). Then assert the dev-mode
    local findings include the fixture's rule.
  - admin: same for `unbounded-list`, `offset-pagination`,
    `transaction-and-batch`, and one `listen` scenario, through `instrument()`.
- Java is required by the emulator; if missing, the emulator suite exits
  with a clear message (not a failure of the unit suite).

## 6. Verified internals (keep version guards)

Web (`firebase` 12.19.0), `Query`: `q.type === "query"`, `q._query` has
`path.canonicalString()`, `collectionGroup` (string|null), `filters`
(FieldFilter: `field.canonicalString()`, `op` in web strings, `value` a proto
Value like `{stringValue:"open"}`; CompositeFilter: `op` `"and"|"or"`,
`filters`), `explicitOrderBy` (`field.canonicalString()`, `dir` `"asc"|"desc"`),
`limit` (number|null), `limitType` (`"F"` first, `"L"` last), `startAt`/`endAt`
(`{inclusive, position: Value[]}`). `DocumentReference`: `type === "document"`,
`path`. `WriteBatch`: `_mutations` (`SetMutation` type 0, `PatchMutation` 1,
`DeleteMutation` 2). Document proto for sizes: `snapshot._document.data.value.mapValue.fields`.

Admin (`@google-cloud/firestore` 9.2.0): `Firestore.prototype.request(methodName, request, requestTag, retryCodes)`
(unary, returns Promise of the response) and
`Firestore.prototype.requestStream(methodName, bidirectional, request, requestTag)`
(returns Promise of a paused stream). Method names: `commit`, `beginTransaction`,
`rollback`, `batchWrite`, `runQuery`, `runAggregationQuery`,
`batchGetDocuments`, `listen`, `partitionQuery`. Query options (for callsite/debug only):
`query._queryOptions` with `parentPath.relativeName`, `collectionId`,
`allDescendants`, `filters[{field.formattedName, op: "EQUAL"...}]`, `fieldOrders`,
`limit`, `limitType` (0 first), `offset`, `startAt {values, before}`, `projection`.
Document proto for sizes: `DocumentSnapshot._fieldsProto`.

Guards: a shape reader that finds an unexpected structure returns
`undefined` (send the call without `query`; rules that need it stay
silent) and sets a one-time `console.debug` warning with the SDK version.
Wrap every internal access in `try/catch`.

## 7. Workspace, CI, docs

- Add `sdks/*/*` to `pnpm-workspace.yaml`. Root scripts: `sdk:build`, `sdk:test`, `sdk:test:emulator`.
- CI: add an `sdk-js` job: build wasm (prod + dev), rulec build, `pnpm --filter @readmeter/firebase build`,
  unit tests, then emulator tests (setup-java 21, `npx firebase-tools`).
- `sdks/js/firebase/README.md`: install from tarball, `init`, web drop-in
  (change `from "firebase/firestore"` to `from "@readmeter/firebase/firestore"`),
  Cloud Functions (`instrument`, `withFlush`), `dev` mode, privacy (what is
  sent: templates, counts, sizes, keyed hashes; never document data).
- `.plans/0006-firebase-web.md`: tick sections 1, 2, 3 items that are done.
  `AGENTS.md` repository map: add `sdks/js/firebase/` line. Nothing else.

## 8. Checks

```sh
cargo test --workspace --all-features
pnpm install && pnpm typecheck
pnpm --filter @readmeter/firebase build
pnpm --filter @readmeter/firebase test
pnpm --filter @readmeter/firebase test:emulator
pnpm test     # whole workspace, DATABASE_URL set
```

## Parts

- Part 1: sections 1, 2 (without sink), core, transport, wasm loading, unit
  tests, TS conformance runner. Stop and report.
- Part 2: web drop-in + sink + web emulator tests. Stop and report.
- Part 3: admin instrumentation + admin emulator tests + CI + README. Report.

Report per part: files, check results, deviations and why.
