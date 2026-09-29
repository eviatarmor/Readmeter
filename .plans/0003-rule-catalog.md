# 0003: Rule catalog

Status: in progress. Last updated 2026-09-29. Source of truth is
`rules/**/*.toml`; this file explains the choices and tracks the roadmap.

## Severity model (by cost impact)

| Severity | Meaning |
|---|---|
| critical | Cost grows without bound with data size or traffic |
| high | Large multiplier on cost (roughly 5x or more), or grows with usage (pages, retries) |
| medium | Measurable waste on a hot path |
| low | Minor waste, or latency/throughput impact only |
| info | Observation, no direct waste |

Evaluation tiers: `local` (one envelope, runs in every SDK), `window` (one
session, backend and SDK dev mode), `aggregate` (cross-session, backend only).

## Must-have rules (v1)

### Generic (every provider)

| Id | Severity | Eval | Status | Detects |
|---|---|---|---|---|
| `generic/listener-leak` | high | window | stable | Open subscriptions from one callsite keep growing |
| `generic/subscription-churn` | high | window | stable | Same subscription re-opened repeatedly; initial result re-billed |
| `generic/n-plus-one` | medium | window | stable | Burst of distinct single-item reads on one template |
| `generic/duplicate-read` | medium | window | stable | Exact same request billed repeatedly in a window |
| `generic/polling-instead-of-subscription` | medium | window | stable | Same request on a steady timer |
| `generic/react-double-mount` | medium | window | stable | Mount/unmount/mount: subscribe or read twice within ms from one callsite |
| `generic/retry-storm` | medium | window | stable | Error bursts on one request, or attempt counts past the cap |
| `generic/oversized-payload` | medium | local | stable | Response or average item far larger than needed |
| `generic/one-shot-subscription` | low | window | stable | Subscription closed right after its first snapshot |
| `generic/hot-callsite` | info | aggregate | planned | One callsite takes a large share of billed units |

### Firebase / Firestore

| Id | Severity | Eval | Status | Detects |
|---|---|---|---|---|
| `firebase.firestore/unbounded-list` | critical | local | stable | Query/listener without `limit()` returning many docs |
| `firebase.firestore/offset-pagination` | high | local | stable | `offset(n)` bills n skipped docs |
| `firebase.firestore/oversized-limit` | high | local | stable | `limit()` far larger than a page, on client platforms |
| `firebase.firestore/missing-cursor` | high | window | stable | "Load more" by growing `limit()` instead of `startAfter` |
| `firebase.firestore/count-via-fetch` | high | window | stable | Docs fetched only to read `.size`; use `count()` |
| `firebase.firestore/count-then-fetch` | low | window | stable | `count()` followed by fetching the same query |
| `firebase.firestore/polled-aggregation` | medium | window | stable | `count()`/`sum()` on a timer |
| `firebase.firestore/emptiness-check-without-limit` | medium | window | stable | Docs fetched only to read `.empty`; use `limit(1)` |
| `firebase.firestore/large-listener-result` | medium | local | stable | Large initial snapshot, re-billed on resubscribe/reconnect |
| `firebase.firestore/get-while-listening` | medium | window | stable | Server read of a query a live listener already covers |
| `firebase.firestore/get-then-listen` | medium | window | stable | One-time read followed by a listener on the same query |
| `firebase.firestore/listener-per-item` | high | window | stable | Many single-doc listeners on one template |
| `firebase.firestore/hot-listener` | high | window | stable | Listener receiving many changed docs per minute |
| `firebase.firestore/read-after-write` | low | window | stable | Doc read right after this client wrote it |
| `firebase.firestore/write-hotspot` | medium | window | stable | One doc written faster than ~1/s (single session) |
| `firebase.firestore/transaction-contention` | medium | local | stable | Transactions needing many attempts |
| `firebase.firestore/unused-projection` | medium | local | beta | Server query fetching large full docs without `select()` |
| `firebase.firestore/expensive-aggregation` | medium | local | stable | Aggregation scanning many index entries per call |
| `firebase.firestore/large-docs-in-list` | medium | local | stable | List whose average doc is large (web SDK cannot `select()`) |
| `firebase.firestore/monotonic-document-ids` | low | window | beta | Sequential/timestamp ids concentrating writes |
| `firebase.firestore/fanout-writes` | info | local | stable | One commit writing many docs |
| `firebase.firestore/query-per-keystroke` | medium | window | stable | Same query shape, new values, from one callsite within seconds |
| `firebase.firestore/write-per-keystroke` | medium | window | stable | Many writes to one doc from one callsite within seconds |
| `firebase.firestore/tiny-batches` | low | window | stable | Many 1-2 write batches that could be one |
| `firebase.firestore/client-side-bulk-delete` | low | window | stable | Burst of deletes on one collection from a client |
| `firebase.firestore/manual-ttl-cleanup` | medium | window | stable | Age-filter query followed by deleting the results |
| `firebase.firestore/initial-load-fanout` | medium | window | stable | Many distinct reads in the first seconds of a session |
| `firebase.firestore/multi-client-write-hotspot` | high | aggregate | planned | Same doc written by many sessions |
| `firebase.firestore/listener-reconnect-rebill` | medium | aggregate | planned | Reconnects after 30+ min offline re-reading listeners |
| `firebase.firestore/persistence-disabled` | low | local | planned | Client runs without persistent cache |

