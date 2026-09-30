/**
 * Drop-in for `firebase/firestore`. Wrappers call the real function and then
 * record. The promise the host awaits is the one Firestore returned.
 */

import { callsite, readSite } from "../core/callsite.ts";
import { sdkDebug } from "../core/client.ts";
import { debugOnce } from "../core/log.ts";
import { writeSignal } from "../core/payload.ts";
import {
  addDoc as realAddDoc,
  deleteDoc as realDeleteDoc,
  enableIndexedDbPersistence as realEnableIndexedDbPersistence,
  enableMultiTabIndexedDbPersistence as realEnableMultiTabIndexedDbPersistence,
  getAggregateFromServer as realGetAggregateFromServer,
  getCountFromServer as realGetCountFromServer,
  getDoc as realGetDoc,
  getDocFromCache as realGetDocFromCache,
  getDocFromServer as realGetDocFromServer,
  getDocs as realGetDocs,
  getDocsFromCache as realGetDocsFromCache,
  getDocsFromServer as realGetDocsFromServer,
  initializeFirestore as realInitializeFirestore,
  onSnapshot as realOnSnapshot,
  persistentLocalCache as realPersistentLocalCache,
  runTransaction as realRunTransaction,
  setDoc as realSetDoc,
  updateDoc as realUpdateDoc,
  writeBatch as realWriteBatch,
} from "firebase/firestore";
import { noteCacheShared, notePersistence, sharedTabs } from "./setup.ts";
import { aggregationsFromSpec } from "./shape.ts";
import {
  bindBatch,
  instrumentUpdate,
  openListener,
  recordAggregateResult,
  recordCreated,
  recordFailure,
  recordGetResult,
  recordQueryResult,
  recordWrite,
  watch,
  type ListenerSession,
  type Timing,
} from "./sink.ts";

export * from "firebase/firestore";

type AnyFn = (...args: unknown[]) => unknown;

function timing(): Timing {
  return { site: callsite(), ts: Date.now(), start: performance.now() };
}

/** Reads also record whether they ran in a React render; one stack serves both. */
function readTiming(): Timing {
  const { site, inRender } = readSite();
  return { site, inRender, ts: Date.now(), start: performance.now() };
}

function traced<T>(
  run: () => Promise<T>,
  ok: (value: T, at: Timing) => void,
  bad: (error: unknown, at: Timing) => void,
  start: () => Timing = timing,
): Promise<T> {
  const at = start();
  let pending: Promise<T>;
  try {
    pending = run();
  } catch (error) {
    try {
      bad(error, at);
    } catch (inner) {
      debugOnce(sdkDebug(), inner);
    }
    throw error;
  }
  return watch(pending, (value) => ok(value, at), (error) => bad(error, at));
}

function call(real: AnyFn, args: unknown[]): Promise<unknown> {
  return real(...args) as Promise<unknown>;
}

export const getDocs: typeof realGetDocs = ((...args: unknown[]) =>
  traced(
    () => call(realGetDocs as AnyFn, args),
    (snap, at) => recordQueryResult(args[0], snap, at, true),
    (error, at) => recordFailure("query", args[0], error, at),
    readTiming,
  )) as typeof realGetDocs;

export const getDocsFromServer: typeof realGetDocsFromServer = ((...args: unknown[]) =>
  traced(
    () => call(realGetDocsFromServer as AnyFn, args),
    (snap, at) => recordQueryResult(args[0], snap, at, true, "server"),
    (error, at) => recordFailure("query", args[0], error, at),
    readTiming,
  )) as typeof realGetDocsFromServer;

export const getDocsFromCache: typeof realGetDocsFromCache = ((...args: unknown[]) =>
  traced(
    () => call(realGetDocsFromCache as AnyFn, args),
    (snap, at) => recordQueryResult(args[0], snap, at, true, "cache"),
    (error, at) => recordFailure("query", args[0], error, at),
    readTiming,
  )) as typeof realGetDocsFromCache;

export const getDoc: typeof realGetDoc = ((...args: unknown[]) =>
  traced(
    () => call(realGetDoc as AnyFn, args),
    (snap, at) => recordGetResult(args[0], snap, at, undefined, true),
    (error, at) => recordFailure("get", args[0], error, at),
    readTiming,
  )) as typeof realGetDoc;

export const getDocFromServer: typeof realGetDocFromServer = ((...args: unknown[]) =>
  traced(
    () => call(realGetDocFromServer as AnyFn, args),
    (snap, at) => recordGetResult(args[0], snap, at, "server", true),
    (error, at) => recordFailure("get", args[0], error, at),
    readTiming,
  )) as typeof realGetDocFromServer;

