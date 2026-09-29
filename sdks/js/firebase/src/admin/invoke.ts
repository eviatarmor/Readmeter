/**
 * One invoke record per `withFlush` call. While the handler runs, Firestore
 * reads, Realtime Database download bytes, and Storage calls are tallied
 * from the raw records those shims already send. The core prices the invoke.
 * Payloads, URLs, project ids, and tokens are not copied.
 */

import { callsite } from "../core/callsite.ts";
import { recordRaw, sdkDebug, setRawObserver } from "../core/client.ts";
import { debugOnce } from "../core/log.ts";
import { nextCallId } from "../core/session.ts";
import { MAX_JSON_BYTES, jsonBytes } from "../web/database-shape.ts";
import { flush } from "../index.ts";
import { currentInvocation, runInvocation } from "./invocation.ts";

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

const RTDB_READS = new Set(["get", "query", "snapshot", "child_added", "child_changed", "child_removed", "child_moved"]);
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/;
const UUID_NAME = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface Tally {
  reads: number;
  rtdbBytes: number;
  storageOps: number;
}

interface Timing {
  ts: number;
  start: number;
  site?: string;
}

const tallies = new Map<number, Tally>();
let coldLeft = true;

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonNeg(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function tallyFor(id: number): Tally {
  let tally = tallies.get(id);
  if (!tally) {
    tally = { reads: 0, rtdbBytes: 0, storageOps: 0 };
    tallies.set(id, tally);
  }
  return tally;
}

function takeTally(id: number | undefined): Tally {
  if (id === undefined) return { reads: 0, rtdbBytes: 0, storageOps: 0 };
  const tally = tallies.get(id) ?? { reads: 0, rtdbBytes: 0, storageOps: 0 };
  tallies.delete(id);
  return tally;
}

/** Billed Firestore reads, matching the admin raw shape and `firestore/billing.rs`. */
function firestoreReads(call: Record<string, unknown>): number {
  if ("error" in call && call.error != null) return 0;
  if (call.from_cache === true) return 0;
  const result = asRecord(call.result);
  const docs = nonNeg(result?.docs);
  if (call.op === "get") return 1;
  if (call.op === "query") {
    const query = asRecord(call.query);
    return Math.max(docs, 1) + nonNeg(query?.offset);
  }
  if (call.op === "aggregate") {
    return Math.max(Math.ceil(nonNeg(result?.index_entries) / 1000), 1);
  }
  if (call.op === "snapshot") {
    return call.initial === true ? Math.max(docs, 1) : docs;
  }
  return 0;
}

function rtdbDownloadBytes(call: Record<string, unknown>): number {
  if ("error" in call && call.error != null) return 0;
  if (typeof call.op !== "string" || !RTDB_READS.has(call.op)) return 0;
  return nonNeg(asRecord(call.result)?.bytes);
}

function storageOps(call: Record<string, unknown>): number {
  if ("error" in call && call.error != null) return 0;
  return 1;
}

function observeRaw(raw: unknown): void {
  const id = currentInvocation();
  if (id === undefined) return;
  const call = asRecord(raw);
  if (!call || typeof call.service !== "string" || call.service === "functions") return;
  const tally = tallyFor(id);
  if (call.service === "firestore") tally.reads += firestoreReads(call);
  else if (call.service === "database") tally.rtdbBytes += rtdbDownloadBytes(call);
  else if (call.service === "storage") tally.storageOps += storageOps(call);
}

setRawObserver(observeRaw);

function safeName(raw: string | undefined): string | undefined {
  if (!raw || !SAFE_NAME.test(raw) || UUID_NAME.test(raw)) return undefined;
  return raw;
}

function functionTarget(): string {
  return safeName(process.env.FUNCTION_TARGET) ?? safeName(process.env.K_SERVICE) ?? "unknown";
}

function memoryMb(): number | undefined {
  const raw = process.env.FUNCTION_MEMORY_MB;
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

function capped(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return bytes > MAX_JSON_BYTES ? MAX_JSON_BYTES : Math.floor(bytes);
}

function requestBytes(args: unknown[]): number {
  const first = args[0];
  if (!first || typeof first !== "object") return 0;
  const rec = first as { data?: unknown; rawRequest?: unknown; rawBody?: unknown };
  if (rec.rawRequest !== undefined && "data" in rec) return jsonBytes(rec.data);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(rec.rawBody)) return capped(rec.rawBody.byteLength);
  return 0;
}

function chunkBytes(chunk: unknown): number {
  if (typeof chunk === "string") return new TextEncoder().encode(chunk).byteLength;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(chunk)) return chunk.byteLength;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

/** Counts bytes passed to `res.end` (Express `res.json` ends there). */
function watchEnd(args: unknown[]): { bytes: () => number } {
  let written = 0;
  const res = args[1];
  if (!res || typeof res !== "object") return { bytes: () => 0 };
  const host = res as { end?: (...inner: unknown[]) => unknown };
  if (typeof host.end !== "function") return { bytes: () => 0 };
  const original = host.end;
  host.end = function (this: unknown, ...inner: unknown[]) {
    try {
      written += chunkBytes(inner[0]);
    } catch (error) {
      debugOnce(sdkDebug(), error);
    }
    return original.apply(this, inner);
  };
  return { bytes: () => capped(written) };
}

function recordInvoke(input: {
  at: Timing;
  args: unknown[];
  tally: Tally;
  cold: boolean;
  failed: boolean;
  returned: unknown;
  thrown: unknown;
  written: number;
}): void {
  try {
    const call: Record<string, unknown> = {
      service: "functions",
      op: "invoke",
      name: functionTarget(),
      ts_ms: input.at.ts,
      call_id: nextCallId(),
      duration_us: elapsed(input.at.start),
    };
    if (input.at.site) call.callsite = input.at.site;
    const request = requestBytes(input.args);
    if (request > 0) call.request_bytes = request;
    if (!input.failed) {
      const response = input.written > 0 ? input.written : jsonBytes(input.returned);
      if (response > 0) call.response_bytes = response;
    } else {
      call.error = errorCode(input.thrown);
    }
    if (input.cold) call.cold = true;
    const memory = memoryMb();
    if (memory !== undefined) call.memory_mb = memory;
    if (input.tally.reads > 0) call.reads = input.tally.reads;
    if (input.tally.rtdbBytes > 0) call.rtdb_download_bytes = input.tally.rtdbBytes;
    if (input.tally.storageOps > 0) call.storage_ops = input.tally.storageOps;
    recordRaw(call);
  } catch (error) {
    debugOnce(sdkDebug(), error);
  }
}

/**
 * Awaits `flush` after `handler` settles. A handler error is rethrown unchanged.
 * Records one invoke with duration, cold start, memory when `FUNCTION_MEMORY_MB`
 * is set, and the Firestore / RTDB / Storage totals observed during the handler.
 */
export function withFlush<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => Promise<Awaited<R>> {
  return async (...args: A): Promise<Awaited<R>> => {
    const at = timing();
    const written = watchEnd(args);
    let invocation: number | undefined;
    let returned: Awaited<R> | undefined;
    let thrown: unknown;
    let failed = false;
    try {
      returned = await runInvocation(() => {
        invocation = currentInvocation();
        return handler(...args);
      });
      return returned;
    } catch (error) {
      thrown = error;
      failed = true;
      throw error;
    } finally {
      const tally = takeTally(invocation);
      const cold = coldLeft;
      coldLeft = false;
      recordInvoke({
        at,
        args,
        tally,
        cold,
        failed,
        returned,
        thrown,
        written: written.bytes(),
      });
      await flush();
    }
  };
}
