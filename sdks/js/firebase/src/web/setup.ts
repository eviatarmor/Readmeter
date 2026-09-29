/**
 * One init raw call per Firestore instance, plus the cache setup captured
 * from the drop-in wrappers. The reported set is process-global: a new
 * Readmeter session does not send init again for the same instance.
 */

import { recordRaw } from "../core/client.ts";
import { nextCallId } from "../core/session.ts";

export interface ClientSetup {
  cache: "unknown" | "memory" | "persistent";
  shared_tabs: boolean;
}

const reported = new WeakSet<object>();
const setupByDb = new WeakMap<object, ClientSetup>();
const sharedByCache = new WeakMap<object, boolean>();

export function notePersistence(db: object, setup: ClientSetup): void {
  setupByDb.set(db, setup);
}

export function noteCacheShared(cache: object, shared: boolean): void {
  sharedByCache.set(cache, shared);
}

export function sharedTabs(cache: object): boolean {
  return sharedByCache.get(cache) === true;
}

function databasePath(db: object): string {
  const id = (db as { _databaseId?: { projectId?: unknown; database?: unknown } })._databaseId;
  if (!id || typeof id.projectId !== "string" || id.projectId.length === 0) return "";
  if (typeof id.database !== "string" || id.database.length === 0) return "";
  return `projects/${id.projectId}/databases/${id.database}`;
}

function cacheKind(cache: object): ClientSetup {
  const kind = (cache as { kind?: unknown }).kind;
  if (kind === "memory") return { cache: "memory", shared_tabs: false };
  if (kind === "persistent") return { cache: "persistent", shared_tabs: sharedByCache.get(cache) === true };
  return { cache: "unknown", shared_tabs: false };
}

function resolveSetup(db: object): ClientSetup {
  const noted = setupByDb.get(db);
  if (noted) return noted;
  try {
    const get = (db as { _getSettings?: () => unknown })._getSettings;
    if (typeof get !== "function") return { cache: "unknown", shared_tabs: false };
    const value = get.call(db);
    if (!value || typeof value !== "object") return { cache: "unknown", shared_tabs: false };
    const localCache = (value as { localCache?: unknown }).localCache;
    if (!localCache || typeof localCache !== "object") return { cache: "memory", shared_tabs: false };
    return cacheKind(localCache);
  } catch {
    return { cache: "unknown", shared_tabs: false };
  }
}

/** Records init the first time a call's target belongs to this instance. */
export function maybeRecordInit(target: unknown): void {
  try {
    if (!target || typeof target !== "object") return;
    const db = (target as { firestore?: unknown }).firestore;
    if (!db || typeof db !== "object") return;
    if (reported.has(db)) return;
    const setup = resolveSetup(db);
    recordRaw({
      service: "firestore",
      op: "init",
      ts_ms: Date.now(),
      path: databasePath(db),
      call_id: nextCallId(),
      setup,
    });
    reported.add(db);
  } catch {
    // A failed init can be retried on the next call.
  }
}
