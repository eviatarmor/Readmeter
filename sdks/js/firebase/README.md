# @readmeter/firebase

Record Cloud Firestore, Realtime Database, Cloud Storage, Authentication, and Cloud Functions calls and send them to Readmeter. The package covers the web modular SDK and the Firebase Admin SDK used by Cloud Functions.

## Install

Install the released package from npm:

```sh
pnpm add @readmeter/firebase
```

Before the first npm release, build with `pnpm sdk:build` in the repository root, then run `pnpm pack` in `sdks/js/firebase` and install the generated tarball. Point the SDK at your self-hosted ingest service.

Peer dependencies are optional. Install the ones you call: `firebase` (web, `>=10 <13`), `firebase-admin` (`>=12`), `@google-cloud/firestore` (`>=7`), and `@google-cloud/storage` (`>=8`) for Cloud Functions.

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

Change `from "firebase/firestore"` to `from "@readmeter/firebase/firestore"`. Change `from "firebase/storage"` to `from "@readmeter/firebase/storage"`, `from "firebase/auth"` to `from "@readmeter/firebase/auth"`, and `from "firebase/functions"` to `from "@readmeter/firebase/functions"` the same way.

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

In the browser, page visibility, connection changes and client-side route changes (`history.pushState`/`replaceState`, `popstate`, `hashchange`) are recorded as page events. A route is sent only as a template (`/users/{id}/orders`); pass `routes: false` to `init` to turn navigations off.

React apps can tag calls with the component that made them with [`@readmeter/react`](../react). Other UI bindings can use `newMountId`, `runInMount` and `currentMount` from the root module.

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
// Cloud Storage: instrumentStorage(getStorage().bucket()) from the same module.
// Authentication: instrumentAuth(getAuth()) from the same module.

export const fn = onRequest(withFlush(async (req, res) => {
  const snap = await db.collection("orders").where("status", "==", "open").get();
  res.json({ n: snap.size });
}));
```

`instrument` returns the same Firestore instance. `withFlush` awaits `flush()` after the handler settles, on success or error, and rethrows a handler error unchanged. It also records the invocation: duration, whether this was the first call in the process, `FUNCTION_MEMORY_MB` when that variable is set, and the Firestore reads, Realtime Database download bytes, and Storage calls observed while the handler ran. On Node the SDK also flushes on `beforeExit` and `SIGTERM`.

Web callables:

```ts
import { getFunctions, httpsCallable } from "@readmeter/firebase/functions";

const echo = httpsCallable(getFunctions(app, "us-central1"), "echo");
const result = await echo({ n: 1 });
```

`httpsCallable` and `httpsCallableFromURL` return the same callable type, including `.stream`. The function name is the last path segment of a URL when that segment is a safe name. A host with no path is recorded as `functions/unknown`.

## dev mode

`init({ dev: true, ... })` loads the dev build, which runs window rules in-process and logs each finding. Leave `dev` off in production. A bundler keeps the prod and dev modules in separate chunks and loads only the one `dev` selects.

## Privacy

What leaves the process is a template (`users/{id}/orders`), a count, a size, or a keyed hash. Document data, filter values, and ids are not sent. Cloud Storage also sends an extension, a content-type major, a cache-control class, list counts, page-token presence, and a resumable flag. Object bytes, URLs, and tokens are not sent. Authentication sends a method template, a safe provider id, a persistence kind, and page-token presence. Emails, phone numbers, uids, tokens, claims, and verification codes are not sent. Cloud Functions sends the function-name template, an operation name (`callable` or `invoke`), request and response byte counts, duration, an allowlisted error code, a cold flag, the memory setting, and Firestore read, Realtime Database download-byte, and Storage call counts observed during a `withFlush` invocation. Payloads, URLs, project ids, tokens, and auth headers are not sent.

## Try it on your app

[Use it with your app](../../../docs/content/docs/getting-started/your-app.mdx) is the local loop: `./scripts/dev-up.sh`, a web import change, Cloud Functions `instrument` / `withFlush`. Findings land in Postgres. Open the console at `http://localhost:5174` (seeded login `admin@readmeter.local` / `readmeter-dev`).
