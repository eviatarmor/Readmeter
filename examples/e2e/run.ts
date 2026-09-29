/**
 * Drives the web scenarios against the Firestore emulator, calls each HTTP
 * function once, then asserts rules via a direct Postgres read.
 *
 * `tsx run.ts --assert-only <rule...>` only checks Postgres (used after Playwright).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "@readmeter/firebase/auth";
import { connectFunctionsEmulator, getFunctions } from "@readmeter/firebase/functions";
import { connectDatabaseEmulator, getDatabase } from "@readmeter/firebase/database";
import { connectStorageEmulator, getStorage } from "@readmeter/firebase/storage";
import {
  anonymousUserChurn,
  authListenerLeak,
  idTokenRefreshStorm,
  memoryPersistence,
} from "../web/src/auth.ts";
import { callableInLoop, callableRetryStorm, largeCallablePayload } from "../web/src/functions.ts";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { findingRules } from "@readmeter/db";
import { flush, init, shutdown } from "@readmeter/firebase";

import {
  blobWrite,
  counterTransaction,
  countViaFetch,
  forceServerRead,
  getThenListen,
  listenerPerItem,
  loadMore,
  noOpWrite,
  offsetPagination,
  overfetch,
  searchPerKeystroke,
  seedData,
  tinyBatches,
  unboundedList,
  unusedPrefetch,
  writePerKeystroke,
} from "../web/src/scenarios.ts";
import {
  downloadWholeList,
  duplicateListeners,
  listenOnRoot,
  unindexedQuery,
  valueListenerOnList,
  writeHotspot,
} from "../web/src/database.ts";
import {
  downloadUrlPerRender,
  listAllLargePrefix,
  originalSizeImage,
  redownloadWithoutCache,
  unboundedStorageList,
  uploadWithoutResumable,
} from "../web/src/storage.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://readmeter:readmeter@127.0.0.1:5442/readmeter";

/**
 * Web rules the Node run produces, plus the function rules.
 * `persistence-disabled` fires on the browser init (memory cache).
 * `unused-result` fires on queries whose snapshots are never read
 * (load-more, search, and the unused-prefetch button).
 * `read-modify-write-counter` must also be stored with source `evaluator`
 * (the Cloud Function's events are judged on ingest).
 */
const EXPECTED = [
  "firebase.firestore/unbounded-list",
  "firebase.firestore/offset-pagination",
  "firebase.firestore/missing-cursor",
  "firebase.firestore/count-via-fetch",
  "firebase.firestore/get-then-listen",
  "firebase.firestore/listener-per-item",
  "firebase.firestore/query-per-keystroke",
  "firebase.firestore/write-per-keystroke",
  "firebase.firestore/tiny-batches",
  "firebase.firestore/overfetch",
  "firebase.firestore/force-server-read",
  "firebase.firestore/no-op-write",
  "firebase.firestore/read-modify-write-counter",
  "firebase.firestore/blob-in-document",
  "firebase.firestore/persistence-disabled",
  "generic/unused-result",
  "generic/n-plus-one",
  "firebase.firestore/fanout-writes",
  "firebase.database/listen-on-root",
  "firebase.database/download-whole-list",
  "firebase.database/value-listener-on-list",
  "firebase.database/rtdb-write-hotspot",
  "firebase.database/duplicate-listeners",
  "firebase.storage/unbounded-list-page",
  "firebase.storage/list-all-large-prefix",
  "firebase.storage/download-url-per-render",
  "firebase.storage/redownload-without-cache-control",
  "firebase.storage/original-size-images",
  "firebase.storage/upload-without-resumable",
  "firebase.auth/anonymous-user-churn",
  "firebase.auth/id-token-refresh-storm",
  "firebase.auth/memory-persistence",
  "generic/listener-leak",
  "firebase.auth/server-list-users-in-request",
  "firebase.functions/callable-in-loop",
  "firebase.functions/large-callable-payload",
  "generic/retry-storm",
  "firebase.functions/cold-start-heavy",
  "firebase.functions/reads-per-invocation",
];

const COUNTER_RULE = "firebase.firestore/read-modify-write-counter";

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

interface FindingRow {
  rule: string;
  occurrences: number;
  template: string;
  source: string;
}

async function findings(): Promise<FindingRow[]> {
  return findingRules("demo_local", DATABASE_URL);
}

function report(expected: string[], rows: FindingRow[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.rule, (counts.get(row.rule) ?? 0) + row.occurrences);
  const missing = expected.filter((rule) => !counts.has(rule));
  const found = [...counts.keys()].sort();
  console.log("e2e rule check");
  console.log("expected:");
  for (const rule of expected) console.log(`  ${rule}`);
  console.log("found:");
  for (const rule of found) console.log(`  ${rule}  occurrences=${counts.get(rule)}`);
  if (missing.length === 0) console.log("missing: (none)");
  else {
    console.log("missing:");
    for (const rule of missing) console.log(`  ${rule}`);
  }
  return missing;
}

