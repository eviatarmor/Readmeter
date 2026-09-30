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

![Overview](docs/public/images/console-overview.png)

![Findings](docs/public/images/console-findings.png)

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
  (and in the SDK in dev mode). `aggregate` rules look across all sessions
  of a project (backend).
- **Capture.** Web: drop-in wrappers around the modular Firestore, Realtime
  Database, and Cloud Storage SDKs, plus a `sink()` API for manual use. Cloud
  Functions / Node: interception of the Admin SDK (`instrument(db)` for
  Firestore, `instrumentDatabase(db)` for Realtime Database,
  `instrumentStorage(bucket)` for Cloud Storage).
- **Never breaks your app.** The SDK never throws into your code, never
  changes what Firestore returns, drops old data when buffers fill, and does
  its work after your call has returned.

Contributor and agent guide: [`AGENTS.md`](AGENTS.md).

## Rules (70 active)

Severity is ranked by cost impact: `critical` grows without bound with data
or traffic, `high` is a large multiplier, `medium` is measurable waste on a
hot path, `low` is minor waste or latency only, `info` is an observation.

| Service | Active | Planned |
|---|---|---|
| Cloud Firestore | 38 | 3 |
| Realtime Database | 5 | 1 |
| Cloud Storage | 6 | 0 |
| Authentication | 5 | 0 |
| Cloud Functions | 4 | 1 |
| Generic (any service) | 12 | 0 |

Each rule is a TOML file in [`rules/`](rules/) (id, severity, description,
fix, thresholds) plus a Rust detector. The docs site has the full reference,
generated from those files, and the console lists them on the Rules page.

## Self-hosted deployment

Release images run on Linux amd64 and arm64. The production stack includes
Postgres, automatic migrations, ingest, and the web console; Google Cloud sync
is optional. No Rust toolchain or source build is needed on the deployment host.

```sh
cp deploy/.env.example deploy/.env
# Fill in POSTGRES_PASSWORD and BETTER_AUTH_SECRET; set your public URLs.
docker compose --env-file deploy/.env -f deploy/compose.yml up -d
```

Open the console at `http://localhost:8091`, sign up, create a workspace and
project, and generate an API key. Use HTTPS behind a reverse proxy for a remote
deployment. Pin `READMETER_IMAGE` to a release version for production.

Install the released SDK in your app:

```sh
npm install @readmeter/firebase firebase
```

Point `init({ apiKey, endpoint })` at your own ingest URL. The package includes
both wasm builds and the default rules. Before the first npm release, use the
tarball built by `pnpm sdk:build` and `pnpm pack`.

See [production deployment](docs/content/docs/self-hosting/production.mdx)
and [release setup](RELEASING.md). Tagged releases publish the SDK to npm,
the server image to GHCR, and deployment files and an SDK tarball to GitHub Releases.

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

**Use it with your own app:** [`docs/content/docs/getting-started/your-app.mdx`](docs/content/docs/getting-started/your-app.mdx)
(create a key, install the SDK, change one import, instrument your
functions, and expose ingest with a tunnel if your app is deployed).

## Documentation

The docs site lives in [`docs/`](docs/) (Fumadocs). Run it locally:

```sh
pnpm --filter docs dev   # http://localhost:3100
```

It covers the quickstart, the SDK for each Firebase service, the console,
self-hosting and configuration, the ingest and console APIs, and the rule
reference (generated from `rules/`).

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
| `docs/` | Documentation site (Fumadocs) |

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

[MIT](LICENSE.md).