export const getDocFromCache: typeof realGetDocFromCache = ((...args: unknown[]) =>
  traced(
    () => call(realGetDocFromCache as AnyFn, args),
    (snap, at) => recordGetResult(args[0], snap, at, "cache", true),
    (error, at) => recordFailure("get", args[0], error, at),
    readTiming,
  )) as typeof realGetDocFromCache;

export const getCountFromServer: typeof realGetCountFromServer = ((...args: unknown[]) =>
  traced(
    () => call(realGetCountFromServer as AnyFn, args),
    (snap, at) => recordAggregateResult(args[0], snap, ["count"], undefined, at),
    (error, at) => recordFailure("aggregate", args[0], error, at),
    readTiming,
  )) as typeof realGetCountFromServer;

export const getAggregateFromServer: typeof realGetAggregateFromServer = ((...args: unknown[]) => {
  const spec = args.length > 1 ? args[1] : (args[0] as { _aggregateSpec?: unknown } | undefined)?._aggregateSpec;
  const names = aggregationsFromSpec(spec);
  return traced(
    () => call(realGetAggregateFromServer as AnyFn, args),
    (snap, at) => recordAggregateResult(args[0], snap, names, spec, at),
    (error, at) => recordFailure("aggregate", args[0], error, at),
    readTiming,
  );
}) as typeof realGetAggregateFromServer;

export const setDoc: typeof realSetDoc = ((...args: unknown[]) =>
  traced(
    () => call(realSetDoc as AnyFn, args),
    (_value, at) => recordWrite("set", args[0], at, writeSignal("set", args[1], args[2])),
    (error, at) => recordFailure("set", args[0], error, at, writeSignal("set", args[1], args[2])),
  )) as typeof realSetDoc;

export const updateDoc: typeof realUpdateDoc = ((...args: unknown[]) =>
  traced(
    () => call(realUpdateDoc as AnyFn, args),
    (_value, at) => recordWrite("update", args[0], at, writeSignal("update", args.slice(1))),
    (error, at) => recordFailure("update", args[0], error, at, writeSignal("update", args.slice(1))),
  )) as typeof realUpdateDoc;

export const deleteDoc: typeof realDeleteDoc = ((...args: unknown[]) =>
  traced(
    () => call(realDeleteDoc as AnyFn, args),
    (_value, at) => recordWrite("delete", args[0], at),
    (error, at) => recordFailure("delete", args[0], error, at),
  )) as typeof realDeleteDoc;

export const addDoc: typeof realAddDoc = ((...args: unknown[]) =>
  traced(
    () => call(realAddDoc as AnyFn, args) as Promise<{ path?: string }>,
    (ref, at) => recordCreated(ref, at, writeSignal("create", args[1])),
    (error, at) => recordFailure("create", args[0], error, at, writeSignal("create", args[1])),
  )) as typeof realAddDoc;

