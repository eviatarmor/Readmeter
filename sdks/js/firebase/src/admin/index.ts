/**
 * Cloud Functions / Node: `instrument(firestore)` patches the RPC funnel.
 * Public methods are patched only to capture the callsite. They record nothing.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { Transform, type Readable } from "node:stream";

import { callsite } from "../core/callsite.ts";
import { recordRaw, sdkDebug } from "../core/client.ts";
import { debugOnce } from "../core/log.ts";
import { protoWriteSignal } from "../core/payload.ts";
import { nextCallId, nextListenerId, nextTransactionId } from "../core/session.ts";
import { documentByteSize } from "../core/size.ts";
import { flush } from "../index.ts";
import type { RawQueryShape } from "../web/shape.ts";
import { instrumentDatabase } from "./database.ts";
import { instrumentStorage } from "./storage.ts";
import {
  classifyCommit,
  countResult,
  readAggregation,
  readStructuredQuery,
  resourcePath,
  type ClassifiedCommit,
  type ProtoTarget,
} from "./proto.ts";

const PATCHED = Symbol.for("readmeter.admin.patched");
const INSTRUMENTED = Symbol.for("readmeter.admin.instrumented");

const GRPC: Record<number, string> = {
  1: "cancelled",
  2: "unknown",
  3: "invalid-argument",
  4: "deadline-exceeded",
  5: "not-found",
  6: "already-exists",
  7: "permission-denied",
  8: "resource-exhausted",
  9: "failed-precondition",
  10: "aborted",
  11: "out-of-range",
  12: "unimplemented",
  13: "internal",
  14: "unavailable",
  16: "unauthenticated",
  409: "aborted",
};

interface TxState {
  id: number;
  attempt: number;
  pending: Record<string, unknown>[];
  emitted: boolean;
}

interface Store {
  site?: string;
  tx?: TxState;
}

interface Timing {
  ts: number;
  start: number;
  site?: string;
  attempt?: number;
}

interface ListenTarget {
  listener: number;
  path: string;
  collectionGroup?: true;
  query?: RawQueryShape;
  changes: number;
  bytes: number;
  /** True until the CURRENT target change closes the first snapshot. */
  initial: boolean;
  unsubscribed: boolean;
}

type AnyFn = (...args: unknown[]) => unknown;

const als = new AsyncLocalStorage<Store>();
let shapeWarned = false;
let adminSdkVersion: string | undefined;
let prototypesPatched = false;

function isThenable(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "unknown";
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.length > 0) {
    const slash = code.lastIndexOf("/");
    return slash >= 0 ? code.slice(slash + 1) : code;
  }
  if (typeof code === "number" && GRPC[code]) return GRPC[code];
  return "unknown";
}

function adminVersion(): string {
  if (adminSdkVersion) return adminSdkVersion;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@google-cloud/firestore/package.json") as { version?: string };
    adminSdkVersion = typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    adminSdkVersion = "unknown";
  }
  return adminSdkVersion;
}

function warnShape(detail: string): void {
  if (shapeWarned) return;
  shapeWarned = true;
  console.debug(`[readmeter] Firestore query shape was not recognized (@google-cloud/firestore ${adminVersion()}). ${detail}`);
}

function timing(): Timing {
  const store = als.getStore();
  const site = store?.site ?? callsite();
  const at: Timing = { ts: Date.now(), start: performance.now() };
  if (site) at.site = site;
  if (store?.tx && store.tx.attempt > 1) at.attempt = store.tx.attempt;
  return at;
}

function elapsed(start: number): number {
  const us = Math.round((performance.now() - start) * 1000);
  return us < 0 ? 0 : us;
}

function txState(): TxState | undefined {
  return als.getStore()?.tx;
}

function isTxn(request: unknown): boolean {
  if (!request || typeof request !== "object") return false;
  const req = request as { transaction?: unknown; newTransaction?: unknown };
  return req.transaction != null || req.newTransaction != null;
}

function settleTx(tx: TxState | undefined): void {
  if (!tx || tx.emitted) return;
  tx.emitted = true;
  const calls = tx.pending.splice(0, tx.pending.length);
  for (const call of calls) recordRaw(call);
}

function publish(call: Record<string, unknown>, buffer: boolean): void {
  const tx = txState();
  if (buffer && tx) {
    tx.pending.push(call);
    return;
  }
  recordRaw(call);
}

