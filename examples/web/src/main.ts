import { flush, init, type Finding } from "@readmeter/firebase";
import { initializeApp } from "firebase/app";
import { connectDatabaseEmulator, getDatabase, type Database } from "@readmeter/firebase/database";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "@readmeter/firebase/firestore";
import { connectStorageEmulator, getStorage, type FirebaseStorage } from "@readmeter/firebase/storage";

import {
  downloadWholeList,
  duplicateListeners,
  listenOnRoot,
  unindexedQuery,
  valueListenerOnList,
  writeHotspot,
} from "./database.ts";
import {
  downloadUrlPerRender,
  listAllLargePrefix,
  originalSizeImage,
  redownloadWithoutCache,
  unboundedStorageList,
  uploadWithoutResumable,
} from "./storage.ts";
import {
  countViaFetch,
  getThenListen,
  listenerPerItem,
  loadMore,
  offsetPagination,
  saveDraft,
  blobWrite,
  counterTransaction,
  forceServerRead,
  noOpWrite,
  overfetch,
  searchOnce,
  searchPerKeystroke,
  seedData,
  tinyBatches,
  unboundedList,
  unusedPrefetch,
  writePerKeystroke,
} from "./scenarios.ts";

const logEl = document.querySelector("#log");
const actions = document.querySelector("#actions");
const databaseActions = document.querySelector("#database");
const storageActions = document.querySelector("#storage");
const search = document.querySelector("#search");
const draft = document.querySelector("#draft");

function log(line: string): void {
  if (!(logEl instanceof HTMLElement)) return;
  logEl.textContent = `${line}\n${logEl.textContent ?? ""}`;
}

function requireEl<T extends Element>(value: Element | null, name: string): T {
  if (!(value instanceof Element)) throw new Error(`missing #${name}`);
  return value as T;
}

const buttons: { label: string; rule: string; run: (db: Firestore) => Promise<string> }[] = [
  { label: "seed data", rule: "", run: seedData },
  { label: "unbounded list", rule: "firebase.firestore/unbounded-list", run: unboundedList },
  { label: "offset pagination", rule: "firebase.firestore/offset-pagination", run: offsetPagination },
  { label: "load more", rule: "firebase.firestore/missing-cursor", run: loadMore },
  { label: "count via fetch", rule: "firebase.firestore/count-via-fetch", run: countViaFetch },
  { label: "get then listen", rule: "firebase.firestore/get-then-listen", run: getThenListen },
  { label: "listener per item", rule: "firebase.firestore/listener-per-item", run: listenerPerItem },
  { label: "search per keystroke", rule: "firebase.firestore/query-per-keystroke", run: searchPerKeystroke },
  { label: "write per keystroke", rule: "firebase.firestore/write-per-keystroke", run: writePerKeystroke },
  { label: "tiny batches", rule: "firebase.firestore/tiny-batches", run: tinyBatches },
  { label: "overfetch", rule: "firebase.firestore/overfetch", run: overfetch },
  { label: "force server read", rule: "firebase.firestore/force-server-read", run: forceServerRead },
  { label: "no-op write", rule: "firebase.firestore/no-op-write", run: noOpWrite },
  { label: "counter transaction", rule: "firebase.firestore/read-modify-write-counter", run: counterTransaction },
  { label: "unused prefetch", rule: "generic/unused-result", run: unusedPrefetch },
  { label: "blob write", rule: "firebase.firestore/blob-in-document", run: blobWrite },
];

const databaseButtons: { label: string; rule: string; run: (db: Database) => Promise<string> }[] = [
  { label: "listen on root", rule: "firebase.database/listen-on-root", run: listenOnRoot },
  { label: "download whole list", rule: "firebase.database/download-whole-list", run: downloadWholeList },
  { label: "value listener on list", rule: "firebase.database/value-listener-on-list", run: valueListenerOnList },
  { label: "write hotspot", rule: "firebase.database/rtdb-write-hotspot", run: writeHotspot },
  { label: "duplicate listeners", rule: "firebase.database/duplicate-listeners", run: duplicateListeners },
  { label: "unindexed query", rule: "firebase.database/unindexed-query", run: unindexedQuery },
];