export const initializeFirestore: typeof realInitializeFirestore = ((...args: unknown[]) => {
  const db = (realInitializeFirestore as AnyFn)(...args);
  try {
    if (db && typeof db === "object") {
      const settings = args[1];
      const localCache = settings && typeof settings === "object" ? (settings as { localCache?: unknown }).localCache : undefined;
      if (localCache && typeof localCache === "object") {
        const kind = (localCache as { kind?: unknown }).kind;
        if (kind === "memory") notePersistence(db, { cache: "memory", shared_tabs: false });
        else if (kind === "persistent") notePersistence(db, { cache: "persistent", shared_tabs: sharedTabs(localCache) });
        else notePersistence(db, { cache: "unknown", shared_tabs: false });
      }
    }
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
  return db;
}) as typeof realInitializeFirestore;

export const persistentLocalCache: typeof realPersistentLocalCache = ((...args: unknown[]) => {
  const cache = (realPersistentLocalCache as AnyFn)(...args);
  try {
    const settings = args[0] as { tabManager?: { kind?: unknown } } | undefined;
    const shared = !!settings && typeof settings === "object" && settings.tabManager?.kind === "PersistentMultipleTab";
    if (cache && typeof cache === "object") noteCacheShared(cache, shared);
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
  return cache;
}) as typeof realPersistentLocalCache;

function rememberPersistence(args: unknown[], shared: boolean): void {
  const db = args[0];
  if (db && typeof db === "object") notePersistence(db, { cache: "persistent", shared_tabs: shared });
}

export const enableIndexedDbPersistence: typeof realEnableIndexedDbPersistence = ((...args: unknown[]) => {
  const result = (realEnableIndexedDbPersistence as AnyFn)(...args);
  try {
    rememberPersistence(args, false);
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
  return result;
}) as typeof realEnableIndexedDbPersistence;

export const enableMultiTabIndexedDbPersistence: typeof realEnableMultiTabIndexedDbPersistence = ((...args: unknown[]) => {
  const result = (realEnableMultiTabIndexedDbPersistence as AnyFn)(...args);
  try {
    rememberPersistence(args, true);
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
  return result;
}) as typeof realEnableMultiTabIndexedDbPersistence;

export const writeBatch: typeof realWriteBatch = ((...args: unknown[]) => {
  const batch = (realWriteBatch as AnyFn)(...args);
  if (batch && typeof batch === "object") bindBatch(batch);
  return batch;
}) as typeof realWriteBatch;

export const runTransaction: typeof realRunTransaction = ((...args: unknown[]) => {
  const at = timing();
  const update = args[1];
  const run = typeof update === "function" ? instrumentUpdate(update as (tx: object) => unknown) : undefined;
  const next = args.slice();
  if (run) next[1] = (tx: object) => run.run(tx);
  let pending: Promise<unknown>;
  try {
    pending = call(realRunTransaction as AnyFn, next);
  } catch (error) {
    try {
      run?.settle(error, at);
    } catch (inner) {
      debugOnce(sdkDebug(), inner);
    }
    throw error;
  }
  return watch(
    pending,
    () => run?.settle(undefined, at),
    (error) => run?.settle(error, at),
  );
}) as typeof realRunTransaction;

function isListenOptions(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.next === "function" || typeof v.error === "function" || typeof v.complete === "function") return false;
  return "includeMetadataChanges" in v || "source" in v;
}

function eventTiming(): Timing {
  return { ts: Date.now(), start: performance.now() };
}

function wrapListener(args: unknown[], session: ListenerSession): unknown[] {
  const hasOptions = isListenOptions(args[1]);
  const base = hasOptions ? 2 : 1;
  const user = args[base];
  const next = args.slice(0, base);
  if (typeof user === "function") {
    next.push((snap: unknown) => {
      const at = eventTiming();
      try {
        session.note(snap, at);
      } catch (error) {
        debugOnce(sdkDebug(), error);
      }
      return user(snap);
    });
    const onError = args[base + 1];
    if (typeof onError === "function") {
      next.push((error: unknown) => {
        const at = eventTiming();
        try {
          session.fail(error, at);
        } catch (inner) {
          debugOnce(sdkDebug(), inner);
        }
        return onError(error);
      });
    }
    const onComplete = args[base + 2];
    if (typeof onComplete === "function") next.push(onComplete);
    return next;
  }
  if (user && typeof user === "object" && typeof (user as { next?: unknown }).next === "function") {
    const obs = user as { next: (snap: unknown) => unknown; error?: (error: unknown) => unknown; complete?: () => unknown };
    next.push({
      next(snap: unknown) {
        const at = eventTiming();
        try {
          session.note(snap, at);
        } catch (error) {
          debugOnce(sdkDebug(), error);
        }
        return obs.next(snap);
      },
      error: obs.error
        ? (error: unknown) => {
            const at = eventTiming();
            try {
              session.fail(error, at);
            } catch (inner) {
              debugOnce(sdkDebug(), inner);
            }
            return obs.error!(error);
          }
        : undefined,
      complete: obs.complete ? () => obs.complete!() : undefined,
    });
    return next;
  }
  return args;
}

export const onSnapshot: typeof realOnSnapshot = ((...args: unknown[]) => {
  const at = timing();
  let session: ListenerSession | undefined;
  try {
    session = openListener(args[0]);
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
  const invoke = realOnSnapshot as (...inner: unknown[]) => () => void;
  if (!session) return invoke(...args);
  let unsub: () => void;
  try {
    unsub = invoke(...wrapListener(args, session));
  } catch (error) {
    try {
      session.fail(error);
    } catch (inner) {
      debugOnce(sdkDebug(), inner);
    }
    throw error;
  }
  try {
    session.open(at);
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
  return () => {
    const closeAt = timing();
    try {
      unsub();
    } finally {
      try {
        session.close(closeAt);
      } catch (error) {
        debugOnce(sdkDebug(), error);
      }
    }
  };
}) as typeof realOnSnapshot;
