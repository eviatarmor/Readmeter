/**
 * Drop-in for `firebase/database`. Wrappers call the real function and then
 * record. The promise the host awaits is the one Realtime Database returned.
 *
 * Query limits and bounds are read from `QueryImpl._queryParams` when a read
 * or listener runs (`database-shape.ts`). Constraint builders themselves are
 * pure and are re-exported unchanged. `keepSynced` is not on this web SDK.
 *
 * The first ordered read or listener wraps `console.warn` to catch the SDK's
 * "Using an unspecified index" warning (`database-index.ts`).
 */

import { callsite } from "../core/callsite.ts";
import { recordRaw, sdkDebug } from "../core/client.ts";
import { debugOnce } from "../core/log.ts";
import { nextCallId, nextListenerId } from "../core/session.ts";
import {
  get as realGet,
  goOffline as realGoOffline,
  goOnline as realGoOnline,
  onChildAdded as realOnChildAdded,
  onChildChanged as realOnChildChanged,
  onChildMoved as realOnChildMoved,
  onChildRemoved as realOnChildRemoved,
  onValue as realOnValue,
  push as realPush,
  remove as realRemove,
  runTransaction as realRunTransaction,
  set as realSet,
  update as realUpdate,
} from "firebase/database";
import { installIndexWarning, rememberQuery } from "./database-index.ts";
import { childCount, jsonBytes, readPath, readQueryShape, snapshotValue } from "./database-shape.ts";

export * from "firebase/database";

type AnyFn = (...args: unknown[]) => unknown;

interface Timing {
  site?: string;
  ts: number;
  start: number;
}

function timing(): Timing {
  const site = callsite();
  const at: Timing = { ts: Date.now(), start: performance.now() };
  if (site) at.site = site;
  return at;
}

function elapsed(start: number): number {
  const us = Math.round((performance.now() - start) * 1000);
  return us < 0 ? 0 : us;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "unknown";
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.length > 0) {
    const slash = code.lastIndexOf("/");
    return slash >= 0 ? code.slice(slash + 1) : code;
  }
  return "unknown";
}

function emit(op: string, target: unknown, at: Timing, extra: Record<string, unknown> = {}): void {
  try {
    const call: Record<string, unknown> = {
      service: "database",
      op,
      ts_ms: at.ts,
      path: readPath(target),
      call_id: nextCallId(),
      duration_us: elapsed(at.start),
    };
    if (at.site) call.callsite = at.site;
    const query = readQueryShape(target);
    if (query) call.query = query;
    if (query?.order_by && (op === "subscribe" || op === "get" || op === "query")) {
      // The SDK reports a missing .indexOn later, on console.warn only.
      installIndexWarning();
      rememberQuery(call.path as string, query.order_by, at.site);
    }
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) call[key] = value;
    }
    recordRaw(call);
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

function resultOf(snapshot: unknown): { children: number; bytes: number } {
  return { children: childCount(snapshot), bytes: jsonBytes(snapshotValue(snapshot)) };
}

function readOp(target: unknown): "get" | "query" {
  return readQueryShape(target) ? "query" : "get";
}

function watch<T>(pending: Promise<T>, ok: (value: T) => void, bad: (error: unknown) => void): Promise<T> {
  return pending.then(
    (value) => {
      try {
        ok(value);
      } catch (error) {
        debugOnce(sdkDebug(), error);
      }
      return value;
    },
    (error: unknown) => {
      try {
        bad(error);
      } catch (inner) {
        debugOnce(sdkDebug(), inner);
      }
      throw error;
    },
  );
}

function traced<T>(run: () => Promise<T>, ok: (value: T, at: Timing) => void, bad: (error: unknown, at: Timing) => void): Promise<T> {
  const at = timing();
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

function onlyOnce(args: unknown[]): boolean {
  for (const arg of args.slice(2)) {
    if (arg && typeof arg === "object" && "onlyOnce" in arg) return (arg as { onlyOnce?: boolean }).onlyOnce === true;
  }
  return false;
}

/**
 * Subscribe is recorded before the SDK call. `onValue` can deliver the first
 * snapshot synchronously, and that snapshot has to follow the subscribe.
 * If the SDK call throws, an unsubscribe is recorded for the same listener.
 */
function listen(real: AnyFn, event: "value" | "child_added" | "child_changed" | "child_removed" | "child_moved"): AnyFn {
  return (...args: unknown[]) => {
    const at = timing();
    const listener = nextListenerId();
    const target = args[0];
    const user = args[1];
    const once = onlyOnce(args);
    let initial = true;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      emit("unsubscribe", target, timing(), { listener });
    };
    const wrapped = (snap: unknown, prev?: unknown): unknown => {
      const payload: Record<string, unknown> = { listener, result: resultOf(snap) };
      if (event === "value") {
        if (initial) payload.initial = true;
        initial = false;
        emit("snapshot", target, timing(), payload);
      } else {
        emit(event, target, timing(), payload);
      }
      if (once) close();
      if (typeof user === "function") return (user as AnyFn)(snap, prev);
      return undefined;
    };
    const next = args.slice();
    next[1] = wrapped;
    if (typeof next[2] === "function") {
      const cancel = next[2] as AnyFn;
      next[2] = (error: unknown) => {
        const op = event === "value" ? "snapshot" : event;
        emit(op, target, timing(), { listener, error: errorCode(error) });
        close();
        return cancel(error);
      };
    }
    let unsub: unknown;
    emit("subscribe", target, at, { listener });
    try {
      unsub = real(...next);
    } catch (error) {
      close();
      throw error;
    }
    return () => {
      try {
        if (typeof unsub === "function") (unsub as AnyFn)();
      } finally {
        close();
      }
    };
  };
}

