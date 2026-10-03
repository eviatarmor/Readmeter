/**
 * Drop-in for `firebase/functions`. Wrappers call the real callable and then
 * record a function-name template, byte counts, duration, and an allowlisted
 * error code. Payloads, URLs, project ids, tokens, and auth headers are not
 * copied onto the record.
 *
 * `httpsCallable` and `httpsCallableFromURL` stay the same type, including
 * `.stream`. `getFunctions` and `connectFunctionsEmulator` are re-exported
 * unchanged. The SDK does not retry a callable; `attempt` stays 1.
 */

import { callsite, takeInjected } from "../core/callsite.ts";
import { recordRaw, sdkDebug } from "../core/client.ts";
import { debugOnce } from "../core/log.ts";
import { nextCallId } from "../core/session.ts";
import { jsonBytes } from "./database-shape.ts";
import {
  httpsCallable as realHttpsCallable,
  httpsCallableFromURL as realHttpsCallableFromURL,
  type HttpsCallable,
  type HttpsCallableResult,
} from "firebase/functions";

export * from "firebase/functions";

interface Timing {
  site?: string;
  ts: number;
  start: number;
}

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/;
const UUID_NAME = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
  const text = typeof code === "string" ? code : "";
  if (text.length === 0) return "unknown";
  const slash = text.lastIndexOf("/");
  const part = slash >= 0 ? text.slice(slash + 1) : text;
  if (part.length === 0) return "unknown";
  return part.length > 64 ? part.slice(0, 64) : part;
}

/** Last non-empty path segment of a URL, or the string itself, when it is a safe function name. */
function functionName(raw: string): string {
  let name = raw.trim();
  if (name.includes("://") || name.startsWith("/")) {
    try {
      const url = new URL(name, "http://invalid.invalid");
      const parts = url.pathname.split("/").filter((part) => part.length > 0);
      name = parts.length > 0 ? (parts[parts.length - 1] ?? "") : "";
    } catch {
      name = "";
    }
  }
  if (!SAFE_NAME.test(name) || UUID_NAME.test(name)) return "unknown";
  return name;
}

function resultBytes(value: unknown): number {
  if (value && typeof value === "object" && "data" in value) {
    return jsonBytes((value as { data?: unknown }).data);
  }
  return jsonBytes(value);
}

function emit(name: string, at: Timing, requestBytes: number, responseBytes: number, error?: string): void {
  try {
    const call: Record<string, unknown> = {
      service: "functions",
      op: "callable",
      name,
      ts_ms: at.ts,
      call_id: nextCallId(),
      duration_us: elapsed(at.start),
    };
    if (at.site) call.callsite = at.site;
    if (requestBytes > 0) call.request_bytes = requestBytes;
    if (responseBytes > 0) call.response_bytes = responseBytes;
    if (error) call.error = error;
    recordRaw(call);
  } catch (inner) {
    debugOnce(sdkDebug(), inner);
  }
}

/** Warn when Node can read `@firebase/functions` and the major is not 0. The browser has no package read. */
function warnFunctionsMajor(): void {
  if (versionWarned) return;
  versionWarned = true;
  try {
    const proc = globalThis.process as { versions?: { node?: string }; getBuiltinModule?: (name: string) => { createRequire?: (url: string) => NodeRequire } } | undefined;
    if (!proc?.versions?.node || typeof proc.getBuiltinModule !== "function") return;
    const builtin = proc.getBuiltinModule("module");
    if (typeof builtin?.createRequire !== "function") return;
    const require = builtin.createRequire(import.meta.url);
    const pkg = require("@firebase/functions/package.json") as { version?: string };
    const version = typeof pkg.version === "string" ? pkg.version : "";
    const major = Number(version.split(".")[0]);
    if (major !== 0) {
      console.debug(`[readmeter] @firebase/functions ${version || "unknown"} is outside the verified 0.x httpsCallable`);
    }
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

function wrapCallable<RequestData, ResponseData, StreamData>(
  callable: HttpsCallable<RequestData, ResponseData, StreamData>,
  rawName: string,
): HttpsCallable<RequestData, ResponseData, StreamData> {
  const name = functionName(rawName);
  // A build plugin marks the `httpsCallable(...)` line; invocations of the
  // returned function use it when they have no callsite of their own.
  const created = takeInjected();
  const timed = (): Timing => {
    const at = timing();
    if (!at.site && created) at.site = created;
    return at;
  };
  const call = ((data?: RequestData | null) => {
    const at = timed();
    const requestBytes = jsonBytes(data);
    let pending: Promise<HttpsCallableResult<ResponseData>>;
    try {
      pending = Promise.resolve(callable(data));
    } catch (error) {
      emit(name, at, requestBytes, 0, errorCode(error));
      throw error;
    }
    return pending.then(
      (value) => {
        emit(name, at, requestBytes, resultBytes(value));
        return value;
      },
      (error: unknown) => {
        emit(name, at, requestBytes, 0, errorCode(error));
        throw error;
      },
    );
  }) as HttpsCallable<RequestData, ResponseData, StreamData>;
  call.stream = (data, options) => {
    const at = timed();
    const requestBytes = jsonBytes(data);
    let pending: ReturnType<HttpsCallable<RequestData, ResponseData, StreamData>["stream"]>;
    try {
      pending = callable.stream(data, options);
    } catch (error) {
      emit(name, at, requestBytes, 0, errorCode(error));
      throw error;
    }
    return pending.then(
      (value) => {
        emit(name, at, requestBytes, 0);
        return value;
      },
      (error: unknown) => {
        emit(name, at, requestBytes, 0, errorCode(error));
        throw error;
      },
    );
  };
  return call;
}

export const httpsCallable: typeof realHttpsCallable = ((functionsInstance, name, options) => {
  warnFunctionsMajor();
  return wrapCallable(realHttpsCallable(functionsInstance, name, options), name);
}) as typeof realHttpsCallable;

export const httpsCallableFromURL: typeof realHttpsCallableFromURL = ((functionsInstance, url, options) => {
  warnFunctionsMajor();
  return wrapCallable(realHttpsCallableFromURL(functionsInstance, url, options), url);
}) as typeof realHttpsCallableFromURL;
