# Readmeter

**Find what makes your Firebase bill grow, down to the line of code.**

Readmeter watches how your app uses Firestore (how many calls, how many
documents, how many bytes) and flags patterns that waste money: queries with
no `limit()`, `offset()` pagination, "load more" that re-reads every page,
listeners that leak, React effects that fetch twice, polling, N+1 reads,
writes on every keystroke, and 38 more. Each finding names the rule, the
collection, the callsite, and how many reads or writes it wasted.

It is self-hosted: a small SDK in your app, an ingest service, and Postgres.
Your documents never leave your app. Only path templates (`users/{id}/orders`),
counts, sizes and keyed hashes are sent.

> Status: early. Firestore on the web SDK and Cloud Functions / Node
> (`firebase-admin`) works end to end. Other Firebase services and other
> providers (Supabase, Vercel) are planned; the core is built for them.

## What it looks like

```ts
// Web app: change one import.
import { init } from "@readmeter/firebase";
import { getDocs, query, collection, where } from "@readmeter/firebase/firestore"; // was "firebase/firestore"

init({ apiKey: "rm_...", endpoint: "http://127.0.0.1:8090", dev: true });

const snap = await getDocs(query(collection(db, "orders"), where("status", "==", "open")));
// console: [readmeter] critical firebase.firestore/unbounded-list orders:
//          unbounded query on `orders` returned 3000 documents; add limit() and paginate
```

```ts
// Cloud Functions: instrument once, flush per invocation.
import { instrument, withFlush } from "@readmeter/firebase/admin";
const db = instrument(getFirestore());
export const report = onRequest(withFlush(async (req, res) => { /* ... */ }));
```

## Console

Findings land in Postgres and show up in the console: a collapsible sidebar,
workspace switcher, and dense tables for findings, events, costs, and keys.

![Overview](docs/images/console-overview.png)

![Findings](docs/images/console-findings.png)

`./scripts/dev-up.sh` starts it. Open `http://localhost:5174` and sign in as
`admin@readmeter.local` / `readmeter-dev`. The seeded workspace is `local`
and the demo project is `demo_local`.

## How it works

```
your app ── @readmeter/firebase (TS) ──► Rust core (wasm, ~70 KB gzip)
                                           normalize + redact, local rules, batch
            ──► POST /v1/batches ──► apps/ingest (TypeScript, Hono)
                                       Rust core (server build): decode, window rules
                                       ──► Postgres (Drizzle): events, findings
                                             ──► console API (http://127.0.0.1:8091)
```

- **One Rust core, many languages.** The same code runs in the browser and
  Node (wasm), natively through a C ABI (C++, Swift, Kotlin, Python, ...), and
  on the backend. Detection logic exists once.
- **Rules are data plus a detector.** Each rule is a TOML file in
  [`rules/`](rules/) (id, severity, description, fix, thresholds) and a small
  Rust detector with tests. Thresholds change without an SDK release.
- **Three tiers.** `local` rules look at one call and run in the SDK.
  `window` rules look at one session's recent calls and run on the backend
  (and in the SDK in dev mode). `aggregate` rules look across sessions
  (backend, planned).
- **Capture.** Web: drop-in wrappers around the modular Firestore, Realtime
  Database, and Cloud Storage SDKs, plus a `sink()` API for manual use. Cloud
  Functions / Node: interception of the Admin SDK (`instrument(db)` for
  Firestore, `instrumentDatabase(db)` for Realtime Database,
  `instrumentStorage(bucket)` for Cloud Storage).
- **Never breaks your app.** The SDK never throws into your code, never
  changes what Firestore returns, drops old data when buffers fill, and does
  its work after your call has returned.

Contributor and agent guide: [`AGENTS.md`](AGENTS.md).

## Rules (62 active)

Severity is ranked by cost impact: `critical` grows without bound with data
or traffic, `high` is a large multiplier, `medium` is measurable waste on a
hot path, `low` is minor waste or latency only, `info` is an observation.

