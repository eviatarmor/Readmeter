# 0001: Architecture

Status: accepted. Last updated 2026-09-29.

## Goal

Hosted SaaS that tells teams building on BaaS providers where they are
wasting money, down to the callsite, with an estimated saving per finding.
Firebase first, starting with Firestore. Supabase, Vercel and others must be
addable without restructuring.

## Shape of the system

```
customer app
  └─ language SDK (TS, Go, Python, C++, ...)   sink(query, result) + optional drop-in wrappers
       └─ Rust core (wasm or C ABI)             normalize + redact, local rules, buffer, encode bytes
            └─ host POSTs bytes ───────────────► apps/ingest (TypeScript, Hono)
                                                   ├─ Rust core (wasm-server): decode, limits, window rules
                                                   └─ Postgres (Drizzle): batches, events, findings
apps/connectors/<provider>  pull usage from provider APIs (GCP Monitoring, Vercel API, Supabase mgmt)
apps/console-api            TypeScript + Drizzle on the same Postgres: auth, orgs, members,
                            projects, API keys, hash keys, rule config, findings queries, billing
apps/console-web            frontend: login, signup, org switcher, dashboard (design only for now)
rule CDN                    signed rule bundles (definitions + tenant overrides) for SDKs
```

The Rust core is a library, never a service. It has no network, threads,
storage or clock of its own: the host passes calls and timestamps in and
gets bytes (SDK) or rows (server) back. Every backend service is
TypeScript; it calls the same core through `crates/bindings/wasm-server`.

One Postgres (docker-compose locally) holds both the control plane
(`organizations`, `projects`, `api_keys`) and telemetry (`batches`,
`events`, `findings`), schema in `packages/db` (Drizzle).

## Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | One Rust core; wasm for JS/Go, C ABI for everything else | Wasm needs a runtime in Python/Java/.NET (MBs); native is smaller there. Go uses wazero (pure Go, no cgo). |
| D2 | Providers are plugins behind a `Provider` trait, one crate per provider, one cargo feature per service | Supabase/Vercel added without touching core; SDK builds carry only what they wrap. |
| D3 | Raw calls cross the language boundary as JSON | Every host can produce it with no codegen. The core parses once and redacts before anything leaves. |
| D4 | Wire format is postcard with a `RM` + version header, not protobuf | Only the Rust core encodes (SDK) and decodes (ingest, through wasm-server). Revisit if a non-Rust consumer appears; then add `proto/`. |
| D5 | Rules = TOML definition + Rust detector under the same id | Severity/thresholds/docs change without an SDK release; logic stays testable and typed. A general DSL (CEL) is deferred until rules need tenant-written logic. |
| D6 | Three evaluation tiers: `local`, `window`, `aggregate` | SDKs run cheap local rules; backend runs windowed and cross-session rules; dev builds can opt into window rules for instant warnings. |
| D7 | Keyed SipHash (per-project key) for ids, values and callsites | Equality comparisons work in the backend; low-entropy values cannot be brute-forced without the key, which is never sent with events. |
| D8 | Session-level sampling | Window rules need complete sequences; per-event sampling would break them. Findings are always sent. |
| D9 | Providers compute billable units; prices live in `pricing/` | Billing semantics are provider knowledge; prices change often and are data. |
| D10 | Server SDKs intercept at gRPC (interceptors) where possible; client SDKs wrap the API surface | One interception point per server language with exact sizes; web/mobile SDKs hide their transport. |
| D11 | Telemetry never goes to Firestore | It would cost customers' kind of money and undercut the product. |
| D12 | Console split into `console-web` and `console-api` | Login, orgs, keys, billing need a real backend, not only a dashboard. |
| D13 | Two SDK builds per language: production (local rules) and dev (local + window rules), via the `window` cargo feature | Production pays only for what it runs; dev gets instant warnings. Window rules always run on the backend anyway. |
| D14 | SDKs receive `RuleSpec`s, not full rule definitions | Descriptions, docs and examples never ship in customer apps; bundle is ~5x smaller. |
| D15 | Postgres is the only database (Drizzle ORM), local via docker-compose. No ClickHouse, no Pub/Sub | One store to run and operate. Revisit only with measured pain: then partition `events` by day first, and consider TimescaleDB (still Postgres) before a second database. |
| D16 | Backend services are TypeScript (Hono + Drizzle). Rust is a library only | The core stays small and embeddable. Ingest decodes and runs window rules by calling the core through `bindings/wasm-server`, so detection logic is never re-implemented. |
| D17 | SDK surface is a `sink` API in every language, with optional drop-in wrappers on top | See 0004. The sink works with every provider SDK version; wrappers add automatic coverage where it is worth maintaining. |

## Target layout

```
readmeter/
  crates/                  (built; see 0002)
  rules/<scope>/*.toml     (built; see 0003)
  pricing/<provider>/*.toml
  sdks/<lang>/{core,<provider>,react}/   language first: each ecosystem keeps its tooling
  apps/console-web/  apps/console-api/  apps/ingest/  apps/connectors/<provider>/   (TypeScript)
  packages/db/             Drizzle schema + migrations shared by ingest and console-api
  docker-compose.yml       local Postgres
  conformance/fixtures/<provider>/<service>/   same raw calls in, same envelopes out, every language
  infra/                   terraform
  providers.yaml           provider -> services -> sdks/connectors; drives the CI matrix
```

## Phases

1. **Rust foundation.** Envelope, rules engine, Firestore provider, runtime,
   bindings, first rule catalog. *In progress, see 0002.*
2. **First SDKs.** `@readmeter/firebase` (web modular SDK wrapper, wasm) and
   Node Admin (gRPC interceptor), tested against the Firestore emulator.
   `@readmeter/react` for mount ids.
3. **Backend MVP.** `console-api` (auth, orgs, projects, API + hash keys),
   `ingest`, Postgres schema, findings API, rule CDN.
   *Started early: `apps/ingest` (TypeScript) stores batches, events and
   deduped findings in Postgres, with window rules from the Rust core;
   `console-api` is next.*
4. **Server languages.** Go (gRPC interceptor + wazero), Python (PyO3 or C
   ABI), Java (JNI), .NET.
5. **Client-native languages.** C++, Swift, Kotlin, Dart through the C ABI.
   GCP Monitoring connector for zero-install baseline.
6. **Second provider.** Supabase (`createClient({ global: { fetch } })`
   interception, PostgREST rules). Then Vercel (connector-only: usage API and
   log drains).

## Open questions

- Console auth: build vs WorkOS/Clerk/Firebase Auth. Leaning WorkOS for SSO.
- Event retention in Postgres: raw events are large; keep N days of raw
  events plus daily rollups per (project, template, callsite, rule)?
- Pricing model: per ingested event vs share of savings. Affects sampling defaults.
- Whether the web SDK ships a pure-TS capture mode for production (smaller
  than wasm) and loads wasm only in dev. Decide after the wasm size work in 0002.
