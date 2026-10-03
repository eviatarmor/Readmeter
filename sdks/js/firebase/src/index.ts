import {
  bundleEtag,
  loadCachedBundle,
  loadPackagedBundle,
  refreshBundle,
} from "./core/bundle.ts";
import { allowStackCallsites } from "./core/callsite.ts";
import { CoreClient, configJson, disableRecording, handoff, recordRaw } from "./core/client.ts";
import { detectPlatform } from "./core/env.ts";
import { debugOnce, errorMessage } from "./core/log.ts";
import { newSessionId, nextCallId, resetIds } from "./core/session.ts";
import { Transport } from "./core/transport.ts";
import { flushPendingUsage } from "./core/usage.ts";
import { loadWasm } from "./core/wasm.ts";
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

interface WindowHost extends EventHost {
  history?: unknown;
  location?: unknown;
}

/** Host listeners added by `watchPage`, removed together by `unwatchPage`. */
let watches: Watch[] = [];

/** One `history` method replaced by `watchRoutes`. */
interface HistoryPatch {
  host: Record<string, unknown>;
  name: string;
  original: unknown;
  wrapper: unknown;
}

/** Patches installed by the current `watchRoutes`. */
let patches: HistoryPatch[] = [];
/**
 * Patches that could not be undone because something wrapped `history` on
 * top of ours. They stay in the chain, inert until the next `watchRoutes`,
 * which reuses them instead of wrapping twice.
 */
let stranded: HistoryPatch[] = [];
/** Called by patched `history` methods. Unset when routes are not watched. */
let routeChanged: (() => void) | undefined;

function unwatchPage(): void {
  for (const { host, type, handler } of watches) {
    try {
      host.removeEventListener?.(type, handler);
    } catch (error) {
      debugOnce(debug, error);
    }
  }
  watches = [];
  routeChanged = undefined;
  for (const patch of patches) {
    try {
      if (patch.host[patch.name] === patch.wrapper) patch.host[patch.name] = patch.original;
      else stranded.push(patch);
    } catch (error) {
      stranded.push(patch);
      debugOnce(debug, error);
    }
  }
  patches = [];
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
 * The current route: `location.pathname`, or the hash path for hash routers
 * (`#/users/1`, `#!/users/1`). Query string and fragment are cut here, and
 * the core templates what is left before anything leaves the process.
 */
function routeOf(location: unknown): string | undefined {
  if (!location || typeof location !== "object") return undefined;
  const { pathname, hash } = location as { pathname?: unknown; hash?: unknown };
  let route: string | undefined;
  if (typeof hash === "string" && (hash.startsWith("#/") || hash.startsWith("#!/"))) {
    route = hash.slice(hash.indexOf("/"));
  } else if (typeof pathname === "string") {
    route = pathname;
  }
  if (route === undefined) return undefined;
  const cut = route.search(/[?#]/);
  return cut >= 0 ? route.slice(0, cut) : route;
}

function patchHistory(history: Record<string, unknown>, name: string): void {
  const original = history[name];
  if (typeof original !== "function") return;
  if (stranded.some((patch) => patch.host === history && patch.name === name)) return;
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    const result = (original as (...a: unknown[]) => unknown).apply(this, args);
    try {
      routeChanged?.();
    } catch (error) {
      debugOnce(debug, error);
    }
    return result;
  };
  history[name] = wrapper;
  patches.push({ host: history, name, original, wrapper });
}

/**
 * Reports SPA route changes as `navigate` page events: `pushState` and
 * `replaceState` are wrapped (undone by `shutdown`/re-`init`), `popstate`
 * and `hashchange` are listened to. Only a change of route is reported, so
 * `replaceState` with the same path (scroll restoration) records nothing.
 */
function watchRoutes(win: WindowHost | undefined): void {
  if (!win) return;
  const location = (): unknown => win.location ?? (globalThis as { location?: unknown }).location;
  let last = routeOf(location());
  routeChanged = () => {
    const route = routeOf(location());
    if (route === undefined || route === last) return;
    last = route;
    recordRaw({ op: "navigate", ts_ms: Date.now(), call_id: nextCallId(), route });
  };
  const history = win.history ?? (globalThis as { history?: unknown }).history;
  if (history && typeof history === "object") {
    patchHistory(history as Record<string, unknown>, "pushState");
    patchHistory(history as Record<string, unknown>, "replaceState");
  }
  on(win, "popstate", () => routeChanged?.());
  on(win, "hashchange", () => routeChanged?.());
}

/**
 * Reports page visibility, route and connection changes. Firestore bills a
 * listener as a new query when it reconnects after 30+ minutes offline;
 * `freeze` counts as offline because a frozen tab stops network activity.
 * No-op where `document` / `window` do not exist (Node, Deno).
 */
function watchPage(routes: boolean): void {
  unwatchPage();
  let doc: PageHost | undefined;
  let win: WindowHost | undefined;
  try {
    const g = globalThis as { document?: PageHost; window?: WindowHost };
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
  if (!routes) return;
  try {
    watchRoutes(win);
  } catch (error) {
    debugOnce(debug, error);
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

async function resolveBundle(opts: Validated): Promise<{ bytes: Uint8Array; etag: string }> {
  if (opts.bundle) return { bytes: opts.bundle, etag: await bundleEtag(opts.bundle) };
  const cached = await loadCachedBundle();
  if (cached) return cached;
  const packaged = await loadPackagedBundle();
  if (!packaged) throw new Error("rule bundle missing; build the package or pass init({ bundle })");
  return { bytes: packaged, etag: await bundleEtag(packaged) };
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
    const loaded = await resolveBundle(opts);
    if (gen !== generation) return;
    const wasm = await loadWasm(opts.dev, undefined, wasmHref(opts));
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
    void refreshBundle({ endpoint: opts.endpoint, apiKey: opts.apiKey, etag: loaded.etag }).catch((error: unknown) => {
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
  watchPage(opts.routes);
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
/** Component mount ids for UI bindings such as `@readmeter/react`. */
export { currentMount, newMountId, runInMount } from "./core/mount.ts";

