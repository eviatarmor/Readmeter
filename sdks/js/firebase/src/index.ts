import { base64ToBytes, refreshBundle, resolveBundle } from "./core/bundle.ts";
import { CoreClient, configJson, disableRecording, handoff, recordRaw } from "./core/client.ts";
import { detectPlatform } from "./core/env.ts";
import { debugOnce, errorMessage } from "./core/log.ts";
import { newSessionId, nextCallId, resetIds } from "./core/session.ts";
import { Transport } from "./core/transport.ts";
import { flushPendingUsage } from "./core/usage.ts";
import { loadWasm } from "./core/wasm.ts";
import type { Finding, InitOptions, Platform, WriteOp } from "./types.ts";
import { sink, sinkListener, sinkWrite } from "./web/sink.ts";

export type { Finding, InitOptions, Platform, WriteOp };

const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_MAX_BATCH_EVENTS = 200;

interface Validated {
  apiKey: string;
  hashKey?: string;
  endpoint: string;
  dev: boolean;
  sampleRate: number;
  flushIntervalMs: number;
  maxBatchEvents: number;
  bundle?: Uint8Array;
  bundlePublicKey?: string;
  platform: Platform;
  onFinding?: (finding: Finding) => void;
  debug: boolean;
}

let transport: Transport | undefined;
let ready: Promise<void> = Promise.resolve();
let generation = 0;
let debug = false;

interface EventHost {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

interface PageHost extends EventHost {
  visibilityState?: string;
}

interface Watch {
  host: EventHost;
  type: string;
  handler: () => void;
}

/** Host listeners added by `watchPage`, removed together by `unwatchPage`. */
let watches: Watch[] = [];

function unwatchPage(): void {
  for (const { host, type, handler } of watches) {
    try {
      host.removeEventListener?.(type, handler);
    } catch (error) {
      debugOnce(debug, error);
    }
  }
  watches = [];
}

function listen(host: EventHost | undefined, type: string, record: () => Record<string, unknown>): void {
  try {
    if (!host || typeof host.addEventListener !== "function") return;
    const handler = () => {
      try {
        recordRaw({ ts_ms: Date.now(), call_id: nextCallId(), ...record() });
      } catch (error) {
        debugOnce(debug, error);
      }
    };
    host.addEventListener(type, handler);
    watches.push({ host, type, handler });
  } catch (error) {
    debugOnce(debug, error);
  }
}

/**
 * Reports page visibility and connection changes. Firestore bills a
 * listener as a new query when it reconnects after 30+ minutes offline;
 * `freeze` counts as offline because a frozen tab stops network activity.
 * No-op where `document` / `window` do not exist (Node, Deno).
 */
function watchPage(): void {
  unwatchPage();
  let doc: PageHost | undefined;
  let win: EventHost | undefined;
  try {
    const g = globalThis as { document?: PageHost; window?: EventHost };
    doc = g.document;
    win = g.window;
  } catch (error) {
    debugOnce(debug, error);
    return;
  }
  listen(doc, "visibilitychange", () => ({ op: "page", visible: doc?.visibilityState === "visible" }));
  listen(win, "offline", () => ({ op: "connection", online: false }));
  listen(win, "online", () => ({ op: "connection", online: true }));
  listen(doc, "freeze", () => ({ op: "connection", online: false }));
  listen(doc, "resume", () => ({ op: "connection", online: true }));
}

function isPublicKey(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return base64ToBytes(value.trim()).byteLength === 32;
  } catch {
    return false;
  }
}

function validate(options: InitOptions): Validated {
  if (options === null || typeof options !== "object") throw new Error("init options must be an object");
  if (typeof options.apiKey !== "string" || options.apiKey.length === 0) throw new Error("apiKey is required");
  if (typeof options.endpoint !== "string" || options.endpoint.trim().length === 0) {
    throw new Error("endpoint is required");
  }
  if (options.hashKey !== undefined && (typeof options.hashKey !== "string" || !/^[0-9a-fA-F]{32}$/.test(options.hashKey))) {
    throw new Error("hashKey must be 32 hex characters");
  }
  if (options.sampleRate !== undefined && (typeof options.sampleRate !== "number" || !(options.sampleRate >= 0 && options.sampleRate <= 1))) {
    throw new Error("sampleRate must be within 0..=1");
  }
  if (
    options.flushIntervalMs !== undefined &&
    (typeof options.flushIntervalMs !== "number" || !Number.isFinite(options.flushIntervalMs) || !(options.flushIntervalMs > 0))
  ) {
    throw new Error("flushIntervalMs must be greater than 0");
  }
  if (
    options.maxBatchEvents !== undefined &&
    (typeof options.maxBatchEvents !== "number" || !Number.isInteger(options.maxBatchEvents) || options.maxBatchEvents <= 0)
  ) {
    throw new Error("maxBatchEvents must be a positive integer");
  }
  const platform = options.platform ?? detectPlatform();
  if (platform !== "browser" && platform !== "server" && platform !== "mobile") {
    throw new Error("platform must be browser, server, or mobile");
  }
  if (options.bundle !== undefined && !(options.bundle instanceof Uint8Array)) throw new Error("bundle must be a Uint8Array");
  if (options.bundlePublicKey !== undefined && !isPublicKey(options.bundlePublicKey)) {
    throw new Error("bundlePublicKey must be a base64 32-byte Ed25519 public key");
  }
  if (options.dev !== undefined && typeof options.dev !== "boolean") throw new Error("dev must be a boolean");
  if (options.debug !== undefined && typeof options.debug !== "boolean") throw new Error("debug must be a boolean");
  if (options.onFinding !== undefined && typeof options.onFinding !== "function") throw new Error("onFinding must be a function");

  const validated: Validated = {
    apiKey: options.apiKey,
    endpoint: options.endpoint.trim().replace(/\/+$/, ""),
    dev: options.dev ?? false,
    sampleRate: options.sampleRate ?? 1,
    flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    maxBatchEvents: options.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS,
    platform,
    debug: options.debug ?? false,
  };
  if (options.hashKey !== undefined) validated.hashKey = options.hashKey.toLowerCase();
  if (options.bundle !== undefined) validated.bundle = options.bundle;
  if (options.bundlePublicKey !== undefined) validated.bundlePublicKey = options.bundlePublicKey.trim();
  if (options.onFinding !== undefined) validated.onFinding = options.onFinding;
  return validated;
}

