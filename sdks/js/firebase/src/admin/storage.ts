/**
 * Cloud Functions / Node: `instrumentStorage(bucket)` patches `@google-cloud/storage`
 * File and Bucket methods. Verified against `@google-cloud/storage` 8.2.0
 * (firebase-admin 14.5.0).
 *
 * `File.save` calls `createWriteStream` on the same instance. A depth flag
 * keeps that inner stream from recording a second upload. A direct
 * `createWriteStream` on that File while `save` is still in flight is not
 * recorded. Retries inside one `save` count as one upload.
 *
 * `download` to a filesystem destination reports only the first chunk (the
 * GCS client passes that chunk to the callback). In-memory downloads report
 * the full buffer. `createReadStream` is not patched.
 *
 * `getMetadata` is shadowed on `File.prototype` only, so `Bucket.getMetadata`
 * stays a bucket call and is not recorded.
 */

import { createRequire } from "node:module";

import { callsite } from "../core/callsite.ts";
import { recordRaw, sdkDebug } from "../core/client.ts";
import { debugOnce } from "../core/log.ts";
import { nextCallId } from "../core/session.ts";

const PATCHED = Symbol.for("readmeter.admin.storage.patched");
const INSTRUMENTED = Symbol.for("readmeter.admin.storage.instrumented");
const DEPTH = Symbol.for("readmeter.admin.storage.saveDepth");

const MAX_CACHE_AGE_S = 315_360_000;
const MAX_AGE = /(?:^|[,\s])max-age=(\d+)/i;

type AnyFn = (...args: unknown[]) => unknown;

interface Timing {
  site?: string;
  ts: number;
  start: number;
}

let versionWarned = false;
let pathWarned = false;
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

function readPath(target: unknown): string {
  if (target && typeof target === "object") {
    const rec = target as { fullPath?: unknown; name?: unknown; getFiles?: unknown };
    if (typeof rec.fullPath === "string") return rec.fullPath;
    // Bucket.name is the bucket id. Callers that list pass the prefix themselves.
    if (typeof rec.getFiles === "function") return "";
    if (typeof rec.name === "string") return rec.name;
  }
  if (!pathWarned) {
    pathWarned = true;
    console.debug("[readmeter] storage object path is missing; recording an empty path");
  }
  return "";
}