function base(op: string, path: string, at: Timing, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const call: Record<string, unknown> = {
    service: "firestore",
    op,
    ts_ms: at.ts,
    path,
    call_id: nextCallId(),
    duration_us: elapsed(at.start),
  };
  if (at.site) call.callsite = at.site;
  if (at.attempt !== undefined && at.attempt > 1) call.attempt = at.attempt;
  const tx = txState();
  if (tx) call.transaction = tx.id;
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) call[key] = value;
  }
  return call;
}

function queryExtra(target: ProtoTarget | undefined): Record<string, unknown> {
  if (!target) return {};
  const extra: Record<string, unknown> = {};
  if (target.collectionGroup) extra.collection_group = true;
  if (target.query) extra.query = target.query;
  return extra;
}

function guard(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

function noteCommit(request: unknown, at: Timing, error: unknown): void {
  guard(() => {
    const method = typeof request === "object" ? request : undefined;
    const classified: ClassifiedCommit | undefined = classifyCommit(method);
    if (!classified) return;
    const extra: Record<string, unknown> = {};
    if (classified.commit) extra.commit = classified.commit;
    if (error) extra.error = errorCode(error);
    if (classified.op === "set" || classified.op === "update" || classified.op === "create") {
      const stats = protoWriteSignal(method);
      if (stats) extra.write = stats;
    }
    const buffer = isTxn(request);
    publish(base(classified.op, classified.path, at, extra), buffer);
    if (buffer && !error) settleTx(txState());
  });
}

function noteUnary(methodName: unknown, request: unknown, at: Timing, error: unknown): void {
  if (methodName !== "commit" && methodName !== "batchWrite") return;
  noteCommit(request, at, error);
}

interface DocTally {
  docs: number;
  bytes: number;
  index?: number;
}

function addDocument(tally: DocTally, document: unknown): void {
  if (!document || typeof document !== "object") return;
  const doc = document as { name?: unknown; fields?: unknown };
  const path = typeof doc.name === "string" ? resourcePath(doc.name) : "";
  tally.docs += 1;
  tally.bytes += documentByteSize(path, doc.fields ?? {});
}

function isReadable(value: unknown): value is Readable {
  if (!value || typeof value !== "object") return false;
  const stream = value as { pipe?: unknown; on?: unknown };
  return typeof stream.pipe === "function" && typeof stream.on === "function";
}

/**
 * Object-mode transform in the paused state `requestStream` promises.
 * `pipe` moves bytes; this function does not register a `data` listener.
 */
function tapStream(source: Readable, onChunk: (chunk: unknown) => void, onDone: (error?: unknown) => void): Readable {
  let settled = false;
  const done = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    guard(() => onDone(error));
  };
  const transform = new Transform({
    objectMode: true,
    transform(chunk: unknown, _encoding, callback) {
      guard(() => onChunk(chunk));
      callback(null, chunk);
    },
    flush(callback) {
      done();
      callback();
    },
  });
  let fromSource = false;
  source.on("end", () => {
    fromSource = true;
  });
  source.on("error", (error: unknown) => {
    done(error);
    transform.destroy(error instanceof Error ? error : new Error(errorCode(error)));
  });
  // Pause first so pipe cannot flush chunks before the caller resumes.
  transform.pause();
  source.pipe(transform);
  transform.on("finish", () => {
    // Query streams end from the source. Listen shutdown ends the tap, and that has to close the RPC.
    if (fromSource) return;
    const closable = source as Readable & { end?: () => void };
    try {
      closable.end?.();
    } catch {
      // The source may already be ended.
    }
  });
  transform.on("close", () => {
    done();
  });
  return transform;
}

