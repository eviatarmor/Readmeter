# 0004: SDK surface (sink first, wrappers optional)

Status: accepted. Last updated 2026-09-29.

## Question

Should customers use drop-in wrappers of the provider SDK
(`import { getDocs } from "@readmeter/firebase/firestore"`), or an explicit
SDK call next to their own code (`const snap = await getDocs(q); rm.sink(q, snap)`)?

## Decision

Both, in layers. The **sink** is the public contract in every language.
**Wrappers** are thin sugar built on the sink, added per language where
automatic coverage is worth the maintenance.

```
provider SDK call (customer code)
  └─ wrapper (optional)            getDocs(q) = real getDocs(q) then sink(q, snap)
       └─ sink(target, result)     provider adapter: reads shape + sizes, builds raw call
            └─ Rust core record()  normalize, redact, local rules, buffer
                 └─ transport      language SDK: batch timer, POST, retry, backoff
```

| | Sink | Wrapper |
|---|---|---|
| Setup | One call per callsite | One import change |
| Coverage | Only what the user instruments | Every call through the wrapped surface |
| Provider SDK versions | Any; reads only public result objects | Tracks the provider's API surface per version |
| Window rules (`missing-cursor`, `n-plus-one`, `react-double-mount`) | Work only with full coverage of the pattern | Work out of the box |
| Maintenance | Small | Per language, per provider SDK major |

The sink alone would make window rules unreliable, because users forget
callsites. Wrappers alone would tie every language to every provider SDK
release. With both, the sink is the part that must not break, and each
wrapper is optional.

## Alternative considered: capture at the network layer

Patch `fetch`/XHR/WebSocket (or use a service worker) and read every request
and response, with no per-provider API code.

Where it works well: providers whose transport is a documented, stateless
protocol. Supabase (PostgREST over `fetch`, with `global: { fetch }` as an
official hook) and server SDKs over gRPC (interceptors, D10) fit this. For
those, "network capture" is the plan already.

Where it fails for Firestore:

- **Web:** the SDK talks WebChannel, an undocumented streaming framing over
  XHR/fetch. One Listen stream multiplexes every active query by internal
  target id; a write stream batches mutations. Decoding it means
  reimplementing Firestore's internal protocol and following its changes.
- **Mobile, C++, Unity, Admin SDKs:** gRPC over HTTP/2 inside native code,
  not `fetch`. A browser-style patch sees nothing there.
- **Callsites are lost.** By the time bytes hit the network, the SDK's async
  queue has run; the stack points into SDK internals. "Which line of your
  code costs money" is the product.
- **Intent is lost.** Mount ids (`react-double-mount`), whether the app
  used `snap.size` or `snap.docs` (`count-via-fetch`), and listener
  lifetimes are app-level facts that no wire trace carries.

What the network layer does better is exact bytes and exact billed reads. The
wrapper reports those too where the SDK exposes them, and the GCP Monitoring
connector gives exact project totals to check against.

So capture happens at the highest layer that still has the callsite, and at
the transport layer only when the transport is a public protocol.

## Shape of the API (TypeScript, the reference)

```ts
import { readmeter } from "@readmeter/firebase";

const rm = readmeter.init({ apiKey: "rm_...", hashKey: "...", env: "prod" });

// Sink: returns its input, so it can wrap inline.
const snap = rm.sink(q, await getDocs(q));
rm.sink(docRef, await getDoc(docRef));
rm.sinkWrite(docRef, "set");                      // writes have no result to read
const unsub = onSnapshot(q, rm.sinkListener(q, (s) => render(s)));

// Wrapper: same thing, automatic.
import { getDocs, onSnapshot } from "@readmeter/firebase/firestore";
```

Other languages follow the same names (`sink`, `sink_write`,
`sink_listener`) in their own casing. The language SDK owns everything the
core does not: timers, HTTP transport, retries, process exit hooks, the
clock, and reading provider objects.

## What the sink reads, and what it never sends

- Reads: path or collection, query constraints (filters by field and
  operator, order, limit, offset, cursors), result count, approximate byte
  size, `fromCache`, and later which parts of the result were used.
- Filter values, cursors and document ids go into the core only to be hashed
  with the project key; they never leave the process in clear text.
- Document data is never passed to the core. Byte sizes are estimated in the
  language SDK, sampled when expensive.

## Known hard parts

- **Reading query shape.** The Firestore web SDK has no public API that
  returns a query's constraints. Options: read `query._query` behind a
  version check (fragile, but no user changes), or have the wrapper capture
  constraints from `query()`/`where()`/`limit()` calls (exact, but it has to
  wrap more of the API). Start with the internal read plus a conformance test
  per supported SDK version. If the shape cannot be read, send the call
  without a query shape: rules that need it stay silent, with no false
  findings.
- **Byte sizes.** Real Firestore byte counts need the encoded document.
  Estimate from field sizes (Firestore's documented storage sizes), sampled.
- **Callsites.** Stack capture is too slow for production. Use a build-time
  transform (Babel/SWC plugin) that injects a callsite id, and stacks in dev.

## Per language, first cut

| Language | Sink | Wrapper | Core via |
|---|---|---|---|
| TS web (modular SDK) | yes | yes (`@readmeter/firebase/firestore`) | wasm |
| Node Admin | yes | gRPC interceptor (see D10) | wasm |
| Python Admin | yes | later | C ABI (cffi) or PyO3 |
| Go | yes | gRPC interceptor | wasm via wazero |
| C++ / Unity | yes | later | C ABI |
| Swift / Kotlin / Dart | yes | later | C ABI |

## Tasks

- [ ] `sdks/js/firebase`: `init`, `sink`, `sinkWrite`, `sinkListener`, transport, against `conformance/fixtures`
- [ ] Query-shape reader for the web SDK, with a version guard and a test per supported SDK major
- [ ] Drop-in `@readmeter/firebase/firestore` built on the sink
- [ ] Byte-size estimator per Firestore's storage size rules
- [ ] Python sink over the C ABI, to prove the non-JS path