function emit(op: string, target: unknown, at: Timing, extra: Record<string, unknown> = {}): void {
  try {
    const call: Record<string, unknown> = {
      service: "storage",
      op,
      ts_ms: at.ts,
      path: readPath(target),
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

function byteLength(data: unknown): number | undefined {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return undefined;
}

function metadataSize(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== "object" || !("size" in metadata)) return undefined;
  const size = (metadata as { size?: unknown }).size;
  if (typeof size === "number" && Number.isFinite(size) && size >= 0) return Math.floor(size);
  if (typeof size === "string" && /^[0-9]+$/.test(size)) {
    const parsed = Number(size);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function contentMajor(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const head = value.split(";", 1)[0] ?? "";
  const major = (head.split("/", 1)[0] ?? "").trim().toLowerCase();
  return /^[a-z]{1,32}$/.test(major) ? major : undefined;
}

function cacheControl(metadata: unknown): number | "none" | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const raw = (metadata as { cacheControl?: unknown }).cacheControl;
  if (typeof raw !== "string" || raw.trim().length === 0) return "none";
  const match = MAX_AGE.exec(raw);
  const digits = match?.[1];
  if (digits === undefined) return "none";
  const seconds = Number(digits);
  if (!Number.isFinite(seconds)) return "none";
  return Math.min(Math.floor(seconds), MAX_CACHE_AGE_S);
}

function noteMissing(name: string): void {
  if (missing.has(name)) return;
  missing.add(name);
  console.debug(`[readmeter] storage ${name} is missing; that call will not be recorded`);
}

function depthOf(host: unknown): number {
  if (!host || typeof host !== "object") return 0;
  const n = (host as { [DEPTH]?: unknown })[DEPTH];
  return typeof n === "number" ? n : 0;
}

function setDepth(host: unknown, n: number): void {
  if (host && typeof host === "object") (host as { [DEPTH]?: number })[DEPTH] = n;
}

function trailingCallback(args: unknown[]): { index: number; fn: AnyFn } | undefined {
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (typeof arg !== "function") return undefined;
    return { index: i, fn: arg as AnyFn };
  }
  return undefined;
}

/**
 * Records once. `save` returns a promise and, when a callback was passed,
 * invokes that callback too. The flag keeps those two paths at one record.
 */
function hookBoth(host: unknown, original: AnyFn, args: unknown[], ok: (value: unknown) => void, bad: (error: unknown) => void): unknown {
  let recorded = false;
  const succeed = (value: unknown): void => {
    if (recorded) return;
    recorded = true;
    try {
      ok(value);
    } catch (error) {
      debugOnce(sdkDebug(), error);
    }
  };
  const fail = (error: unknown): void => {
    if (recorded) return;
    recorded = true;
    try {
      bad(error);
    } catch (inner) {
      debugOnce(sdkDebug(), inner);
    }
  };
  const next = args.slice();
  const cb = trailingCallback(next);
  if (cb) {
    next[cb.index] = (...cbArgs: unknown[]) => {
      const err = cbArgs[0];
      if (err) fail(err);
      else succeed(cbArgs.slice(1));
      return cb.fn(...cbArgs);
    };
  }
  let result: unknown;
  try {
    result = original.apply(host, next);
  } catch (error) {
    fail(error);
    throw error;
  }
  if (result && typeof (result as { then?: unknown }).then === "function") {
    void (result as Promise<unknown>).then(
      (value) => succeed(value),
      (error: unknown) => fail(error),
    );
  } else if (!cb) {
    succeed(result);
  }
  return result;
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function saveOptions(args: unknown[]): Record<string, unknown> {
  const second = args[1];
  if (second && typeof second === "object") return second as Record<string, unknown>;
  return {};
}

function wrapSave(original: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    const at = timing();
    const options = saveOptions(args);
    const resumable = options.resumable !== false;
    const meta = options.metadata;
    setDepth(this, depthOf(this) + 1);
    const release = (): void => setDepth(this, Math.max(0, depthOf(this) - 1));
    const facts = (error?: unknown): Record<string, unknown> => {
      const extra: Record<string, unknown> = { resumable };
      if (error) {
        extra.error = errorCode(error);
        return extra;
      }
      const size = metadataSize(meta) ?? byteLength(args[0]);
      if (size !== undefined) extra.bytes = size;
      if (meta && typeof meta === "object" && "contentType" in meta) {
        const type = contentMajor((meta as { contentType?: unknown }).contentType);
        if (type) extra.content_type = type;
      }
      const cache = cacheControl(meta);
      if (cache !== undefined) extra.cache_control = cache;
      return extra;
    };
    try {
      const result = hookBoth(
        this,
        original,
        args,
        () => emit("upload", this, at, facts()),
        (error) => emit("upload", this, at, facts(error)),
      );
      if (result && typeof (result as { then?: unknown }).then === "function") {
        void (result as Promise<unknown>).then(release, release);
      } else {
        release();
      }
      return result;
    } catch (error) {
      release();
      throw error;
    }
  };
}

function wrapCreateWriteStream(original: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    if (depthOf(this) > 0) return original.apply(this, args);
    const start = performance.now();
    const site = callsite();
    const options = args[0];
    const resumable = !options || typeof options !== "object" || (options as { resumable?: unknown }).resumable !== false;
    const stream = original.apply(this, args);
    if (!stream || typeof stream !== "object" || typeof (stream as { on?: unknown }).on !== "function") return stream;
    // Node calls `_write` from `end(chunk)`. Replacing the public `write` misses that path.
    const writable = stream as {
      _write?: AnyFn;
      _writev?: AnyFn;
      on: (event: string, fn: (error?: unknown) => void) => unknown;
    };
    let written = 0;
    const addChunk = (chunk: unknown): void => {
      written += byteLength(chunk) ?? 0;
    };
    if (typeof writable._write === "function") {
      const write = writable._write;
      writable._write = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
        addChunk(chunk);
        return write.apply(this, [chunk, ...rest]);
      };
    }
    if (typeof writable._writev === "function") {
      const writev = writable._writev;
      writable._writev = function (this: unknown, chunks: unknown, ...rest: unknown[]) {
        if (Array.isArray(chunks)) {
          for (const item of chunks) {
            const chunk = item && typeof item === "object" && "chunk" in item ? (item as { chunk?: unknown }).chunk : item;
            addChunk(chunk);
          }
        }
        return writev.apply(this, [chunks, ...rest]);
      };
    }
    let settled = false;
    const record = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      const at: Timing = { ts: Date.now(), start };
      if (site) at.site = site;
      const extra: Record<string, unknown> = { resumable };
      if (error) extra.error = errorCode(error);
      else if (written > 0) extra.bytes = written;
      emit("upload", this, at, extra);
    };
    writable.on("finish", () => record());
    writable.on("error", (error) => record(error));
    return stream;
  };
}

function wrapDownload(original: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    const at = timing();
    return hookBoth(
      this,
      original,
      args,
      (value) => {
        const n = byteLength(first(value));
        emit("download", this, at, n !== undefined && n > 0 ? { bytes: n } : {});
      },
      (error) => emit("download", this, at, { error: errorCode(error) }),
    );
  };
}

function wrapDelete(original: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    const at = timing();
    return hookBoth(
      this,
      original,
      args,
      () => emit("delete", this, at),
      (error) => emit("delete", this, at, { error: errorCode(error) }),
    );
  };
}

function wrapSignedUrl(original: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    const at = timing();
    return hookBoth(
      this,
      original,
      args,
      () => emit("signed_url", this, at),
      (error) => emit("signed_url", this, at, { error: errorCode(error) }),
    );
  };
}

