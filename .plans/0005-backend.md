# 0005: Backend (TypeScript + Postgres)

Status: in progress. Last updated 2026-09-29.

## Stack

- TypeScript on Node 22+, pnpm workspace (`apps/*`, `packages/*`).
- HTTP: Hono on `@hono/node-server`.
- Database: Postgres 17 via `docker-compose.yml` (host port 5442), Drizzle
  ORM with `postgres` (postgres.js). Schema and migrations live in
  `packages/db`, shared by every service.
- Rust core: `crates/bindings/wasm-server`, built into `apps/ingest/wasm`
  by `scripts/build-wasm-server.sh` (git-ignored build output).
- Tests: `node --test` with `tsx`. Postgres tests run when `DATABASE_URL` is set.

## Local setup

```sh
pnpm install
pnpm db:up && pnpm db:migrate && pnpm db:seed        # proj_demo, key rm_dev_key
./scripts/build-wasm-server.sh                        # server core
cargo run -p readmeter-rules --features catalog-toml --bin readmeter-rulec -- build rules target/rules
pnpm dev:ingest                                       # http://127.0.0.1:8090
pnpm run rm project create <id>                     # org_local if missing; prints hash key
pnpm run rm key create <id> --origin http://localhost:5173
pnpm run rm findings
```

## Schema (packages/db/src/schema.ts)

| Table | Holds | Notes |
|---|---|---|
| `organizations` | tenant | console-api will add members |
| `projects` | project per org | `hash_key`: 32 lowercase hex chars, generated at creation. SDK keyed-hash key, not an API secret. `proj_demo` is fixed at `000102030405060708090a0b0c0d0e0f` |
| `api_keys` | SHA-256 of key, display prefix, `allowed_origins`, revoked_at | key itself never stored. `allowed_origins` empty means any origin; otherwise the request `Origin` must match exactly |
| `batches` | one row per accepted request | sdk, session, drop counters |
| `events` | one row per envelope | hashes as hex text; `query`, `units` jsonb |
| `findings` | one row per (project, rule, session, callsite, template) | upsert bumps `occurrences`, `last_seen` |

Changing the schema: edit `schema.ts`, run `pnpm db:generate`, give the
migration a descriptive name, commit it, `pnpm db:migrate`.

## Ingest (`apps/ingest`)

`POST /v1/batches`, `Authorization: Bearer <key>`, body = SDK `flush()` bytes.

1. Body limit 1 MiB (413).
2. Key lookup by SHA-256 in `api_keys`, cached 30 s (401).
3. More than `maxInflight` writes pending: 503 + `Retry-After: 5`.
4. Rust core `ingest()`: decode (400 `bad_batch`), event/finding caps
   (413 `batch_too_large`), window rules.
5. One transaction: batch, events (chunks of 1000), findings upsert.
6. 202 `{events, findings, evaluator_findings, dropped_events}`, only after
   the write committed.

Browser and beacon callers:

- `OPTIONS` and responses on `/v1/*` use Hono `cors`: reflected `Origin`,
  methods `POST, GET, OPTIONS`, headers `authorization, content-type`,
  `Access-Control-Max-Age: 600`, `Vary: Origin`. Preflight has no key, so
  any origin is allowed there.
- `POST /v1/batches`: if the key's `allowed_origins` is non-empty and the
  request `Origin` is not in it, `403 {error: "origin_not_allowed"}`.
  No `Origin` (servers, Cloud Functions) is allowed. Body content type may
  be `application/octet-stream` or absent (`sendBeacon` / keepalive).
- Per-key token bucket in memory: `READMETER_RATE_PER_MIN` (default 600
  batches/min, burst 100). Over the limit: `429` and `Retry-After` (seconds
  until a token, at least 1). Process-local; a restart refills every key.
- `GET /v1/bundle` (Bearer): `bundle.bin` from `READMETER_SDK_BUNDLE`
  (default `target/rules/bundle.bin`), `content-type: application/octet-stream`,
  `ETag` = first 16 hex chars of the file's SHA-256 (computed at startup).
  `If-None-Match` returns 304. Same origin rules as batches.
- `GET /v1/config` (Bearer): `{ "project": id, "hash_key": "..." }`. Same
  origin rules.

## CLI (`apps/cli`, `pnpm run rm`)

TypeScript, run with `tsx`, uses `@readmeter/db`. The root script is `rm`
(`pnpm --filter @readmeter/cli start --`). Invoke it with `pnpm run rm`:
plain `pnpm rm` is pnpm's `remove` alias. Plain aligned text.
`--json` on `findings`, `events` and `stats`.

- `project create <id> [--name <name>] [--org <org_id>]` creates `org_local`
  when that org is missing. Prints the id and hash key.
- `key create <project_id> [--origin <origin>]...` prints the new key once
  (`rm_` + 32 base62 chars), the prefix, the project's hash key, and an
  `init({ apiKey, hashKey, endpoint: "http://127.0.0.1:8090" })` snippet.
- `key list <project_id>`, `key revoke <key_prefix>`.
- `findings [--project <id>] [--since 1h|24h|7d] [--rule <id>] [--limit 50]`:
  severity, rule, template, callsite (8 chars), occurrences, wasted
  (`reads=120 egress_bytes=4k`), relative last seen, message. Sorted by
  severity, then `last_seen` desc.
- `events [--project <id>] [--limit 20]`: latest events.
- `stats [--project <id>]`: batch/event/finding counts and the top 5
  templates by reads over 24h.

## Done

- [x] docker-compose Postgres, Drizzle schema, first migration, seed
- [x] Ingest with Postgres store, key cache, backpressure, findings dedupe
- [x] Tests: HTTP behavior with the real core, Postgres round trip; verified live with the SDK wasm
- [x] `projects.hash_key`, `api_keys.allowed_origins` (`0001_sdk_keys`)
- [x] CORS, origin allowlist, beacon body, per-key rate limit, `GET /v1/bundle`, `GET /v1/config`
- [x] `apps/cli`: project and key management, findings, events, stats

## Next

- [ ] `apps/console-api`: auth (see open question in 0001), orgs, members, projects, API key create/revoke, findings list and detail
- [ ] Rule overrides table, read by ingest per project
- [ ] Retention: delete raw `events` older than N days; daily rollups per (project, template, callsite)
- [ ] Partition `events` by day once volume needs it
- [ ] Per-project rate limits stored on the project (ingest today is a process-local per-key bucket)
- [ ] Cost estimates on findings (`crates/cost` through wasm-server, or prices in Postgres)