function openQuery(request: unknown, at: Timing, op: "query" | "aggregate"): { onChunk: (chunk: unknown) => void; onDone: (error?: unknown) => void } | undefined {
  const aggregate = op === "aggregate" ? readAggregation(request) : undefined;
  const read = aggregate ?? readStructuredQuery(request);
  if (read.warn) warnShape(read.warn);
  const tally: DocTally = { docs: 0, bytes: 0 };
  let closed = false;
  const aggregations = aggregate?.aggregations;
  const countAlias = aggregate?.countAlias;
  return {
    onChunk(chunk) {
      if (op === "aggregate") {
        const index = countResult(chunk, countAlias);
        if (index !== undefined) tally.index = index;
        if (chunk && typeof chunk === "object" && (chunk as { result?: unknown }).result) tally.docs = 1;
        return;
      }
      if (chunk && typeof chunk === "object" && (chunk as { document?: unknown }).document) {
        addDocument(tally, (chunk as { document: unknown }).document);
      }
    },
    onDone(error) {
      if (closed) return;
      closed = true;
      const txn = isTxn(request);
      const extra = queryExtra(read.target);
      if (aggregations && aggregations.length > 0) {
        const query: RawQueryShape = { ...(extra.query ?? {}) };
        query.aggregations = aggregations;
        extra.query = query;
      }
      if (!error) {
        const result: Record<string, unknown> = { docs: tally.docs, bytes: tally.bytes };
        if (tally.index !== undefined) result.index_entries = tally.index;
        extra.result = result;
      } else {
        extra.error = errorCode(error);
      }
      publish(base(op, read.target?.path ?? "", at, extra), txn);
    },
  };
}

function openBatchGet(request: unknown, at: Timing): { onChunk: (chunk: unknown) => void; onDone: (error?: unknown) => void } {
  const names = request && typeof request === "object" && Array.isArray((request as { documents?: unknown }).documents)
    ? ((request as { documents: unknown[] }).documents.filter((name) => typeof name === "string") as string[])
    : [];
  const txn = isTxn(request);
  let seen = 0;
  let closed = false;
  const one = (path: string, docs: number, bytes: number, error?: unknown): void => {
    const extra: Record<string, unknown> = {};
    if (error) extra.error = errorCode(error);
    else extra.result = { docs, bytes };
    publish(base("get", path, at, extra), txn);
  };
  return {
    onChunk(chunk) {
      if (!chunk || typeof chunk !== "object") return;
      const row = chunk as { found?: unknown; missing?: unknown };
      if (row.found && typeof row.found === "object") {
        const doc = row.found as { name?: unknown; fields?: unknown };
        const requested = names[seen];
        const path = typeof doc.name === "string" ? resourcePath(doc.name) : requested ? resourcePath(requested) : "";
        one(path, 1, documentByteSize(path, doc.fields ?? {}));
        seen += 1;
        return;
      }
      if (typeof row.missing === "string") {
        const path = resourcePath(row.missing);
        one(path, 0, documentByteSize(path, {}));
        seen += 1;
      }
    },
    onDone(error) {
      if (closed) return;
      closed = true;
      if (!error) return;
      if (seen === 0) {
        const path = names[0] ? resourcePath(names[0]) : "";
        one(path, 0, 0, error);
        return;
      }
    },
  };
}

function listenTarget(add: Record<string, unknown>, at: Timing): ListenTarget[] {
  const out: ListenTarget[] = [];
  const documents = add.documents && typeof add.documents === "object" ? (add.documents as { documents?: unknown }).documents : undefined;
  if (Array.isArray(documents)) {
    for (const name of documents) {
      if (typeof name !== "string") continue;
      out.push({ listener: nextListenerId(), path: resourcePath(name), changes: 0, bytes: 0, initial: true, unsubscribed: false });
    }
    return out;
  }
  if (add.query) {
    const read = readStructuredQuery(add.query, true);
    if (read.warn) warnShape(read.warn);
    const target = read.target;
    out.push({
      listener: nextListenerId(),
      path: target?.path ?? "",
      ...(target?.collectionGroup ? { collectionGroup: true as const } : {}),
      ...(target?.query ? { query: target.query } : {}),
      changes: 0,
      bytes: 0,
      initial: true,
      unsubscribed: false,
    });
  }
  if (out.length === 0) return out;
  for (const target of out) {
    const extra: Record<string, unknown> = { listener: target.listener };
    if (target.collectionGroup) extra.collection_group = true;
    if (target.query) extra.query = target.query;
    publish(base("subscribe", target.path, at, extra), false);
  }
  return out;
}