async function assertRules(expected: string[]): Promise<void> {
  let missing: string[] = expected;
  let rows: FindingRow[] = [];
  for (let i = 0; i < 20; i += 1) {
    rows = await findings();
    missing = report(expected, rows);
    if (missing.length === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`missing rules: ${missing.join(", ")}`);
}

function assertCounterFromEvaluator(rows: FindingRow[]): void {
  const matched = rows.filter((row) => row.rule === COUNTER_RULE);
  const sources = matched.map((row) => `${row.source} session-template=${row.template}`);
  console.log(`${COUNTER_RULE} rows: ${sources.join("; ") || "(none)"}`);
  if (!matched.some((row) => row.source === "evaluator")) {
    throw new Error(`${COUNTER_RULE} has no finding with source evaluator`);
  }
}

async function callFunction(name: string): Promise<void> {
  const url = `http://127.0.0.1:5001/demo-readmeter/us-central1/${name}`;
  let last = "";
  for (let i = 0; i < 20; i += 1) {
    try {
      const res = await fetch(url);
      last = `${res.status} ${await res.text()}`;
      if (res.ok) {
        console.log(name, last);
        return;
      }
      if (res.status !== 404 && res.status < 500) break;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`${name} failed: ${last} (${url})`);
}

async function drive(): Promise<void> {
  const env = loadEnv(resolve(root, ".readmeter/local.env"));
  const apiKey = env.READMETER_API_KEY;
  const hashKey = env.READMETER_HASH_KEY;
  const endpoint = env.READMETER_ENDPOINT ?? "http://127.0.0.1:8090";
  if (!apiKey || !hashKey) throw new Error(".readmeter/local.env is missing READMETER_API_KEY or READMETER_HASH_KEY");

  init({ apiKey, hashKey, endpoint, dev: true, platform: "browser" });

  const rawHost = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8085";
  const [host, portText] = rawHost.split(":");
  const port = Number(portText);
  if (!host || !Number.isFinite(port)) throw new Error(`bad FIRESTORE_EMULATOR_HOST ${rawHost}`);

  const app = initializeApp({ apiKey: "demo", projectId: "demo-readmeter" }, "readmeter-e2e");
  const db = getFirestore(app);
  connectFirestoreEmulator(db, host, port);
  const rawDatabase = process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? "127.0.0.1:9000";
  const [databaseHost, databasePortText] = rawDatabase.split(":");
  const databasePort = Number(databasePortText);
  if (!databaseHost || databasePort !== 9000) throw new Error(`bad FIREBASE_DATABASE_EMULATOR_HOST ${rawDatabase}`);
  const rtdb = getDatabase(app, "https://demo-readmeter.firebaseio.com");
  connectDatabaseEmulator(rtdb, databaseHost, databasePort);
  const rawStorage = (process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? "127.0.0.1:9199").replace(/^https?:\/\//, "");
  const [storageHost, storagePortText] = rawStorage.split(":");
  const storagePort = Number(storagePortText);
  if (!storageHost || storagePort !== 9199) throw new Error(`bad FIREBASE_STORAGE_EMULATOR_HOST ${rawStorage}`);
  const bucket = getStorage(app, "gs://demo-readmeter.appspot.com");
  connectStorageEmulator(bucket, storageHost, storagePort);
  const rawAuth = (process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099").replace(/^https?:\/\//, "");
  const [authHost, authPortText] = rawAuth.split(":");
  const authPort = Number(authPortText);
  if (!authHost || authPort !== 9099) throw new Error(`bad FIREBASE_AUTH_EMULATOR_HOST ${rawAuth}`);
  const userAuth = getAuth(app);
  connectAuthEmulator(userAuth, `http://${authHost}:${authPort}`, { disableWarnings: true });
  const fns = getFunctions(app, "us-central1");
  connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  // coldStart has to be the first withFlush in the functions process.
  await callFunction("coldStart");
  try {
    console.log(await seedData(db));
    console.log(await unboundedList(db));
    console.log(await offsetPagination(db));
    console.log(await loadMore(db));
    console.log(await countViaFetch(db));
    console.log(await getThenListen(db));
    console.log(await listenerPerItem(db));
    console.log(await searchPerKeystroke(db));
    console.log(await writePerKeystroke(db));
    console.log(await tinyBatches(db));
    console.log(await overfetch(db));
    console.log(await forceServerRead(db));
    console.log(await noOpWrite(db));
    console.log(await counterTransaction(db));
    console.log(await unusedPrefetch(db));
    console.log(await blobWrite(db));
    console.log(await listenOnRoot(rtdb));
    console.log(await downloadWholeList(rtdb));
    console.log(await valueListenerOnList(rtdb));
    console.log(await writeHotspot(rtdb));
    console.log(await duplicateListeners(rtdb));
    console.log(await unindexedQuery(rtdb));
    console.log(await unboundedStorageList(bucket));
    console.log(await downloadUrlPerRender(bucket));
    console.log(await redownloadWithoutCache(bucket));
    console.log(await originalSizeImage(bucket));
    console.log(await uploadWithoutResumable(bucket));
    console.log(await listAllLargePrefix(bucket));
    console.log(await memoryPersistence(userAuth));
    console.log(await anonymousUserChurn(userAuth));
    console.log(await idTokenRefreshStorm(userAuth));
    console.log(await authListenerLeak(userAuth));
    console.log(await callableInLoop(fns));
    console.log(await largeCallablePayload(fns));
    console.log(await callableRetryStorm(fns));
    await flush();
  } finally {
    await shutdown();
    await deleteApp(app);
  }

  for (const name of ["readStorm", "unboundedReport", "nPlusOne", "offsetPage", "fanout", "counterTx", "listUsersRequest"]) {
    await callFunction(name);
  }
}

const args = process.argv.slice(2);
const only = args[0] === "--assert-only";
const expected = only ? args.slice(1) : EXPECTED;
if (expected.length === 0) throw new Error("--assert-only needs at least one rule id");

if (!only) await drive();
await assertRules(expected);
if (!only) {
  assertCounterFromEvaluator(await findings());
}
console.log("e2e rules ok");
// Auth listeners and the ID-token refresh timer stay scheduled after
// deleteApp, so the process would never exit and emulators:exec would wait.
process.exit(0);
