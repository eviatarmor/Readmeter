# AGENTS.md

Guidance for AI agents and humans working in this repository. Read this
before changing code. Plans and design decisions live in [`.plans/`](.plans/).

## What Readmeter is

A self-hosted, MIT-licensed tool that finds cost problems in apps built on backend-as-a-service
providers. Language SDKs report provider calls (Firestore first) through a
`sink` API, with optional drop-in wrappers on top (`.plans/0004`). A shared
Rust core normalizes and redacts them and runs rules that detect wasteful
patterns (`unbounded-list`, `offset-pagination`, `react-double-mount`, ...).
A TypeScript backend stores batches and findings in Postgres. Users operate
the stack on their own infrastructure; product docs and defaults must focus
on self-hosting. The repository and SDK are licensed under MIT.

The Rust core is a **library, never a service**: no network, threads,
storage or clock of its own. SDKs pass calls in and get bytes out; the
backend passes bytes in and gets rows out. Backend services are TypeScript.

Providers: Firebase first (Firestore, then Realtime Database, Storage,
Functions). The design must stay open for Supabase, Vercel and others. Never
hard-code Firebase assumptions outside `crates/providers/firebase`.

## Repository map

Built today:

```
Cargo.toml                 Rust workspace
crates/
  core/                    Envelope, Finding, Units, keyed hashing, Buffer, wire format
  rules/                   RuleDef/RuleSpec/Catalog/Bundle, overrides, Engine, window
                           helpers, generic detectors (detectors/*.rs, one file per rule),
                           `readmeter-rulec` (rules/*.toml -> catalog.json + bundle.json)
  cost/                    Pricing tables -> money (backend/tooling only)
  provider-api/            `Provider` trait + canonical JSON hashing
  providers/firebase/      Firestore raw-call schema, normalization, billing, detectors
  runtime/                 `Client`: what every SDK binding wraps
  evaluator/               Server side: decode, limits, window rules per project, JSON-safe rows
  bindings/ffi/            C ABI (C++, Swift, Kotlin/JNI, Dart, .NET, Python);
                           header in include/readmeter.h (cbindgen, checked in)
  bindings/wasm/           SDK wasm (browser, Node, Deno, Go via wazero); size-gated
  bindings/wasm-server/    evaluator as wasm for the TypeScript backend; not size-gated
apps/
  ingest/                  TypeScript (Hono): auth, core ingest, Postgres write, backpressure
  console-api/             TypeScript (Hono, Better Auth): workspaces, members, projects,
                           API keys, findings, events, rules, costs, Google Cloud connection
  console-web/             React console
  connector-gcp/           Worker: retention (daily rollups, deletes) and Cloud
                           Monitoring and billing-export sync
packages/
  db/                      Drizzle schema, migrations, seed (shared by all TS services)
docs/                      Fumadocs site (Next.js): pnpm --filter docs dev (port 3100);
                           rule pages are generated from rules/ by docs/scripts/gen-rules.mjs
Dockerfile                 Deployable server image (console, ingest, worker, migrations)
deploy/                    Production Compose stack and environment template
RELEASING.md               npm, GHCR and GitHub release setup
docker-compose.yml         Local Postgres on host port 5442
rules/<scope>/*.toml       Rule definitions (data). Scope: generic/, firebase/firestore/, ...
pricing/<provider>/*.toml  Price tables (data)
conformance/fixtures/      Raw calls -> expected envelopes/findings, shared with SDK shims
sdks/js/firebase/          @readmeter/firebase: web drop-in and Cloud Functions admin instrumentation
sdks/js/react/             @readmeter/react: component mount ids for the react-double-mount rule
sdks/python/readmeter/     `readmeter` (Python): sink API over the C ABI via ctypes, stdlib only
scripts/                   build-wasm.sh (size gate), build-wasm-server.sh, smoke-wasm.mjs, smoke-ffi.sh
.github/workflows/ci.yml   Rust checks, wasm size gate + smoke, header drift, C smoke, TS + Postgres
.plans/                    Architecture and implementation plans
```

Planned: `proto/` (if a non-Rust consumer of the wire format appears),
SDKs for other languages (`sdks/<lang>/<provider>/`), `infra/`.

## Rules you must not break

1. **Privacy.** Raw calls (JSON from SDK shims) may contain concrete ids,
   filter values and cursors. Envelopes must not. Anything that leaves the
   process is a template (`users/{id}/orders`), a size, a count, or a keyed
   hash. Add a leak test when you add a field (see
   `no_raw_values_or_ids_leak` in `providers/firebase/.../normalize.rs`).
