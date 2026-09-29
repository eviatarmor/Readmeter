# Task E: Backend pieces the SDKs need (CORS, keys, bundle, CLI)

Planner: Claude. Executor: Grok. Status: done 2026-09-29 (reviewed).

Goal: a browser app and Cloud Functions can send batches to a local ingest,
and the developer can create a project key and read findings from a
terminal (the console UI stays design-only).

## 0. Read first

`AGENTS.md`; `.plans/0005-backend.md`; `packages/db/src/*`; `apps/ingest/src/*`
and tests; `docker-compose.yml`; root `package.json`.

## 1. Schema (Drizzle migration `0001_sdk_keys`)

- `projects.hash_key` text not null: 32 lowercase hex chars (128-bit),
  generated at project creation. Backfill existing rows in the migration
  with `encode(gen_random_bytes(16), 'hex')` (enable `pgcrypto` in the
  migration) or generate in the seed; seed `proj_demo` gets a fixed dev value
  `000102030405060708090a0b0c0d0e0f` so tests and docs can use it.
- `api_keys.allowed_origins` text[] not null default `'{}'`: empty means any
  origin (dev); otherwise the request `Origin` must match exactly.
- Generate with `pnpm db:generate`, rename the file to `0001_sdk_keys.sql`
  (and the journal tag) like `0000_init`. Keep the seed idempotent.

## 2. Ingest changes (`apps/ingest`)

- CORS for `/v1/*`: answer `OPTIONS` preflight with
  `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Methods: POST, GET, OPTIONS`,
  `Access-Control-Allow-Headers: authorization, content-type`,
  `Access-Control-Max-Age: 600`, `Vary: Origin`. Use Hono's `cors` middleware
  if it does this cleanly (check its docs with Context7 first), else write it.
  Preflight carries no key, so it is allowed for any origin; the origin
  allowlist is enforced on the POST.
- `Store.projectForKey` returns `{ projectId, allowedOrigins, hashKey }` (update
  the interface, `PgStore`, `MemoryStore` in tests). Cache as today.
- POST `/v1/batches`: if `allowedOrigins` is non-empty and the request has an
  `Origin` header not in the list, answer 403 `{error: "origin_not_allowed"}`.
  Requests without `Origin` (servers, Cloud Functions) are allowed.
- Beacon/keepalive: accept `content-type` `application/octet-stream` or none.
- Per-key rate limit: token bucket in memory, `READMETER_RATE_PER_MIN`
  (default 600 batches/min per key, burst 100). Over the limit: 429 with
  `Retry-After` (seconds until a token is available, at least 1).
- `GET /v1/bundle` (Bearer key): returns `bundle.bin` (the SDK bundle file
  path from `READMETER_SDK_BUNDLE`, default `target/rules/bundle.bin`) with
  `content-type: application/octet-stream`, `ETag` = first 16 hex chars of the file's SHA-256 (computed at startup), and
  `If-None-Match` -> 304. Same CORS and origin rules.
- `GET /v1/config` (Bearer key): `{ "project": id, "hash_key": "..." }` so SDKs
  can get the hash key from the API key alone. Same CORS and origin rules.
- Tests: preflight, origin allowed/denied/absent, 429 with Retry-After,
  bundle 200/304, config. Existing tests keep passing.

## 3. CLI (`apps/cli`, package `@readmeter/cli`, bin `rm`)

TypeScript, run with `tsx`, uses `@readmeter/db`. Root script `"rm": "pnpm --filter @readmeter/cli start --"`
so `pnpm rm <command>` works. Commands:

- `project create <id> [--name <name>] [--org <org_id>]` (creates org `org_local` if missing), prints id and hash key.
- `key create <project_id> [--origin <origin>]...` prints the new API key once
  (format `rm_` + 32 random base62 chars) and the project's hash key, plus a
  ready-to-paste `init({...})` snippet with `endpoint: "http://127.0.0.1:8090"`.
- `key list <project_id>`, `key revoke <key_prefix>`.
- `findings [--project <id>] [--since 1h|24h|7d] [--rule <id>] [--limit 50]`:
  table sorted by severity then `last_seen` desc: severity, rule, template,
  callsite (8 chars), occurrences, wasted (compact `reads=120 egress_bytes=4k`), last seen (relative), message.
- `events [--project <id>] [--limit 20]`: latest events (ts, op, template, items, units).
- `stats [--project <id>]`: counts of batches/events/findings and top 5 templates by reads over 24h.
- Output: plain aligned text, no color dependency; `--json` flag on
  `findings`, `events`, `stats` prints JSON instead.
- Tests: command parsing and formatting as unit tests; one Postgres test
  (skipped without `DATABASE_URL`) that creates a project and key and lists findings.

## 4. Docs and plans

- `.plans/0005-backend.md`: add the endpoints, CLI and schema changes; tick done items.
- `AGENTS.md`: repository map line for `apps/cli`; Commands: `pnpm rm findings`.

## 5. Checks

```sh
pnpm install && pnpm typecheck
docker compose up -d --wait postgres
pnpm db:migrate && pnpm db:seed
DATABASE_URL=postgres://readmeter:readmeter@127.0.0.1:5442/readmeter pnpm test
pnpm rm project create demo_web && pnpm rm key create demo_web --origin http://localhost:5173
cargo test --workspace --all-features     # untouched, must still pass
```

Report: files, check results, deviations and why.
