import { allowStackCallsites } from "./core/callsite.ts";
import { CoreClient, disableRecording, handoff, recordRaw } from "./core/client.ts";
import { detectPlatform } from "./core/env.ts";
import { debugOnce, errorMessage } from "./core/log.ts";
import { newSessionId, nextCallId, resetIds } from "./core/session.ts";
import type { Transport } from "./core/transport.ts";
import { flushPendingUsage } from "./core/usage.ts";
import type { Finding, InitOptions, Platform, WasmBuild, WriteOp } from "./types.ts";
import { sink, sinkListener, sinkWrite } from "./web/sink.ts";

export type { Finding, InitOptions, Platform, WasmBuild, WriteOp };

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
  wasmUrl?: InitOptions["wasmUrl"];
  routes: boolean;
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
/** Bumped by `unwatchPage`: a route watcher that loads after that is not installed. */
let watchToken = 0;
/** The lazy part of the SDK (core/open.ts), once loaded. */
let routes: typeof import("./core/open.ts") | undefined;
let lazy: Promise<typeof import("./core/open.ts")> | undefined;

/** Imports core/open.ts once. Pages load it with the wasm, not with the page. */
function loadLazy(): Promise<typeof import("./core/open.ts")> {
  lazy ??= import("./core/open.ts");
  return lazy;
}

function unwatchPage(): void {
  watchToken += 1;
  for (const { host, type, handler } of watches) {
    try {
      host.removeEventListener?.(type, handler);
    } catch (error) {
      debugOnce(debug, error);
    }
  }
  watches = [];
  try {
    routes?.unwatchRoutes();
  } catch (error) {
    debugOnce(debug, error);
  }
}

function on(host: EventHost | undefined, type: string, run: () => void): void {
  try {
    if (!host || typeof host.addEventListener !== "function") return;
    const handler = () => {
      try {
        run();
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

function listen(host: EventHost | undefined, type: string, record: () => Record<string, unknown>): void {
  on(host, type, () => recordRaw({ ts_ms: Date.now(), call_id: nextCallId(), ...record() }));
}

/**
 * Reports page visibility, route and connection changes. Firestore bills a
 * listener as a new query when it reconnects after 30+ minutes offline;
 * `freeze` counts as offline because a frozen tab stops network activity.
 * No-op where `document` / `window` do not exist (Node, Deno). Resolves once
 * the route watcher (loaded lazily, see web/routes.ts) is in place.
 */
async function watchPage(watchRoutes: boolean): Promise<void> {
  unwatchPage();
  const token = watchToken;
  let doc: PageHost | undefined;
  let win: (EventHost & { history?: unknown; location?: unknown }) | undefined;
  try {
    const g = globalThis as { document?: PageHost; window?: typeof win };
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
  if (!watchRoutes || !win) return;
  try {
    routes = await loadLazy();
    if (token === watchToken) routes.watchRoutes(win, on, debug);
  } catch (error) {
    debugOnce(debug, error);
  }
}

/** Base64 of 32 bytes. Checked by shape so the bundle code can load lazily. */
function isPublicKey(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9+/]{43}=?$/.test(value.trim());
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
  if (options.routes !== undefined && typeof options.routes !== "boolean") throw new Error("routes must be a boolean");
  if (options.onFinding !== undefined && typeof options.onFinding !== "function") throw new Error("onFinding must be a function");
  const wasmUrl = options.wasmUrl;
  if (
    wasmUrl !== undefined &&
    !(typeof wasmUrl === "string" && wasmUrl.length > 0) &&
    !(typeof URL !== "undefined" && wasmUrl instanceof URL) &&
    typeof wasmUrl !== "function"
  ) {
    throw new Error("wasmUrl must be a URL, a non-empty string, or a function");
  }

  const validated: Validated = {
    apiKey: options.apiKey,
    endpoint: options.endpoint.trim().replace(/\/+$/, ""),
    dev: options.dev ?? false,
    sampleRate: options.sampleRate ?? 1,
    flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    maxBatchEvents: options.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS,
    platform,
    debug: options.debug ?? false,
    routes: options.routes ?? true,
  };
  if (options.hashKey !== undefined) validated.hashKey = options.hashKey.toLowerCase();
  if (options.bundle !== undefined) validated.bundle = options.bundle;
  if (options.bundlePublicKey !== undefined) validated.bundlePublicKey = options.bundlePublicKey.trim();
  if (options.onFinding !== undefined) validated.onFinding = options.onFinding;
  if (wasmUrl !== undefined) validated.wasmUrl = wasmUrl;
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

/** The `wasmUrl` option as a string for this build, or undefined for the bundled module. */
function wasmHref(opts: Validated): string | undefined {
  const option = opts.wasmUrl;
  if (option === undefined) return undefined;
  const build: WasmBuild = opts.dev ? "dev" : "prod";
  const value = typeof option === "function" ? option(build) : option;
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof URL !== "undefined" && value instanceof URL) return value.href;
  throw new Error(`wasmUrl returned no URL for the ${build} build`);
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

    const { startCore, Transport } = await loadLazy();
    if (gen !== generation) return;
    const started = await startCore(
      {
        endpoint: opts.endpoint,
        apiKey: opts.apiKey,
        hashKey: opts.hashKey,
        bundle: opts.bundle,
        bundlePublicKey: opts.bundlePublicKey,
        debug: opts.debug,
        dev: opts.dev,
        wasmHref: wasmHref(opts),
        session,
        platform: opts.platform,
        sampleRate: opts.sampleRate,
      },
      () => gen === generation,
    );
    if (!started) return;
    const written = client.attach(started.handle);
    // Nothing can be sent before wasm encodes it, so timers and exit hooks start here.
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
    created.noteEvents(written);
    void started.refresh().catch((error: unknown) => {
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
  // Stack capture is too slow for production browsers. Build-plugin callsites still apply.
  allowStackCallsites(opts.dev || opts.platform === "server");
  // Starts the lazy chunk now; it also lets `sink` read Admin SDK targets.
  loadLazy().catch((error: unknown) => {
    debugOnce(opts.debug, error);
  });
  const previousTransport = transport;
  transport = undefined;
  resetIds();
  const client = new CoreClient({ dev: opts.dev, debug: opts.debug, onFinding: opts.onFinding });
  const previous = handoff(client, () => transport?.noteEvent());
  const watching = watchPage(opts.routes);
  const session = newSessionId();
  ready = Promise.all([boot(gen, opts, client, session, previous, previousTransport), watching]).then(() => undefined);
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
/** Component mount ids for UI bindings such as `@readmeter/react`. */
export { currentMount, newMountId, runInMount } from "./core/mount.ts";