| Rule | Severity | Tier | Detects |
|---|---|---|---|
| `firebase.firestore/unbounded-list` | critical | local | A list read has no limit(), so its cost grows with the collection. |
| `firebase.database/listen-on-root` | critical | local | A get or value listener on / or a top-level key downloads a node that grows with the database. |
| `firebase.database/download-whole-list` | critical | local | A list read has no limitToFirst or limitToLast, so every child is downloaded. |
| `firebase.firestore/offset-pagination` | high | local | offset(n) bills every skipped document as a read. |
| `firebase.firestore/missing-cursor` | high | window | Each "load more" re-reads every previous page because limit() grows instead of using a cursor. |
| `firebase.firestore/count-via-fetch` | high | window | A query result was used only for .size; count() costs about 1/1000 as much. |
| `firebase.firestore/oversized-limit` | high | local | A client query uses a limit() far larger than one page. |
| `firebase.firestore/listener-per-item` | high | window | Many single-document listeners are open on one document template. |
| `firebase.firestore/hot-listener` | high | window | A listener is billed for a large number of document changes per minute. |
| `firebase.database/value-listener-on-list` | high | window | onValue on a list downloads every child again each time one child changes. |
| `firebase.storage/list-all-large-prefix` | high | local | listAll reads every object under a prefix, one class A operation per page of 1000. |
| `firebase.storage/redownload-without-cache-control` | high | window | Repeated getBytes or getBlob calls re-download an object that sets no max-age. |
| `firebase.auth/anonymous-user-churn` | high | window | signInAnonymously runs more than once in one session, so each call creates another anonymous user. |
| `firebase.auth/id-token-refresh-storm` | high | window | getIdToken(true) runs many times in one session. Each call asks the token service for a new ID token. |
| `firebase.auth/phone-auth-retry` | high | window | Phone verification is sent several times in a short window, and each SMS is billed. |
| `generic/listener-leak` | high | window | Open subscriptions from one callsite keep growing because they are never unsubscribed. |
| `generic/subscription-churn` | high | window | The same subscription is closed and re-opened many times, re-billing its initial result. |
| `firebase.firestore/overfetch` | high | window | A query returned many documents and the caller read only a small fraction of them. |
| `firebase.firestore/growing-document` | high | window | A large document still grows through arrayUnion(), so every later read downloads the whole array. |
| `firebase.firestore/emptiness-check-without-limit` | medium | window | A query used only for .empty returned many documents; limit(1) gives the same answer for 1 read. |
| `firebase.firestore/get-then-listen` | medium | window | A billed read is followed within seconds by a listener on the same query. |
| `firebase.firestore/get-while-listening` | medium | window | A billed read hits a query that an open listener already delivers. |
| `firebase.firestore/query-per-keystroke` | medium | window | One callsite runs the same query shape with new values several times within a few seconds. |
| `firebase.firestore/write-per-keystroke` | medium | window | One callsite writes the same document several times within a few seconds. |
| `firebase.firestore/polled-aggregation` | medium | window | The same aggregation runs repeatedly instead of a counter document. |
| `firebase.firestore/expensive-aggregation` | medium | local | An aggregation scans enough index entries to cost many reads per call. |
| `firebase.firestore/initial-load-fanout` | medium | window | A session's first seconds contain many distinct billed reads. |
| `firebase.firestore/large-docs-in-list` | medium | local | A list downloads documents whose average size is larger than a row needs. |
| `firebase.firestore/large-listener-result` | medium | local | A listener loads many documents up front and bills them again on every re-subscribe. |
| `firebase.firestore/manual-ttl-cleanup` | medium | window | A client queries by an age filter and then deletes the results. |
| `firebase.firestore/transaction-contention` | medium | local | A transaction needed several attempts; each attempt re-reads and re-bills its documents. |
| `firebase.firestore/unused-projection` | medium | local | A server-side query downloads large full documents where select() could fetch only needed fields. |
| `firebase.firestore/write-hotspot` | medium | window | One document is updated faster than Firestore's sustained per-document write rate. |
| `firebase.database/rtdb-write-hotspot` | medium | window | One session writes the same path many times in a short window. |
| `firebase.database/duplicate-listeners` | medium | window | The same path and query is subscribed more than once at the same time from one session. |
| `firebase.storage/download-url-per-render` | medium | window | getDownloadURL hits object metadata, a class B operation, every time it runs. |
| `firebase.storage/original-size-images` | medium | local | A browser image download larger than 1 MiB bills class B and the full egress. |
| `firebase.storage/unbounded-list-page` | medium | local | list() without maxResults takes the server's default page of up to 1000 objects. |
| `firebase.auth/memory-persistence` | medium | local | Auth is initialized with in-memory persistence, so the user is signed out on every page load. |
| `firebase.auth/server-list-users-in-request` | medium | window | listUsers runs inside a request handler and walks the user list on the request path. |
| `generic/duplicate-read` | medium | window | The exact same request is billed several times in a short window. |
| `generic/n-plus-one` | medium | window | Many single-item reads on one path in a burst, usually one per item of an earlier list. |
| `generic/oversized-payload` | medium | local | A response, or its average item, is far larger than a UI usually needs. |
| `generic/polling-instead-of-subscription` | medium | window | The same request is re-issued at a steady interval, re-billing the full result every time. |
| `generic/react-double-mount` | medium | window | The same callsite opens a subscription or issues a read twice within milliseconds. |
| `generic/retry-storm` | medium | window | A request keeps failing and is retried rapidly, or retried far past a sane backoff. |
| `firebase.firestore/blob-in-document` | medium | local | A single field is large enough that every read of the document downloads it. |
| `firebase.firestore/multi-tab-without-shared-cache` | medium | local | Each tab keeps its own persistent cache, so every tab bills its own listener reads. |
| `firebase.firestore/force-server-read` | medium | window | The same target is read from the server several times with getDocsFromServer(). |
| `firebase.firestore/no-op-write` | medium | window | The same document is written again with a payload identical to the previous write. |
| `firebase.firestore/read-modify-write-counter` | medium | window | A counter is incremented by reading one document inside a transaction and writing it back. |
| `generic/unused-result` | medium | window | A billed result was never accessed by the caller. |
| `generic/activity-while-hidden` | medium | window | Listeners or queries keep billing after the tab has been hidden for a while. |
| `firebase.firestore/client-side-bulk-delete` | low | window | A client deletes many documents of one collection in a short window. |
| `firebase.firestore/count-then-fetch` | low | window | count() runs and the same query's documents are fetched right after. |
| `firebase.firestore/read-after-write` | low | window | This client reads a document it just wrote. |
| `firebase.firestore/tiny-batches` | low | window | One callsite commits many batches of one or two writes that could be a single batch. |
| `firebase.firestore/monotonic-document-ids` | low | window | New documents use monotonically increasing ids, concentrating writes on one index range. |
| `generic/one-shot-subscription` | low | window | Subscriptions are closed right after their first snapshot; a one-time read is cheaper. |
| `firebase.storage/upload-without-resumable` | low | local | uploadBytes of more than 5 MiB has no resume if the connection drops. |
| `firebase.firestore/persistence-disabled` | low | local | The client SDK runs without a persistent cache, so every reload re-reads from the server. |
| `firebase.firestore/fanout-writes` | info | local | One client commit writes or deletes many documents. |

