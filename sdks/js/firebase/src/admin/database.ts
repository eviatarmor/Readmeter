/**
 * Cloud Functions / Node: `instrumentDatabase(db)` patches compat Reference
 * methods on `firebase-admin/database`. Verified against firebase-admin 14.5.0
 * and `@firebase/database` 1.1.5 (the compat `Reference` delegates to modular
 * `QueryImpl`).
 *
 * Compat `on` remembers the callback it was given and `off` matches that
 * function. The patch keeps a stack of wrappers per user callback and
 * translates `off` back, so an unsubscribe is recorded. `get` is patched as
 * well: it is a billed read on the same prototype even though the web drop-in
 * uses the modular `get()` function.
 */

import { createRequire } from "node:module";

import { callsite } from "../core/callsite.ts";
import { recordRaw, sdkDebug } from "../core/client.ts";
import { debugOnce } from "../core/log.ts";
import { nextCallId, nextListenerId } from "../core/session.ts";
import { childCount, jsonBytes, readPath, readQueryShape, snapshotValue } from "../web/database-shape.ts";

const PATCHED = Symbol.for("readmeter.admin.database.patched");
const INSTRUMENTED = Symbol.for("readmeter.admin.database.instrumented");

type AnyFn = (...args: unknown[]) => unknown;

interface Timing {
  site?: string;
  ts: number;
  start: number;
}

const wrappers = new WeakMap<object, AnyFn[]>();
const listenerOf = new WeakMap<object, number>();
const sawInitial = new Set<number>();
let versionWarned = false;

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
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) call[key] = value;
    }
    recordRaw(call);
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

function resultOf(snapshot: unknown): { children: number; bytes: number } | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const stats = { children: childCount(snapshot), bytes: jsonBytes(snapshotValue(snapshot)) };
  return stats.bytes > 0 || stats.children > 0 ? stats : stats;
}

function readOp(target: unknown): "get" | "query" {
  return readQueryShape(target) ? "query" : "get";
}

function childOp(event: unknown): string | undefined {
  if (event === "child_added" || event === "child_changed" || event === "child_removed" || event === "child_moved") return event;
  return undefined;
}

function remember(user: object, wrapped: AnyFn): void {
  const list = wrappers.get(user) ?? [];
  list.push(wrapped);
  wrappers.set(user, list);
}

function takeWrapper(user: object): AnyFn | undefined {
  const list = wrappers.get(user);
  if (!list || list.length === 0) return undefined;
  const wrapped = list.shift();
  if (list.length === 0) wrappers.delete(user);
  return wrapped;
}

function noteDelivery(host: unknown, event: unknown, snap: unknown, listener: number): void {
  const child = childOp(event);
  if (child) {
    emit(child, host, timing(), { listener, result: resultOf(snap) });
    return;
  }
  if (event !== "value") return;
  const extra: Record<string, unknown> = { listener, result: resultOf(snap) };
  if (!sawInitial.has(listener)) {
    extra.initial = true;
    sawInitial.add(listener);
  }
  emit("snapshot", host, timing(), extra);
}

function noteRead(host: unknown, event: unknown, snap: unknown, at: Timing, error?: unknown): void {
  const extra: Record<string, unknown> = {};
  if (error) extra.error = errorCode(error);
  else {
    const stats = resultOf(snap);
    if (stats) extra.result = stats;
  }
  const child = childOp(event);
  emit(child ?? readOp(host), host, at, extra);
}

function settle(result: unknown, ok: (value: unknown) => void, bad: (error: unknown) => void): unknown {
  if (!result || typeof (result as { then?: unknown }).then !== "function") {
    ok(result);
    return result;
  }
  void (result as Promise<unknown>).then(
    (value) => {
      try {
        ok(value);
      } catch (error) {
        debugOnce(sdkDebug(), error);
      }
    },
    (error: unknown) => {
      try {
        bad(error);
      } catch (inner) {
        debugOnce(sdkDebug(), inner);
      }
    },
  );
  return result;
}

function wrapOn(original: AnyFn): AnyFn {
  return function (this: unknown, event: unknown, callback: unknown, ...rest: unknown[]) {
    const at = timing();
    const listener = nextListenerId();
    const host = this;
    const user = typeof callback === "function" ? (callback as AnyFn) : undefined;
    const wrapped = function (this: unknown, snap: unknown, prev?: unknown): unknown {
      noteDelivery(host, event, snap, listener);
      if (user) return user.apply(this, [snap, prev]);
      return undefined;
    };
    if (user) {
      remember(user, wrapped as AnyFn);
      listenerOf.set(wrapped, listener);
    }
    emit("subscribe", host, at, { listener });
    try {
      const returned = original.apply(host, [event, user ? wrapped : callback, ...rest]);
      // Compat `on` returns the callback it stored. Hand back the user's
      // function so `off(event, callback)` still finds the wrapper.
      return user && returned === wrapped ? callback : returned;
    } catch (error) {
      sawInitial.delete(listener);
      emit("unsubscribe", host, timing(), { listener });
      throw error;
    }
  };
}