function openListen(request: unknown, at: Timing): { onChunk: (chunk: unknown) => void; onDone: (error?: unknown) => void } | undefined {
  if (!request || typeof request !== "object") return undefined;
  const add = (request as { addTarget?: unknown }).addTarget;
  if (!add || typeof add !== "object") return undefined;
  const resume = (add as { resumeToken?: unknown }).resumeToken;
  const resumed = resume instanceof Uint8Array ? resume.byteLength > 0 : typeof resume === "string" && resume.length > 0;
  if (resumed) return { onChunk() {}, onDone() {} };
  const targets = listenTarget(add as Record<string, unknown>, at);
  if (targets.length === 0) return undefined;
  let closed = false;
  const unsubscribe = (): void => {
    if (closed) return;
    closed = true;
    const now = timing();
    for (const target of targets) {
      if (target.unsubscribed) continue;
      target.unsubscribed = true;
      const extra: Record<string, unknown> = { listener: target.listener };
      if (target.query) extra.query = target.query;
      if (target.collectionGroup) extra.collection_group = true;
      publish(base("unsubscribe", target.path, now, extra), false);
    }
  };
  return {
    onChunk(chunk) {
      if (!chunk || typeof chunk !== "object") return;
      const row = chunk as {
        targetChange?: { targetChangeType?: string; readTime?: unknown };
        documentChange?: { document?: unknown };
        documentDelete?: unknown;
        documentRemove?: unknown;
      };
      if (row.documentChange || row.documentDelete || row.documentRemove) {
        for (const target of targets) {
          target.changes += 1;
          if (row.documentChange?.document) {
            const doc = row.documentChange.document as { name?: unknown; fields?: unknown };
            const path = typeof doc.name === "string" ? resourcePath(doc.name) : target.path;
            target.bytes += documentByteSize(path, doc.fields ?? {});
          }
        }
        return;
      }
      const change = row.targetChange;
      if (!change) return;
      if (change.targetChangeType === "CURRENT") {
        for (const target of targets) recordSnapshot(target, at);
        return;
      }
      if (change.targetChangeType === "NO_CHANGE" && change.readTime) {
        for (const target of targets) {
          // Heartbeats carry a read time and no document changes.
          if (target.initial || (target.changes === 0 && target.bytes === 0)) continue;
          recordSnapshot(target, at);
        }
        return;
      }
      if (change.targetChangeType === "REMOVE") unsubscribe();
    },
    onDone() {
      unsubscribe();
    },
  };
}

function recordSnapshot(target: ListenTarget, at: Timing): void {
  const extra: Record<string, unknown> = {
    listener: target.listener,
    result: { docs: target.changes, bytes: target.bytes },
  };
  if (target.initial) extra.initial = true;
  if (target.collectionGroup) extra.collection_group = true;
  if (target.query) extra.query = target.query;
  publish(base("snapshot", target.path, { ...at, ts: Date.now() }, extra), false);
  target.changes = 0;
  target.bytes = 0;
  target.initial = false;
}

function openStream(methodName: unknown, request: unknown, at: Timing): { onChunk: (chunk: unknown) => void; onDone: (error?: unknown) => void } | undefined {
  if (methodName === "runQuery") return openQuery(request, at, "query");
  if (methodName === "runAggregationQuery") return openQuery(request, at, "aggregate");
  if (methodName === "batchGetDocuments") return openBatchGet(request, at);
  if (methodName === "listen") return openListen(request, at);
  return undefined;
}

function patchOwn(proto: object, name: string, wrap: (original: AnyFn) => AnyFn): void {
  const desc = Object.getOwnPropertyDescriptor(proto, name);
  if (!desc || typeof desc.value !== "function") return;
  const original = desc.value as AnyFn & { [PATCHED]?: boolean };
  if (original[PATCHED]) return;
  const wrapped = wrap(original) as AnyFn & { [PATCHED]?: boolean };
  wrapped[PATCHED] = true;
  Object.defineProperty(proto, name, { configurable: true, enumerable: desc.enumerable ?? false, writable: true, value: wrapped });
}

function patchChain(start: object | null, name: string, wrap: (original: AnyFn) => AnyFn): void {
  let cur = start;
  while (cur && cur !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(cur, name)) {
      patchOwn(cur, name, wrap);
      return;
    }
    cur = Object.getPrototypeOf(cur) as object | null;
  }
}

function callsiteWrap(original: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    const parent = als.getStore();
    const site = callsite() ?? parent?.site;
    return als.run({ site, tx: parent?.tx }, () => original.apply(this, args));
  };
}

