# Testing Readmeter with your app

Commands are for Git Bash on Windows and bash on Linux. Findings land in Postgres. The console API is at `http://127.0.0.1:8091`. The seeded login is `admin@readmeter.local` / `readmeter-dev`.

## 1. Prerequisites

- Docker (Postgres)
- Node.js 22 and pnpm 10
- Rust, the `wasm32-unknown-unknown` target, and `wasm-bindgen-cli` (same version as `Cargo.lock`)
- Java 21 (the Firestore and Functions emulators). Java 17 also works locally.
- A checkout of this repo

```sh
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version 0.2.129
```

## 2. Start the local backend

From the repo root:

```sh
./scripts/dev-up.sh
```

That starts Postgres on port 5442, migrates and seeds it, builds the rules and the SDK, creates project `demo_local`, starts ingest at `http://127.0.0.1:8090`, and starts the console API at `http://127.0.0.1:8091`. The API key and hash key are written to `.readmeter/local.env` (git-ignored).

Stop ingest, the console API, and the Postgres container with `./scripts/dev-down.sh`. The database volume is kept. `./scripts/dev-down.sh --keep-postgres` stops ingest and the console API and leaves Postgres running.

The demo emulator config is `examples/firebase.json`: Firestore on **8085** (8080 is often taken), Functions on 5001.

```sh
cd examples && npx -y firebase-tools@latest emulators:start --project demo-readmeter
pnpm --filter web-firestore dev
```

`pnpm --filter web-firestore dev` serves the demo on port 5173. Each button runs one wasteful Firestore pattern. Findings show up in the page log and in Postgres. Sign in to the console API as `admin@readmeter.local` / `readmeter-dev` and open workspace `local`, project `demo_local`:

```sh
curl -c cookies.txt -H "Origin: http://localhost:5174" -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@readmeter.local\",\"password\":\"readmeter-dev\"}" \
  http://127.0.0.1:8091/api/auth/sign-in/email
curl -b cookies.txt -H "Origin: http://localhost:5174" \
  "http://127.0.0.1:8091/api/v1/workspaces/local/findings?project=demo_local"
```

## 3. Create a key for your app

Sign in the same way, then create a project and a key in workspace `demo` (or any workspace you own). The key secret is returned once. `allowedOrigins` lists every browser origin you will send from, including `http://127.0.0.1:5173` when that is what the browser uses. An empty list allows any origin. The project response includes `hashKey` and SDK snippets; the snippet uses the placeholder `YOUR_API_KEY` for the secret.

```sh
curl -b cookies.txt -H "Origin: http://localhost:5174" -H "Content-Type: application/json" \
  -d "{\"name\":\"my_app\"}" \
  http://127.0.0.1:8091/api/v1/workspaces/demo/projects
curl -b cookies.txt -H "Origin: http://localhost:5174" -H "Content-Type: application/json" \
  -d "{\"name\":\"local\",\"allowedOrigins\":[\"http://localhost:5173\"]}" \
  http://127.0.0.1:8091/api/v1/workspaces/demo/projects/PROJECT_ID/keys
```

## 4. Web app

Pack the SDK if you have not already (`pnpm sdk:build` then `pnpm pack` in `sdks/js/firebase`):

```sh
npm install /path/to/Readmeter/sdks/js/firebase/readmeter-firebase-0.1.0.tgz firebase
```

Call `init` once at startup. Replace `from "firebase/firestore"` with `from "@readmeter/firebase/firestore"`.

```ts
import { init } from "@readmeter/firebase";
import { getDocs, query, collection, where } from "@readmeter/firebase/firestore";

init({
  apiKey: "rm_...",
  hashKey: "0123456789abcdef0123456789abcdef",
  endpoint: "http://127.0.0.1:8090",
  dev: true,
});
```

`dev: true` runs window rules in the page and prints each finding. Leave it off in production.

## 5. Cloud Functions

Install the same tarball in `functions/`, then instrument Firestore and wrap every handler:

```ts
import { init } from "@readmeter/firebase";
import { instrument, withFlush } from "@readmeter/firebase/admin";
import { getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";

init({
  apiKey: process.env.READMETER_API_KEY ?? "",
  hashKey: process.env.READMETER_HASH_KEY,
  endpoint: process.env.READMETER_ENDPOINT ?? "http://127.0.0.1:8090",
  platform: "server",
});

const db = instrument(getFirestore());

export const report = onRequest(withFlush(async (_req, res) => {
  const snap = await db.collection("orders").get();
  res.json({ n: snap.size });
}));
```

The Functions emulator on your machine can reach `http://127.0.0.1:8090`. A deployed function or a deployed web app cannot reach your laptop. Expose ingest and use that URL as `endpoint`:

```sh
cloudflared tunnel --url http://127.0.0.1:8090
```

Put the tunnel URL in `endpoint`. Create a key whose `allowedOrigins` includes the deployed site (`https://your-app.web.app`).

## 6. See results

With the same signed-in cookie:

```sh
curl -b cookies.txt -H "Origin: http://localhost:5174" \
  "http://127.0.0.1:8091/api/v1/workspaces/demo/findings?project=PROJECT_ID&rule=firebase.firestore/unbounded-list"
curl -b cookies.txt -H "Origin: http://localhost:5174" \
  "http://127.0.0.1:8091/api/v1/workspaces/demo/events?project=PROJECT_ID"
curl -b cookies.txt -H "Origin: http://localhost:5174" \
  "http://127.0.0.1:8091/api/v1/workspaces/demo/overview?project=PROJECT_ID&range=7d"
```

Findings accept `severity`, `status`, `from`, and `to` as query parameters. Costs are integer USD micros from the Rust price tables.

## 7. What is sent

A call leaves the process as a path template (`users/{id}/orders`), a count, a size, or a keyed hash. Document fields, filter values, and raw ids are not sent. The hash key is not an API secret. The API key is.

`init({ sampleRate: 0 })` keeps local findings and uploads no call batches.

## 8. Troubleshooting

- **401.** The API key is missing, revoked, or not the `Authorization: Bearer` value. Create a new key. The old one cannot be printed again.
- **403 `origin_not_allowed`.** The browser `Origin` is not on the key. Create a key whose `allowedOrigins` includes the exact origin (`http://localhost:5173`, not `http://localhost:5173/`).
- **No events.** Set `debug: true` on `init`. The SDK logs each raw call with `console.debug`. Confirm ingest is up: `curl http://127.0.0.1:8090/healthz`.
- **CORS.** Ingest answers `OPTIONS` on `/v1/*` and reflects the request `Origin`. A 403 after a successful preflight is the origin allowlist, not CORS.
- **Wasm does not load.** The bundler must leave `new URL(..., import.meta.url)` and the dynamic `import()` of the packaged wasm alone. Vite does. If the dev server pre-bundles `@readmeter/firebase`, exclude it from `optimizeDeps`.