2. **Never break the host app.** No panics in library code (clippy denies
   `unwrap`, `expect`, `panic`). Bad input returns an error. The FFI layer
   catches unwinds. Buffers drop oldest data when full; nothing blocks.
3. **Bounded memory.** Every detector map uses `rules::window::{KeyedWindow,
   BoundedMap}` or an explicit cap. No unbounded `HashMap` growth.
4. **Provider-agnostic core.** `core`, `rules`, `runtime`, `cost` and bindings
   know nothing about any provider. Provider logic lives in
   `crates/providers/<name>`, behind the `Provider` trait, and is selected by
   cargo features.
5. **Rules are data plus a detector.** Metadata, severity and thresholds live
   in `rules/**/*.toml`; detection logic is Rust registered under the same id.
   Thresholds are params, never constants in the detector.
6. **Small SDKs.** Bindings expose strings/bytes only. Do not add heavy
   dependencies to `core`, `rules`, `provider-api`, providers or `runtime`
   without measuring the wasm size (see "Commands"). On the SDK path there is no `serde_json` (the build script checks); parse
   JSON with `readmeter_provider_api::json` and write it by hand. Avoid
   `BTreeMap` (use `readmeter_core::VecMap`), `#[serde(untagged)]`, and
   formatting floats. Window detectors sit behind the
   `window` feature; production SDK builds leave it off.
7. **Billing semantics belong to the provider.** Providers compute `Units`
   at normalization time. Prices belong in `pricing/`, never in code.
8. **The wire format is versioned.** Changing any serialized type in `core`
   means bumping `SCHEMA_VERSION` and keeping ingest able to decode old
   versions.
9. **One database: Postgres, through Drizzle.** No ClickHouse, Pub/Sub or
   other stores. Schema changes go through `packages/db` migrations.
10. **No detection logic in TypeScript.** The backend calls the Rust core
    (`bindings/wasm-server`) for decoding and rules. JS cannot hold u64, so
    hashes cross as 16-char hex strings (`crates/evaluator/src/rows.rs`).

## Adding a rule

1. Choose the scope: `generic/<name>` if it only needs envelope fields and
   applies to every provider, else `<provider>.<service>/<name>`.
2. Write `rules/<scope>/<name>.toml`. Required: `id`, `title`, `provider`,
   `service`, `severity`, `category`, `evaluation`, `status`, `summary`,
   `description`, `fix`. Optional: `default_enabled`, `docs`, `[params]`,
   `[[examples]]`. Copy an existing file.
3. Severity is ranked by **cost impact**:
   - `critical`: cost grows without bound with data size or traffic
   - `high`: large multiplier on cost (roughly 5x or more)
   - `medium`: measurable waste on a hot path
   - `low`: minor waste, or latency/throughput only
   - `info`: an observation, no direct waste
4. `evaluation`: `local` (one envelope, runs in SDKs), `window` (one
   session's recent envelopes; backend, and SDKs in dev), `aggregate` (across
   sessions; backend only).
5. Implement the detector in `crates/rules/src/detectors/<name>.rs` (generic)
   or `crates/providers/<p>/src/<service>/detectors/<name>.rs`, with
   `pub const ID`, `pub fn build(&Params)`, and register it in that module's
   `mod.rs`. Parse all params in `build`.
6. Fill `wasted` on findings when the waste is computable (e.g. offset reads).
7. Tests: at least one firing case and one close non-firing case, using
   `readmeter_rules::testing::{EnvBuilder, single_rule_engine, run}`. The
   runtime end-to-end tests fail if a detector has no TOML or an enabled
   non-aggregate rule has no detector. For user-visible behavior, add a
   fixture under `conformance/fixtures/` too (format in `conformance/README.md`).
   Window detectors: gate the module and its registration with
   `#[cfg(feature = "window")]`.
8. Rules without a detector yet use `status = "planned"` and
   `default_enabled = false`.

## Adding a provider

1. Create `crates/providers/<name>` implementing `readmeter_provider_api::Provider`:
   raw-call schema (`raw.rs`), `normalize`, billing units, detectors. One
   cargo feature per service.
2. Add a `<name>` feature to `crates/runtime` and to both bindings, and a
   match arm in `runtime::provider_by_id`.