function transactionWrap(original: AnyFn): AnyFn {
  return function (this: unknown, updateFunction: unknown, ...rest: unknown[]) {
    const parent = als.getStore();
    const tx: TxState = { id: nextTransactionId(), attempt: 0, pending: [], emitted: false };
    const site = callsite() ?? parent?.site;
    const wrapped =
      typeof updateFunction === "function"
        ? function (this: unknown, ...args: unknown[]) {
            tx.attempt += 1;
            tx.pending = [];
            tx.emitted = false;
            return (updateFunction as AnyFn).apply(this, args);
          }
        : updateFunction;
    let result: unknown;
    try {
      result = als.run({ site, tx }, () => original.apply(this, [wrapped, ...rest]));
    } catch (error) {
      settleTx(tx);
      throw error;
    }
    if (!isThenable(result)) {
      settleTx(tx);
      return result;
    }
    return result.then(
      (value) => {
        settleTx(tx);
        return value;
      },
      (error: unknown) => {
        settleTx(tx);
        throw error;
      },
    );
  };
}

function ensurePrototypes(db: object): void {
  if (prototypesPatched) return;
  const host = db as { collection?: (id: string) => { doc?: (id: string) => object; count?: () => object }; batch?: () => object };
  if (typeof host.collection !== "function" || typeof host.batch !== "function") return;
  const collection = host.collection("__rm");
  const doc = collection?.doc?.("__rm");
  patchChain(Object.getPrototypeOf(collection), "get", callsiteWrap);
  patchChain(Object.getPrototypeOf(collection), "stream", callsiteWrap);
  patchChain(Object.getPrototypeOf(collection), "onSnapshot", callsiteWrap);
  if (doc) {
    for (const name of ["get", "set", "update", "create", "delete", "onSnapshot"]) {
      patchChain(Object.getPrototypeOf(doc), name, callsiteWrap);
    }
  }
  const batch = host.batch();
  patchChain(Object.getPrototypeOf(batch), "commit", callsiteWrap);
  const count = collection?.count?.();
  if (count) patchChain(Object.getPrototypeOf(count), "get", callsiteWrap);
  patchChain(Object.getPrototypeOf(db), "getAll", callsiteWrap);
  patchChain(Object.getPrototypeOf(db), "runTransaction", transactionWrap);
  prototypesPatched = true;
}

function wrapRequest(original: AnyFn): AnyFn {
  return function (this: unknown, methodName: unknown, request: unknown, ...rest: unknown[]) {
    const at = timing();
    let result: unknown;
    try {
      result = original.apply(this, [methodName, request, ...rest]);
    } catch (error) {
      noteUnary(methodName, request, at, error);
      throw error;
    }
    if (!isThenable(result)) {
      noteUnary(methodName, request, at, undefined);
      return result;
    }
    void result.then(
      () => noteUnary(methodName, request, at, undefined),
      (error: unknown) => noteUnary(methodName, request, at, error),
    );
    return result;
  };
}

function wrapRequestStream(original: AnyFn): AnyFn {
  return function (this: unknown, methodName: unknown, bidirectional: unknown, request: unknown, ...rest: unknown[]) {
    const at = timing();
    const tap = (stream: unknown): unknown => {
      const opened = openStream(methodName, request, at);
      if (!opened) return stream;
      if (!isReadable(stream)) {
        opened.onDone();
        return stream;
      }
      return tapStream(stream, opened.onChunk, opened.onDone);
    };
    let result: unknown;
    try {
      result = original.apply(this, [methodName, bidirectional, request, ...rest]);
    } catch (error) {
      openStream(methodName, request, at)?.onDone(error);
      throw error;
    }
    if (!isThenable(result)) return tap(result);
    return result.then(tap, (error: unknown) => {
      openStream(methodName, request, at)?.onDone(error);
      throw error;
    });
  };
}

/**
 * Records RPCs on this Firestore instance and returns it.
 * Safe to call more than once. Never throws.
 */
export { instrumentDatabase, instrumentStorage };

export function instrument<T>(firestore: T): T {
  try {
    if (!firestore || typeof firestore !== "object") return firestore;
    const host = firestore as T & { request?: AnyFn; requestStream?: AnyFn; [INSTRUMENTED]?: boolean };
    if (host[INSTRUMENTED]) return firestore;
    ensurePrototypes(host);
    if (typeof host.request === "function") host.request = wrapRequest(host.request.bind(host));
    if (typeof host.requestStream === "function") host.requestStream = wrapRequestStream(host.requestStream.bind(host));
    host[INSTRUMENTED] = true;
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
  return firestore;
}

/**
 * Awaits `flush` after `handler` settles. A handler error is rethrown unchanged.
 */
export function withFlush<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => Promise<Awaited<R>> {
  return async (...args: A): Promise<Awaited<R>> => {
    try {
      return await handler(...args);
    } finally {
      await flush();
    }
  };
}