function fail(gen: number, error: unknown): void {
  if (gen !== generation) return;
  unwatchPage();
  disableRecording();
  const current = transport;
  transport = undefined;
  void current?.shutdown();
  console.error(`[readmeter] ${errorMessage(error)}. The SDK is disabled.`);
}

async function fetchHashKey(endpoint: string, apiKey: string): Promise<string> {
  const res = await fetch(`${endpoint}/v1/config`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`GET /v1/config failed (${res.status})`);
  const body = (await res.json()) as { hash_key?: unknown };
  if (typeof body.hash_key !== "string" || !/^[0-9a-fA-F]{32}$/.test(body.hash_key)) {
    throw new Error("GET /v1/config did not return a hash_key");
  }
  return body.hash_key.toLowerCase();
}

async function boot(
  gen: number,
  opts: Validated,
  client: CoreClient,
  session: string,
  previous: CoreClient,
  previousTransport: Transport | undefined,
): Promise<void> {
  let released = false;
  try {
    await previousTransport?.shutdown();
    if (gen !== generation) return;
    previous.free();
    released = true;

    const hashKey = opts.hashKey ?? (await fetchHashKey(opts.endpoint, opts.apiKey));
    if (gen !== generation) return;
    const loaded = await resolveBundle({ bundle: opts.bundle, publicKey: opts.bundlePublicKey, debug: opts.debug });
    if (gen !== generation) return;
    const wasm = await loadWasm(opts.dev);
    if (gen !== generation) return;
    const handle = new wasm.Readmeter(
      configJson({
        hashKey,
        session,
        platform: opts.platform,
        dev: opts.dev,
        sampleRate: opts.sampleRate,
        evaluations: opts.dev ? ["local", "window"] : ["local"],
      }),
      loaded.bytes,
    );
    if (gen !== generation) {
      handle.free();
      return;
    }
    const written = client.attach(handle);
    transport?.noteEvents(written);
    void refreshBundle({
      endpoint: opts.endpoint,
      apiKey: opts.apiKey,
      etag: loaded.etag,
      publicKey: opts.bundlePublicKey,
    }).catch((error: unknown) => {
      debugOnce(opts.debug, error);
    });
  } catch (error) {
    fail(gen, error);
  } finally {
    // A newer init owns `previous` and flushes it. Only free it if this boot is still current.
    if (!released && gen === generation) previous.free();
  }
}

/**
 * Starts wasm loading and the flush timer. Never throws: bad config or a
 * failed load logs once and disables the SDK. Calls made before wasm is
 * ready are queued.
 */
export function init(options: InitOptions): void {
  unwatchPage();
  let opts: Validated;
  try {
    opts = validate(options);
  } catch (error) {
    generation += 1;
    disableRecording();
    const current = transport;
    transport = undefined;
    void current?.shutdown();
    ready = Promise.resolve();
    console.error(`[readmeter] ${errorMessage(error)}. The SDK is disabled.`);
    return;
  }

  const gen = ++generation;
  debug = opts.debug;
  const previousTransport = transport;
  transport = undefined;
  resetIds();
  const client = new CoreClient({ dev: opts.dev, debug: opts.debug, onFinding: opts.onFinding });
  const previous = handoff(client, () => transport?.noteEvent());
  const created = new Transport({
    endpoint: opts.endpoint,
    apiKey: opts.apiKey,
    flushIntervalMs: opts.flushIntervalMs,
    maxBatchEvents: opts.maxBatchEvents,
    takeBatch: () => {
      // Usage is recorded on a timer. A flush should not leave it behind.
      flushPendingUsage();
      return client.drain(Date.now());
    },
    debug: opts.debug,
  });
  transport = created;
  created.start();
  watchPage();
  const session = newSessionId();
  ready = boot(gen, opts, client, session, previous, previousTransport);
}

/** Sends what is buffered. Resolves even when the request fails. */
export async function flush(): Promise<void> {
  try {
    await ready;
    await transport?.flush({ reason: "user" });
  } catch (error) {
    debugOnce(debug, error);
  }
}

/** Flushes, then stops timers and exit hooks. */
export async function shutdown(): Promise<void> {
  unwatchPage();
  const pending = ready;
  const gen = generation;
  try {
    await pending;
  } catch (error) {
    debugOnce(debug, error);
  }
  if (generation !== gen) return;
  generation += 1;
  const current = transport;
  transport = undefined;
  try {
    await current?.shutdown();
  } catch (error) {
    debugOnce(debug, error);
  }
  const idle = new CoreClient();
  const previous = handoff(idle, () => {});
  previous.free();
  ready = Promise.resolve();
}

export { sink, sinkListener, sinkWrite };