3. Add `pricing/<name>/<service>.toml` and rules under `rules/<name>/<service>/`.
4. Reuse generic rules wherever envelopes already express the pattern.

## TypeScript conventions

- pnpm workspace, ESM, strict TypeScript, run directly with `tsx` (no build step).
- Services take their dependencies (`core`, `store`) as arguments so tests
  can swap the store; tests use the real Rust core, not mocks of it.
- Tests: `node --test`. Postgres tests skip unless `DATABASE_URL` is set.

## Rust conventions

- Edition 2024, workspace lints (`unsafe_code` denied except in
  `bindings/ffi`; `unwrap/expect/panic` denied outside tests).
- Library errors use `thiserror`; no `anyhow` in libraries.
- Keep comments for *why*; docs on public items say what callers need to know.
- Test helpers go in `rules::testing` (feature `testing`), not copied per crate.

## Commands

```sh
cargo test --workspace --all-features
cargo clippy --workspace --all-features --all-targets -- -D warnings
cargo fmt --all

# Rule catalog check / build artifacts
cargo run -p readmeter-rules --features catalog-toml --bin readmeter-rulec -- check rules
cargo run -p readmeter-rules --features catalog-toml --bin readmeter-rulec -- build rules target/rules

# SDK size gate + JS smoke test (needs wasm32 target, wasm-bindgen-cli, Node)
./scripts/build-wasm.sh && node scripts/smoke-wasm.mjs

# Bytes per crate in the production wasm, before wasm-opt (needs twiggy; not in CI)
./scripts/wasm-size-report.sh

# C ABI: regenerate header after changing bindings/ffi, then smoke test
(cd crates/bindings/ffi && cbindgen --config cbindgen.toml --crate readmeter-ffi --output include/readmeter.h)
./scripts/smoke-ffi.sh          # CC=cl from a VS developer shell on Windows

# Backend (TypeScript + Postgres)
pnpm install
pnpm db:up && pnpm db:migrate && pnpm db:seed    # local Postgres, proj_demo / rm_dev_key
./scripts/build-wasm-server.sh                   # Rust core for the backend
pnpm typecheck && DATABASE_URL=postgres://readmeter:readmeter@127.0.0.1:5442/readmeter pnpm test
pnpm dev:ingest                                  # http://127.0.0.1:8090
pnpm dev:console-api                             # http://127.0.0.1:8091
pnpm dev:connector-gcp                           # Monitoring and billing sync loop
                                                 # seeded login admin@readmeter.local / readmeter-dev
READMETER_INGEST_URL=http://127.0.0.1:8090 READMETER_API_KEY=rm_dev_key node scripts/smoke-wasm.mjs

# Local demo loop. See docs/content/docs/getting-started/your-app.mdx (Git Bash on Windows).
./scripts/dev-up.sh
./scripts/dev-down.sh                            # stop ingest, console-api, connector-gcp, console-web, and docker compose down (volume kept)
./scripts/e2e.sh                                 # emulators, Postgres findings, Playwright
pnpm --filter docs dev                           # docs site on http://localhost:3100 (build: pnpm --filter docs build)
```

All three of test, clippy and fmt must pass before you consider work done.
If you touched the SDK path, also run the size gate. If you touched
`crates/evaluator` or the TS apps, rebuild the server core and run the TS tests.

## Out of scope right now

- Storing telemetry in Firestore, or in any database other than Postgres.
- Non-Firebase providers: keep the seams open, but do not build them yet.
- A CLI. The console (`apps/console-web` + `apps/console-api`) replaces it
  (`.plans/0007-console.md`).

## Plans

`.plans/` is local only: it is git-ignored and never pushed.

Before starting significant work, read the relevant file in `.plans/`. When a
decision changes, update the plan in the same change. Mark finished tasks.

## Workflow: planner and executor

Work is split between two agents:

- **Planner (Claude):** owns `.plans/`, architecture decisions, task
  breakdown and review. Writes each task so it can be executed without
  extra context: goal, files to touch, acceptance criteria (tests, commands
  that must pass), and the rules above that apply.
- **Executor (Grok 4.7):** implements tasks from `.plans/` exactly as
  written, runs the commands in "Commands", and ticks the task. If a task is
  ambiguous or conflicts with this file, stop and ask the planner instead of
  deciding; do not change decisions or plans on your own.

The planner reviews executor changes against the plan and this file before
a task counts as done.