function wrapMetadata(original: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    const at = timing();
    return hookBoth(
      this,
      original,
      args,
      (value) => {
        const meta = first(value);
        const extra: Record<string, unknown> = {
          result: { bytes: metadataSize(meta) ?? 0, items: 0 },
          cache_control: cacheControl(meta && typeof meta === "object" ? meta : {}),
        };
        const type = meta && typeof meta === "object" && "contentType" in meta ? contentMajor((meta as { contentType?: unknown }).contentType) : undefined;
        if (type) extra.content_type = type;
        emit("get_metadata", this, at, extra);
      },
      (error) => emit("get_metadata", this, at, { error: errorCode(error) }),
    );
  };
}

function queryOf(args: unknown[]): Record<string, unknown> {
  const firstArg = args[0];
  if (firstArg && typeof firstArg === "object") return firstArg as Record<string, unknown>;
  return {};
}

function prefixCount(api: unknown): number {
  if (!api || typeof api !== "object" || !("prefixes" in api)) return 0;
  const prefixes = (api as { prefixes?: unknown }).prefixes;
  return Array.isArray(prefixes) ? prefixes.length : 0;
}

function wrapGetFiles(original: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    const at = timing();
    const query = queryOf(args);
    const op = query.autoPaginate === false ? "list" : "list_all";
    const path = typeof query.prefix === "string" ? query.prefix : "";
    return hookBoth(
      this,
      original,
      args,
      (value) => {
        const parts = Array.isArray(value) ? value : [value];
        const files = parts[0];
        const next = parts[1];
        const api = parts[2];
        const extra: Record<string, unknown> = {
          path,
          result: {
            items: Array.isArray(files) ? files.length : 0,
            prefixes: prefixCount(api),
          },
        };
        if (op === "list" && typeof query.maxResults === "number" && Number.isFinite(query.maxResults)) {
          extra.max_results = Math.max(0, Math.floor(query.maxResults));
        }
        if (next && typeof next === "object") {
          const token = (next as { pageToken?: unknown }).pageToken;
          if (typeof token === "string" && token.length > 0) extra.page_token = true;
        }
        emit(op, this, at, extra);
      },
      (error) => emit(op, this, at, { path, error: errorCode(error) }),
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

/** Defines `name` on `proto` even when the original lives further up the chain. */
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

function ensureFile(proto: object | null): void {
  if (!proto) return;
  patchOwn(proto, "download", wrapDownload);
  patchOwn(proto, "save", wrapSave);
  patchOwn(proto, "createWriteStream", wrapCreateWriteStream);
  patchOwn(proto, "delete", wrapDelete);
  patchOwn(proto, "getSignedUrl", wrapSignedUrl);
  shadow(proto, "getMetadata", wrapMetadata);
}

function warnMajor(): void {
  if (versionWarned) return;
  versionWarned = true;
  try {
    const require = createRequire(import.meta.url);
    let pkg: { version?: string };
    try {
      pkg = require("@google-cloud/storage/package.json") as { version?: string };
    } catch {
      // The SDK lists the package as an optional peer. firebase-admin depends on it.
      const adminPkg = require.resolve("firebase-admin/package.json");
      pkg = createRequire(adminPkg)("@google-cloud/storage/package.json") as { version?: string };
    }
    const version = typeof pkg.version === "string" ? pkg.version : "";
    const major = Number(version.split(".")[0]);
    if (major !== 8) {
      console.debug(`[readmeter] @google-cloud/storage ${version || "unknown"} is outside the verified 8.x file methods`);
    }
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

interface BucketLike {
  file?: (name: string) => unknown;
  getFiles?: unknown;
}

function asBucket(target: unknown): BucketLike | undefined {
  if (!target || typeof target !== "object") return undefined;
  const host = target as BucketLike & { bucket?: (name?: string) => unknown };
  if (typeof host.getFiles === "function" && typeof host.file === "function") return host;
  if (typeof host.bucket !== "function") return undefined;
  const got = host.bucket("demo-readmeter.appspot.com");
  if (!got || typeof got !== "object") return undefined;
  return got as BucketLike;
}

/**
 * Records Cloud Storage calls on this bucket (or a Storage client) and returns it.
 * Safe to call more than once. Never throws. Passing a Storage client only
 * constructs a local bucket handle so the prototypes can be patched.
 */
export function instrumentStorage<T>(target: T): T {
  try {
    if (!target || typeof target !== "object") return target;
    const host = target as T & { [INSTRUMENTED]?: boolean };
    if (host[INSTRUMENTED]) return target;
    warnMajor();
    const bucket = asBucket(target);
    if (bucket && typeof bucket.file === "function") {
      const probe = bucket.file("__rm_probe");
      if (probe && typeof probe === "object") ensureFile(Object.getPrototypeOf(probe) as object | null);
    }
    if (bucket) {
      const proto = Object.getPrototypeOf(bucket) as object | null;
      if (proto) patchOwn(proto, "getFiles", wrapGetFiles);
    }
    host[INSTRUMENTED] = true;
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
  return target;
}