Six more are on the roadmap: three that still need an SDK signal, and three
cross-session rules on the backend. The console lists these rules at
`http://localhost:5174` on the Rules page.

## Quick start (local)

Prerequisites: Docker, Node 22 + pnpm 10, Rust with the
`wasm32-unknown-unknown` target and `wasm-bindgen-cli` (version in
`Cargo.lock`), Java 21+ for the Firebase emulators.

```sh
git clone https://github.com/eviatarmor/Readmeter.git && cd Readmeter
pnpm install
./scripts/dev-up.sh      # Postgres, migrations, rules, SDK build, project demo_local, ingest on :8090, console API on :8091, console on :5174
```

Open the console at `http://localhost:5174` (`admin@readmeter.local` / `readmeter-dev`, workspace `local`, project `demo_local`).

Try the demo against the Firebase emulators:

```sh
cd examples && npx -y firebase-tools@latest emulators:start --project demo-readmeter   # terminal 1
pnpm --filter web dev                                                                  # terminal 2, http://localhost:5173
```

After clicking a few buttons, findings are in Postgres. Open `http://localhost:5174`, choose workspace `local` and project `demo_local`, and read them on Findings.

Run the whole loop as a test (web SDK, Cloud Functions, real Chromium, Postgres):

```sh
./scripts/e2e.sh
```

