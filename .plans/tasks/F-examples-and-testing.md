# Task F: Examples, end-to-end run, and "test it with your app" guide

Planner: Claude. Executor: Grok. Status: done. Written 2026-09-29.

Goal: one command brings up everything locally and proves the loop
(web app + Cloud Function -> ingest -> Postgres -> `pnpm run rm findings`), and a
guide lets the user plug their own Firebase web app and functions in.

## 1. `examples/web-firestore` (Vite + TypeScript, no framework)

- Uses `firebase` and `@readmeter/firebase` (workspace dependency), imports
  Firestore from `@readmeter/firebase/firestore`, connects to the Firestore
  emulator when `VITE_USE_EMULATOR=1` (default in `.env.example`), else to the
  project in `VITE_FIREBASE_CONFIG` (JSON).
- `init({ apiKey, hashKey, endpoint, dev: true })` from `VITE_READMETER_*` env.
- A page with one button per pattern, each doing the bad thing once, labeled
  with the rule it should trigger: unbounded list, offset pagination,
  "load more" by growing limit, count via fetch, get then listen,
  listener per item (30 doc listeners), search per keystroke (an input that
  queries on every keystroke), write per keystroke (a text field saving on
  every input), batch of tiny writes, plus a "seed data" button that writes
  sample data (300 posts, 50 users) to the emulator. A log area shows local
  findings via `onFinding`.
- `pnpm --filter web-firestore dev` serves on port 5173.

## 2. `examples/functions` (Cloud Functions v2, TypeScript)

- `firebase-functions` + `firebase-admin` + `@readmeter/firebase`.
- `instrument(getFirestore())`, handlers wrapped with `withFlush`.
- HTTP functions: `unboundedReport` (reads a whole collection),
  `nPlusOne` (reads 50 docs one by one), `offsetPage` (offset 200),
  `fanout` (one batch writing 150 docs).
- Runs in the Functions emulator: `firebase.json` at `examples/` with
  emulators `firestore` (8080 is taken on the planner's machine: use 8085),
  `functions` (5001), `ui` disabled; project `demo-readmeter`.
- Readmeter config from `functions/.env` (`READMETER_API_KEY`, `READMETER_HASH_KEY`,
  `READMETER_ENDPOINT=http://127.0.0.1:8090`), `.env.example` checked in.
- Functions must build with `tsc` into `lib/`; the `@readmeter/firebase`
  dependency is the packed tarball (`file:` path) because the Functions
  emulator installs from `package.json`; the build script packs it first.

## 3. One-command local run: `scripts/dev-up.sh`

Idempotent, prints each step:
1. `docker compose up -d --wait postgres`, `pnpm db:migrate`, `pnpm db:seed`.
2. rulec build, `build-wasm-server.sh`, SDK build (`pnpm sdk:build`).
3. Create project `demo_local` + key (skip if exists; store key and hash key in `.readmeter/local.env`, git-ignored) and write the examples' `.env` files from it.
4. Start ingest (background, log to `target/dev/ingest.log`), wait for `/healthz`.
5. Print next steps: `npx firebase-tools emulators:start --project demo-readmeter` in `examples/`, `pnpm --filter web-firestore dev`, then `pnpm run rm findings --project demo_local`.

`scripts/dev-down.sh` stops ingest (pid file) and `docker compose down` (keeps the volume).

## 4. End-to-end test: `scripts/e2e.sh` (+ CI job)

Runs `dev-up.sh`, then under `firebase emulators:exec --only firestore,functions`:
- a Node script (`examples/e2e/run.ts`) that drives the web example's
  scenarios headlessly: import the same scenario functions the page uses
  (put them in `examples/web-firestore/src/scenarios.ts`, used by both the
  page and the e2e) in Node with the web SDK against the emulator, calls
  `flush()`, calls each HTTP function once;
- then asserts via `pnpm run rm findings --project demo_local --json` that each
  expected rule appears at least once (web rules with source `sdk` or
  `evaluator`, function rules from the functions).
Exit non-zero with a list of missing rules. Add a CI job `e2e` (Postgres
service, Java 21, Node 22, Rust + wasm target) that runs it.

**Real browser check** (`examples/web-firestore/e2e/browser.spec.ts`,
Playwright + Chromium, run by `scripts/e2e.sh` after the Node part): build
the example with `vite build`, serve it with `vite preview`, open it, click
"seed data" then "unbounded list" and "offset pagination", wait for the log
area to show both local findings, then assert both rules via the CLI. This
is the check that the wasm loads through a real bundler in a real browser;
it must not be skipped when Playwright is installable
(`npx playwright install chromium`).

## 5. Guide: `docs/TESTING-WITH-YOUR-APP.md`

Short, step-by-step, copy-paste commands. Sections:
1. Prerequisites (Docker, Node 22, pnpm, Rust + wasm32 target, wasm-bindgen-cli, Java for emulators).
2. `./scripts/dev-up.sh`.
3. Create a key for your app: `pnpm run rm project create my_app && pnpm run rm key create my_app --origin http://localhost:5173`.
4. Web app: `npm install <repo>/sdks/js/firebase/readmeter-firebase-0.1.0.tgz`,
   `init(...)` once at startup, replace `from "firebase/firestore"` with
   `from "@readmeter/firebase/firestore"`; `dev: true` to see findings in the console.
5. Cloud Functions: install the tarball in `functions/`, `instrument(getFirestore())`,
   wrap handlers with `withFlush`. Local: run the Functions emulator (it reaches
   `127.0.0.1:8090`). Deployed functions and deployed web apps cannot reach
   your laptop: expose ingest with a tunnel (`cloudflared tunnel --url http://127.0.0.1:8090`)
   and use the tunnel URL as `endpoint`, adding the deployed origin with `--origin`.
6. See results: `pnpm run rm findings --project my_app`, `pnpm run rm events`, `pnpm run rm stats`.
7. What is sent (privacy) and how to turn it off (`sampleRate: 0` keeps only findings).
8. Troubleshooting: 401 (key), 403 (origin), no events (debug: true), CORS, wasm not loading (bundler must support `new URL(..., import.meta.url)`).

Link it from `AGENTS.md` (Commands) and `sdks/js/firebase/README.md`.

## 6. Checks

`./scripts/e2e.sh` passes locally; all previous checks still pass.

Report: files, check results (including the e2e rule list), deviations.
