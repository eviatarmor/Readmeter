# @readmeter/firebase

Record Cloud Firestore and Realtime Database calls and send them to Readmeter. The package covers the web modular SDK and the Firebase Admin SDK used by Cloud Functions.

## Install

Install from the package tarball (`pnpm pack` in `sdks/js/firebase`):

```sh
pnpm add ./readmeter-firebase-0.1.0.tgz
```

Peer dependencies are optional. Install the ones you call: `firebase` (web, `>=10 <13`), `firebase-admin` (`>=12`) and `@google-cloud/firestore` (`>=7`) for Cloud Functions.

## init

```ts
import { init, flush } from "@readmeter/firebase";

init({
  apiKey: "rm_...",
  endpoint: "http://127.0.0.1:8090",
});

await flush();
```

`init` never throws. A bad config or a failed wasm load logs once and disables recording. Calls made before wasm is ready are queued. `flush()` sends the buffered batch.

## Web

Change `from "firebase/firestore"` to `from "@readmeter/firebase/firestore"`.

```ts
import { init } from "@readmeter/firebase";
import { getDocs, query, collection, where } from "@readmeter/firebase/firestore";

init({
  apiKey: "rm_...",
  endpoint: "http://127.0.0.1:8090",
});

const snap = await getDocs(query(collection(db, "orders"), where("status", "==", "open")));
```

Wrapped functions return the same values and rethrow the same Firestore errors.

Manual recording, when you cannot change the import:

```ts
import { sink, sinkWrite, sinkListener } from "@readmeter/firebase";

const snap = sink(q, await getDocs(q));
sinkWrite(ref, "update");
const unsub = onSnapshot(q, sinkListener(q, (next) => render(next)));
```

## Cloud Functions

```ts
import { init } from "@readmeter/firebase";
import { instrument, withFlush } from "@readmeter/firebase/admin";
import { getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";

init({
  apiKey: "rm_...",
  endpoint: "https://ingest.example",
  platform: "server",
});

const db = instrument(getFirestore());

export const fn = onRequest(withFlush(async (req, res) => {
  const snap = await db.collection("orders").where("status", "==", "open").get();
  res.json({ n: snap.size });
}));
```

`instrument` returns the same Firestore instance. `withFlush` awaits `flush()` after the handler settles, on success or error, and rethrows a handler error unchanged. On Node the SDK also flushes on `beforeExit` and `SIGTERM`.

## dev mode

`init({ dev: true, ... })` loads the dev build, which runs window rules in-process and logs each finding. Leave `dev` off in production. A bundler keeps the prod and dev modules in separate chunks and loads only the one `dev` selects.

## Privacy

What leaves the process is a template (`users/{id}/orders`), a count, a size, or a keyed hash. Document data, filter values, and ids are not sent.

## Try it on your app

[Testing with your app](../../../docs/TESTING-WITH-YOUR-APP.md) is the local loop: `./scripts/dev-up.sh`, a web import change, Cloud Functions `instrument` / `withFlush`. Findings land in Postgres. Open the console at `http://localhost:5174` (seeded login `admin@readmeter.local` / `readmeter-dev`).