function wrapOff(original: AnyFn): AnyFn {
  return function (this: unknown, event?: unknown, callback?: unknown, context?: unknown) {
    const host = this;
    const user = typeof callback === "function" ? callback : undefined;
    const wrapped = user ? takeWrapper(user) : undefined;
    const listener = wrapped ? listenerOf.get(wrapped) : undefined;
    try {
      const result = original.apply(host, [event, wrapped ?? callback, context]);
      if (listener !== undefined) {
        sawInitial.delete(listener);
        emit("unsubscribe", host, timing(), { listener });
      }
      return result;
    } catch (error) {
      if (user && wrapped) remember(user, wrapped);
      throw error;
    }
  };
}

function wrapOnce(original: AnyFn): AnyFn {
  return function (this: unknown, event: unknown, ...rest: unknown[]) {
    const at = timing();
    const host = this;
    const result = original.apply(host, [event, ...rest]);
    return settle(result, (snap) => noteRead(host, event, snap, at), (error) => noteRead(host, event, undefined, at, error));
  };
}

function wrapGet(original: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    const at = timing();
    const host = this;
    const result = original.apply(host, args);
    return settle(result, (snap) => noteRead(host, "value", snap, at), (error) => noteRead(host, "value", undefined, at, error));
  };
}

function wrapWrite(op: "set" | "update" | "delete"): (original: AnyFn) => AnyFn {
  return (original) =>
    function (this: unknown, ...args: unknown[]) {
      const at = timing();
      const host = this;
      const result = original.apply(host, args);
      return settle(result, () => emit(op, host, at), (error) => emit(op, host, at, { error: errorCode(error) }));
    };
}

function wrapPush(original: AnyFn): AnyFn {
  return function (this: unknown, value?: unknown) {
    const at = timing();
    const host = this;
    const ref = original.apply(host, [value]);
    const record = (error?: unknown): void => {
      emit("create", ref, at, error ? { error: errorCode(error) } : {});
    };
    if (value === undefined) {
      record();
      return ref;
    }
    settle(ref, () => record(), (error) => record(error));
    return ref;
  };
}

function wrapTransaction(original: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    const at = timing();
    const host = this;
    const result = original.apply(host, args);
    return settle(
      result,
      (value) => {
        const snap = value && typeof value === "object" && "snapshot" in value ? (value as { snapshot?: unknown }).snapshot : undefined;
        const stats = snap ? resultOf(snap) : undefined;
        emit("update", host, at, stats && stats.bytes > 0 ? { result: stats } : {});
      },
      (error) => emit("update", host, at, { error: errorCode(error) }),
    );
  };
}

function patchOwn(proto: object, name: string, wrap: (original: AnyFn) => AnyFn): void {
  const desc = Object.getOwnPropertyDescriptor(proto, name);
  if (!desc || typeof desc.value !== "function") return;
  const original = desc.value as AnyFn & { [PATCHED]?: boolean };
  if (original[PATCHED]) return;
  const wrapped = wrap(original) as AnyFn & { [PATCHED]?: boolean };
  wrapped[PATCHED] = true;
  Object.defineProperty(proto, name, {
    configurable: true,
    enumerable: desc.enumerable ?? false,
    writable: true,
    value: wrapped,
  });
}

function patchChain(start: object | null, name: string, wrap: (original: AnyFn) => AnyFn): void {
  let cur: object | null = start;
  while (cur && cur !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(cur, name)) {
      patchOwn(cur, name, wrap);
      return;
    }
    cur = Object.getPrototypeOf(cur) as object | null;
  }
}

function warnMajor(): void {
  if (versionWarned) return;
  versionWarned = true;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@firebase/database/package.json") as { version?: string };
    const version = typeof pkg.version === "string" ? pkg.version : "";
    const major = Number(version.split(".")[0]);
    if (major !== 1) {
      console.debug(`[readmeter] @firebase/database ${version || "unknown"} is outside the verified 1.x query shape`);
    }
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

function ensure(probe: object): void {
  const proto = Object.getPrototypeOf(probe) as object | null;
  patchChain(proto, "on", wrapOn);
  patchChain(proto, "off", wrapOff);
  patchChain(proto, "once", wrapOnce);
  patchChain(proto, "get", wrapGet);
  patchChain(proto, "set", wrapWrite("set"));
  patchChain(proto, "update", wrapWrite("update"));
  patchChain(proto, "remove", wrapWrite("delete"));
  patchChain(proto, "push", wrapPush);
  patchChain(proto, "transaction", wrapTransaction);
}

/**
 * Records Realtime Database calls on this admin instance and returns it.
 * Safe to call more than once. Never throws.
 */
export function instrumentDatabase<T>(db: T): T {
  try {
    if (!db || typeof db !== "object") return db;
    const host = db as T & { ref?: (path?: string) => unknown; [INSTRUMENTED]?: boolean };
    if (host[INSTRUMENTED]) return db;
    warnMajor();
    if (typeof host.ref === "function") {
      const probe = host.ref("__rm_probe");
      if (probe && typeof probe === "object") ensure(probe);
    }
    host[INSTRUMENTED] = true;
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
  return db;
}