**Use it with your own app:** [`docs/TESTING-WITH-YOUR-APP.md`](docs/TESTING-WITH-YOUR-APP.md)
(create a key, install the SDK tarball, change one import, instrument your
functions, and expose ingest with a tunnel if your app is deployed).

## Repository

| Path | What |
|---|---|
| `crates/` | Rust core: envelope and wire format, rules engine, Firebase provider, runtime, wasm and C bindings, server evaluator |
| `rules/` | Rule definitions (TOML) |
| `sdks/js/firebase/` | `@readmeter/firebase`: web drop-in, `sink`, Admin/Cloud Functions instrumentation |
| `apps/ingest/` | HTTP ingest (TypeScript, Hono) |
| `apps/console-api/` | Console API (TypeScript, Hono, Better Auth): workspaces, projects, keys, findings, events, rules, costs |
| `apps/console-web/` | Console (Vite, React): sidebar, findings, events, costs, rules, keys, members |
| `packages/db/` | Postgres schema and migrations (Drizzle) |
| `conformance/` | Shared fixtures every SDK must reproduce |
| `examples/` | Demo web app, Cloud Functions, end-to-end runner |

## Development

```sh
cargo test --workspace --all-features
cargo clippy --workspace --all-features --all-targets -- -D warnings
pnpm typecheck && DATABASE_URL=postgres://readmeter:readmeter@127.0.0.1:5442/readmeter pnpm test
./scripts/build-wasm.sh        # SDK size gate (production wasm must stay under the budget)
```

See [`AGENTS.md`](AGENTS.md) for conventions (privacy rules, bounded memory,
adding a rule, adding a provider).

## Privacy

What leaves your app: path templates with ids replaced (`users/{id}/orders`),
operation types, document or child counts, byte sizes, query shapes (field names and
operators), timings, and keyed hashes of ids, filter values and callsites.
Realtime Database sends the JSON byte size of a snapshot (capped) and a
connection count from `goOnline`; that count is not priced.
Cloud Storage sends a path template, extension, byte count, content-type
major, cache-control class (max-age seconds or none), list counts, page-token
presence, and a resumable flag. Object bytes, URLs, and tokens are not sent.
Authentication sends the method template, an operation name, a safe provider
id (`google.com`, `password`, `phone`), a persistence kind (`memory`,
`persistent`, or `unknown`), a force-refresh flag, listener and invocation
ids, list counts, and page-token presence. Emails, phone numbers, uids,
tokens, claims, and verification codes are not sent.
Writes can also send field and payload sizes, transform names (`increment`,
`array_union`, and the others), and a payload hash. That hash is salted per
session inside the process, so the same payload cannot be matched across
sessions. Cache kind and tab visibility are sent too. Never document data.
Set `sampleRate: 0` to send findings only.

## License

[Readmeter Sustainable Use License](LICENSE.md), modeled on n8n's
Sustainable Use License: you may self-host and use Readmeter for your own
internal business or for personal and non-commercial purposes, and share it
free of charge for non-commercial use. You may not sell it, offer it as a
hosted or managed service to others, or include it in a paid product without
a commercial license. This is a source-available license, not an OSI open
source license.