export const get: typeof realGet = ((query: unknown) =>
  traced(
    () => realGet(query as Parameters<typeof realGet>[0]),
    (snap, at) => emit(readOp(query), query, at, { result: resultOf(snap) }),
    (error, at) => emit(readOp(query), query, at, { error: errorCode(error) }),
  )) as typeof realGet;

export const set: typeof realSet = ((ref: unknown, value: unknown) =>
  traced(
    () => realSet(ref as Parameters<typeof realSet>[0], value),
    (_value, at) => emit("set", ref, at),
    (error, at) => emit("set", ref, at, { error: errorCode(error) }),
  )) as typeof realSet;

export const update: typeof realUpdate = ((ref: unknown, values: unknown) =>
  traced(
    () => realUpdate(ref as Parameters<typeof realUpdate>[0], values as Parameters<typeof realUpdate>[1]),
    (_value, at) => emit("update", ref, at),
    (error, at) => emit("update", ref, at, { error: errorCode(error) }),
  )) as typeof realUpdate;

export const remove: typeof realRemove = ((ref: unknown) =>
  traced(
    () => realRemove(ref as Parameters<typeof realRemove>[0]),
    (_value, at) => emit("delete", ref, at),
    (error, at) => emit("delete", ref, at, { error: errorCode(error) }),
  )) as typeof realRemove;

export const runTransaction: typeof realRunTransaction = ((ref: unknown, updateFn: unknown, options?: unknown) =>
  traced(
    () =>
      realRunTransaction(
        ref as Parameters<typeof realRunTransaction>[0],
        updateFn as Parameters<typeof realRunTransaction>[1],
        options as Parameters<typeof realRunTransaction>[2],
      ),
    (result, at) => {
      const snap = result && typeof result === "object" && "snapshot" in result ? (result as { snapshot?: unknown }).snapshot : undefined;
      const stats = snap ? resultOf(snap) : undefined;
      emit("update", ref, at, stats && stats.bytes > 0 ? { result: stats } : {});
    },
    (error, at) => emit("update", ref, at, { error: errorCode(error) }),
  )) as typeof realRunTransaction;

export const push: typeof realPush = ((parent: unknown, value?: unknown) => {
  const at = timing();
  const ref = realPush(parent as Parameters<typeof realPush>[0], value as Parameters<typeof realPush>[1]);
  const record = (error?: unknown): void => {
    emit("create", ref, at, error ? { error: errorCode(error) } : {});
  };
  if (value === undefined) {
    record();
    return ref;
  }
  try {
    void Promise.resolve(ref).then(
      () => record(),
      (error: unknown) => record(error),
    );
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
  return ref;
}) as typeof realPush;

export const onValue: typeof realOnValue = listen(realOnValue as AnyFn, "value") as typeof realOnValue;
export const onChildAdded: typeof realOnChildAdded = listen(realOnChildAdded as AnyFn, "child_added") as typeof realOnChildAdded;
export const onChildChanged: typeof realOnChildChanged = listen(realOnChildChanged as AnyFn, "child_changed") as typeof realOnChildChanged;
export const onChildRemoved: typeof realOnChildRemoved = listen(realOnChildRemoved as AnyFn, "child_removed") as typeof realOnChildRemoved;
export const onChildMoved: typeof realOnChildMoved = listen(realOnChildMoved as AnyFn, "child_moved") as typeof realOnChildMoved;

export const goOnline: typeof realGoOnline = ((db: Parameters<typeof realGoOnline>[0]) => {
  realGoOnline(db);
  emit("go_online", undefined, timing());
}) as typeof realGoOnline;

export const goOffline: typeof realGoOffline = ((db: Parameters<typeof realGoOffline>[0]) => {
  realGoOffline(db);
  emit("go_offline", undefined, timing());
}) as typeof realGoOffline;
