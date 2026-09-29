# 0006: Firebase web (first shippable target)

Status: planned. Last updated 2026-09-29.

Goal: a web app on the Firebase modular SDK (`firebase/firestore`) installs
`@readmeter/firebase`, changes one import (or adds `sink` calls), and sees
findings with callsites and estimated waste in Postgres (and later the
console). Capture approach: wrapper on top of `sink` (see 0004).

## Work items

### 1. JS SDK package (`sdks/js/firebase`)

- [x] `init({ apiKey, env, sampleRate, endpoint })`: session id, sampling,
      loads the prod or dev wasm (dev adds window rules), lazy and async so
      app start is never blocked; calls made before wasm is ready are queued (bounded).
- [ ] Transport: batch timer, `fetch(..., { keepalive: true })`,
      `navigator.sendBeacon` on `pagehide`, backoff on 503/`Retry-After`,
      drop-oldest when offline for long.
- [x] Rule bundle: ship a default bundle in the package; fetch the project
      bundle from `GET /v1/bundle` (cached, signed later).
- [x] `sink`, `sinkWrite`, `sinkListener` (0004).
- [ ] Size budget for the JS glue (target < 10 KB gzip on top of wasm) with a CI check.

### 2. Firestore adapter

- [x] Query shape reader: `Query` internals behind a version guard;
      unknown versions send the call without a shape (rules that need it stay silent).
- [x] Refs to paths; `collectionGroup` detection.
- [x] Snapshot stats: doc count, estimated bytes (Firestore storage-size
      rules), `fromCache`, `docChanges().length` for non-initial snapshots.
- [ ] Usage proxies on snapshots: `size`, `empty`, `docs`, `forEach`, and
      per-doc `data()` / `exists()` access counts (for `overfetch`, `count-via-fetch`, ...).
- [ ] Reads: `getDoc(s)`, `getDoc(s)FromCache`, `getDoc(s)FromServer` (report `source`).
- [x] Aggregates: `getCountFromServer`, `getAggregateFromServer` (report the count value).
- [x] Listeners: `onSnapshot` for docs and queries; stable listener ids; unsubscribe events.
- [ ] Writes: `setDoc` (merge or not), `updateDoc`, `addDoc`, `deleteDoc`,
      `writeBatch`, `runTransaction` (transaction id on its reads and writes).
      Write stats: payload bytes, largest field bytes, field transforms
      (`increment`, `arrayUnion`, `serverTimestamp`, ...), keyed hash of the payload.
- [ ] Init event: cache kind (memory / persistent), tab manager (single / multi), cache size, long polling.

### 3. Drop-in wrapper (`@readmeter/firebase/firestore`)

- [x] Re-export all of `firebase/firestore`, replacing the functions above
      with versions that call the real one and then `sink`. Types identical.
- [ ] Supported range: firebase 10.x and 11.x/12.x (whatever is current), one conformance run per major.

### 4. Web signals

- [ ] Page visibility (`visibilitychange`), `pagehide`, SPA route changes
      (History API), as `page` events on the session.
- [ ] `@readmeter/react`: `ReadmeterProvider` + mount ids for hooks and
      components (for `react-double-mount`, `read-in-render`).

### 5. Callsites

- [ ] Build plugin (Vite first, then webpack / Next.js SWC) that injects a
      stable callsite id (`file:line:col` hashed at build time) into wrapped calls.
- [ ] Dev fallback: parse `new Error().stack` (dev builds only).

### 6. Core changes (Rust)

- [ ] Raw-call and `Envelope` fields for the new signals above
      (`source`, usage access counts, write stats, transaction id, init and page events).
      Bump `SCHEMA_VERSION` to 2. Nothing has shipped, so v1 decoding can
      be dropped instead of kept; say so in the change.
- [ ] Leak tests for every new field (payload hash is keyed; no values).
- [x] Batch A detectors (17), see 0003 and `tasks/A-rules-batch-a.md`
- [ ] Batch B detectors (need the signals above), then batch C aggregate rules on the backend
- [ ] Wasm size: prod build to 80 KiB gzip (0002, "Wasm size").

### 7. Backend pieces the web SDK needs

- [ ] CORS on ingest (browser POSTs), `OPTIONS` preflight, `keepalive`-sized bodies (64 KiB cap for beacons).
- [ ] Browser keys are public. Make ingest keys write-only, restricted to
      an origin allowlist per project, and rate limited per project and per IP.
- [ ] The hash key is visible in the browser too, so keyed hashing cannot
      stop brute force of low-entropy values there. Web SDKs therefore hash
      only ids and cursors; filter values that could be low-entropy (enums,
      booleans) are dropped instead of hashed. Document this in the privacy notes.
- [ ] `GET /v1/bundle` (project rule bundle with overrides).
- [ ] Minimal `console-api`: sign-in, create project, create key, list findings (UI stays design-only).

### 8. Testing

- [x] Conformance fixtures run from TypeScript (same files as the Rust runner).
- [x] Firestore emulator + Playwright: a small demo app that triggers each
      rule, asserting findings end up in Postgres.
- [x] Demo app doubles as the documentation example per rule.

## Order

1. Core signal changes (6) and the ~17 rules that need no new signals (0003).
2. SDK package + adapter + transport (1, 2), conformance from TS (8).
3. Backend pieces (7), emulator e2e (8).
4. Wrapper, React, callsite plugin (3, 4, 5).
5. Rules that need the new signals, then aggregate rules.
