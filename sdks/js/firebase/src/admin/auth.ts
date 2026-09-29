/**
 * Cloud Functions / Node: `instrumentAuth(auth)` patches `firebase-admin` 14.5.0
 * `BaseAuth` methods. `createUser` and the lookup helpers are not patched.
 * Uids, tokens, claims, and page-token strings are not recorded.
 */
import { createRequire } from "node:module";

import { callsite } from "../core/callsite.ts";
import { recordRaw, sdkDebug } from "../core/client.ts";
import { debugOnce } from "../core/log.ts";
import { nextCallId } from "../core/session.ts";
import { currentInvocation } from "./invocation.ts";

const PATCHED = Symbol.for("readmeter.admin.auth.patched");
const INSTRUMENTED = Symbol.for("readmeter.admin.auth.instrumented");

type AnyFn = (...args: unknown[]) => unknown;

interface Timing {
  site?: string;
  ts: number;
  start: number;
}

let versionWarned = false;
const missing = new Set<string>();

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
  const text = typeof code === "string" ? code : typeof code === "number" && Number.isFinite(code) ? String(code) : "";
  if (text.length === 0) return "unknown";
  const slash = text.lastIndexOf("/");
  const part = slash >= 0 ? text.slice(slash + 1) : text;
  if (part.length === 0) return "unknown";
  return part.length > 64 ? part.slice(0, 64) : part;
}

function emit(op: string, at: Timing, extra: Record<string, unknown> = {}): void {
  try {
    const call: Record<string, unknown> = {
      service: "auth",
      op,
      ts_ms: at.ts,
      call_id: nextCallId(),
      duration_us: elapsed(at.start),
    };
    if (at.site) call.callsite = at.site;
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) call[key] = value;
    }
    recordRaw(call);
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

function noteMissing(name: string): void {
  if (missing.has(name)) return;
  missing.add(name);
  console.debug(`[readmeter] auth ${name} is missing; that call will not be recorded`);
}

function hook(host: unknown, original: AnyFn, args: unknown[], ok: (value: unknown) => void, bad: (error: unknown) => void): unknown {
  let result: unknown;
  try {
    result = original.apply(host, args);
  } catch (error) {
    try {
      bad(error);
    } catch (inner) {
      debugOnce(sdkDebug(), inner);
    }
    throw error;
  }
  if (!result || typeof result !== "object" || typeof (result as { then?: unknown }).then !== "function") {
    try {
      ok(result);
    } catch (error) {
      debugOnce(sdkDebug(), error);
    }
    return result;
  }
  return (result as Promise<unknown>).then(
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

function record(op: string, method: string, at: Timing, extra: Record<string, unknown> = {}): void {
  emit(op, at, { method, ...extra });
}

function wrapPlain(op: string, method: string): (original: AnyFn) => AnyFn {
  return (original) =>
    function (this: unknown, ...args: unknown[]) {
      const at = timing();
      return hook(
        this,
        original,
        args,
        () => record(op, method, at),
        (error) => record(op, method, at, { error: errorCode(error) }),
      );
    };
}

function wrapListUsers(original: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    const at = timing();
    const requested = typeof args[1] === "string" && args[1].length > 0;
    return hook(
      this,
      original,
      args,
      (value) => {
        const users = value && typeof value === "object" && "users" in value ? (value as { users?: unknown }).users : undefined;
        const next = value && typeof value === "object" && "pageToken" in value ? (value as { pageToken?: unknown }).pageToken : undefined;
        const extra: Record<string, unknown> = {
          result: { items: Array.isArray(users) ? users.length : 0 },
        };
        if (requested || (typeof next === "string" && next.length > 0)) extra.page_token = true;
        const invocation = currentInvocation();
        if (invocation !== undefined) extra.invocation = invocation;
        record("list_users", "listUsers", at, extra);
      },
      (error) => {
        const extra: Record<string, unknown> = { error: errorCode(error) };
        const invocation = currentInvocation();
        if (invocation !== undefined) extra.invocation = invocation;
        record("list_users", "listUsers", at, extra);
      },
    );
  };
}

function patchOwn(proto: object, name: string, wrap: (original: AnyFn) => AnyFn): void {
  const desc = Object.getOwnPropertyDescriptor(proto, name);
  if (!desc || typeof desc.value !== "function") {
    noteMissing(name);
    return;
  }
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

function shadow(proto: object, name: string, wrap: (original: AnyFn) => AnyFn): void {
  if (Object.prototype.hasOwnProperty.call(proto, name)) {
    patchOwn(proto, name, wrap);
    return;
  }
  let cur: object | null = Object.getPrototypeOf(proto) as object | null;
  let original: (AnyFn & { [PATCHED]?: boolean }) | undefined;
  while (cur && cur !== Object.prototype) {
    const desc = Object.getOwnPropertyDescriptor(cur, name);
    if (desc && typeof desc.value === "function") {
      original = desc.value as AnyFn & { [PATCHED]?: boolean };
      break;
    }
    cur = Object.getPrototypeOf(cur) as object | null;
  }
  if (!original) {
    noteMissing(name);
    return;
  }
  if (original[PATCHED]) return;
  const wrapped = wrap(original) as AnyFn & { [PATCHED]?: boolean };
  wrapped[PATCHED] = true;
  Object.defineProperty(proto, name, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: wrapped,
  });
}

function warnMajor(): void {
  if (versionWarned) return;
  versionWarned = true;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("firebase-admin/package.json") as { version?: string };
    const version = typeof pkg.version === "string" ? pkg.version : "";
    const major = Number(version.split(".")[0]);
    if (major !== 14) {
      console.debug(`[readmeter] firebase-admin ${version || "unknown"} is outside the verified 14.x auth methods`);
    }
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

/**
 * Records Auth admin calls on this instance and returns it.
 * Safe to call more than once. Never throws.
 */
export function instrumentAuth<T>(target: T): T {
  try {
    if (!target || typeof target !== "object") return target;
    const host = target as T & { [INSTRUMENTED]?: boolean };
    if (host[INSTRUMENTED]) return target;
    warnMajor();
    const proto = Object.getPrototypeOf(target) as object | null;
    if (proto) {
      shadow(proto, "verifyIdToken", wrapPlain("verify_id_token", "verifyIdToken"));
      shadow(proto, "getUser", wrapPlain("get_user", "getUser"));
      shadow(proto, "listUsers", wrapListUsers);
      shadow(proto, "createCustomToken", wrapPlain("custom_token", "createCustomToken"));
      shadow(proto, "setCustomUserClaims", wrapPlain("set_claims", "setCustomUserClaims"));
    }
    host[INSTRUMENTED] = true;
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
  return target;
}