const storageButtons: { label: string; rule: string; run: (storage: FirebaseStorage) => Promise<string> }[] = [
  { label: "unbounded storage list", rule: "firebase.storage/unbounded-list-page", run: unboundedStorageList },
  { label: "list all prefix", rule: "firebase.storage/list-all-large-prefix", run: listAllLargePrefix },
  { label: "download url per render", rule: "firebase.storage/download-url-per-render", run: downloadUrlPerRender },
  { label: "redownload without cache", rule: "firebase.storage/redownload-without-cache-control", run: redownloadWithoutCache },
  { label: "original size image", rule: "firebase.storage/original-size-images", run: originalSizeImage },
  { label: "upload without resumable", rule: "firebase.storage/upload-without-resumable", run: uploadWithoutResumable },
];

let sdkError = "";
const report = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const text = args.map((part) => (typeof part === "string" ? part : String(part))).join(" ");
  if (text.includes("[readmeter]")) sdkError = text;
  report(...args);
};

const configText = import.meta.env.VITE_FIREBASE_CONFIG;
let firebaseConfig: { apiKey: string; projectId: string };
try {
  const parsed: unknown = JSON.parse(configText);
  if (!parsed || typeof parsed !== "object" || !("projectId" in parsed) || !("apiKey" in parsed)) {
    throw new Error("VITE_FIREBASE_CONFIG needs apiKey and projectId");
  }
  firebaseConfig = parsed as { apiKey: string; projectId: string };
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  throw error;
}

const hashKey = import.meta.env.VITE_READMETER_HASH_KEY;
init({
  apiKey: import.meta.env.VITE_READMETER_API_KEY,
  endpoint: import.meta.env.VITE_READMETER_ENDPOINT,
  dev: true,
  ...(hashKey ? { hashKey } : {}),
  onFinding(finding: Finding) {
    log(`${finding.rule}  ${finding.message}`);
  },
});

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const rtdb = getDatabase(app, "https://demo-readmeter.firebaseio.com");
const bucket = getStorage(app, "gs://demo-readmeter.appspot.com");
if (import.meta.env.VITE_USE_EMULATOR === "1") {
  connectFirestoreEmulator(db, "127.0.0.1", 8085);
  connectDatabaseEmulator(rtdb, "127.0.0.1", 9000);
  connectStorageEmulator(bucket, "127.0.0.1", 9199);
}

const buttonEls: HTMLButtonElement[] = [];

function setBusy(busy: boolean): void {
  for (const button of buttonEls) button.disabled = busy;
}

function addButton(bar: HTMLElement, label: string, rule: string, run: () => Promise<string>): void {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = rule ? `${label} — ${rule}` : label;
  button.disabled = true;
  button.addEventListener("click", () => {
    setBusy(true);
    void run()
      .then((line) => log(line))
      .catch((error: unknown) => log(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  });
  bar.append(button);
  buttonEls.push(button);
}

const firestoreBar = requireEl<HTMLElement>(actions, "actions");
for (const spec of buttons) addButton(firestoreBar, spec.label, spec.rule, () => spec.run(db));
const databaseBar = requireEl<HTMLElement>(databaseActions, "database");
for (const spec of databaseButtons) addButton(databaseBar, spec.label, spec.rule, () => spec.run(rtdb));
const storageBar = requireEl<HTMLElement>(storageActions, "storage");
for (const spec of storageButtons) addButton(storageBar, spec.label, spec.rule, () => spec.run(bucket));

const searchInput = requireEl<HTMLInputElement>(search, "search");
searchInput.addEventListener("input", () => {
  const term = searchInput.value;
  if (!term) return;
  void searchOnce(db, term).catch((error: unknown) => log(error instanceof Error ? error.message : String(error)));
});

const draftInput = requireEl<HTMLInputElement>(draft, "draft");
draftInput.addEventListener("input", () => {
  void saveDraft(db, draftInput.value).catch((error: unknown) => log(error instanceof Error ? error.message : String(error)));
});

await flush();
if (sdkError) log(sdkError);
else log("ready");
setBusy(false);