## Why these first

They cover the most common Firestore bill surprises seen in practice: reads
that scale with data (unbounded, offset, missing cursor, count), reads that
scale with UI behavior (double mount, churn, leaks, polling, duplicates), and
write-side contention that turns into retries. Each one can be detected from
envelope fields the shims can produce cheaply, and most can put a number on
the waste (`wasted` units).

## Expansion to ~50 rules (Firebase web focus)

40 rules exist (36 active) after batch A. Batches B and C below bring the catalog to 53. "Signal"
says what the rule needs beyond today's envelope; `-` means it can be built
now. New signals are listed in 0006 (section 6).

### Batch A: buildable now (17) — done

Task brief: [`tasks/A-rules-batch-a.md`](tasks/A-rules-batch-a.md) (exact params and logic).
All 17 are stable in the must-have table above.

Dropped from the first draft because existing rules already report them:
`empty-result-polling` (`generic/polling-instead-of-subscription`),
`missing-index-retry` and `permission-denied-loop` (`generic/retry-storm`;
follow-up: code-specific fix text in retry-storm),
`collection-group-unfiltered` (only costly without `limit()`, which is
`unbounded-list`). `generic/polling-instead-of-subscription` stops matching
aggregations (their fix is `polled-aggregation`).

### Batch B: need new SDK signals (11)

| Id | Severity | Eval | Signal | Detects |
|---|---|---|---|---|
| `firebase.firestore/overfetch` | high | window | per-doc `data()` access count | Many docs fetched, few used (client-side filtering or slicing) |
| `firebase.firestore/client-side-aggregation` | high | window | field access across all docs | Docs fetched only to sum/average a field; use `sum()`/`average()` |
| `firebase.firestore/force-server-read` | medium | window | read `source` | Repeated `getDocsFromServer` where cache would serve |
| `firebase.firestore/blob-in-document` | medium | local | largest field bytes | Base64 images/files in docs; move to Storage |
| `firebase.firestore/growing-document` | high | window | write transforms + doc bytes over time | `arrayUnion`/map growth making every read of the doc bigger |
| `firebase.firestore/no-op-write` | medium | window | keyed payload hash | Writes identical to the previous write of that doc |
| `firebase.firestore/read-modify-write-counter` | medium | window | transaction id | Transaction reading and writing one doc to count; use `increment()` |
| `firebase.firestore/multi-tab-without-shared-cache` | medium | local | init event | Persistent cache without `persistentMultipleTabManager`; listeners bill per tab |
| `firebase.firestore/read-in-render` | high | window | React render ids | Reads issued from render, repeating on every render |
| `generic/unused-result` | medium | window | usage events | Results fetched and never accessed (prefetch that is never used) |
| `generic/activity-while-hidden` | medium | window | page visibility | Listeners and polling kept running while the tab is hidden |

### Batch C: aggregate, backend only (2 new + 3 existing planned)

| Id | Severity | Detects |
|---|---|---|
| `firebase.firestore/broadcast-listener` | high | Many sessions listening to the same doc/query; each update bills a read per client |
| `firebase.firestore/public-data-not-bundled` | high | Same query with the same result read by many sessions; serve via Firestore bundles/CDN |

Plus `generic/hot-callsite`, `firebase.firestore/multi-client-write-hotspot`,
`firebase.firestore/listener-reconnect-rebill` (already defined).

Enabling `persistence-disabled` needs the init event from batch B.

### Verify before `stable`

- `expensive-aggregation` uses the 1-read-per-1000-index-entries rule for aggregations; confirm.

## Roadmap beyond Firestore

Other Firebase services (after Firestore SDKs ship):
- Realtime Database: `listen-on-root`, `download-whole-list`, `missing-query-limit`.
- Storage: `redownload-without-cache-control`, `original-size-images`.
- Functions: `function-retry-loop`, `firestore-trigger-cascade`, `cold-start-heavy-bundle`.

Supabase (phase 6): `select-star`, `missing-range`, `count-exact-on-large-table`,
`realtime-on-large-table`, `rpc-in-loop`. Many generic rules already apply.

Vercel (phase 6, connector-only): `uncached-dynamic-route`,
`function-bandwidth-heavy`, `edge-config-read-per-request`.
