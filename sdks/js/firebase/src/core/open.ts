/**
 * Everything `init` can start late: hash key fetch, bundle resolution and
 * signature checks, wasm loading, the transport, the route watcher, and
 * Admin SDK target reading for `sink`. `init` imports this module
 * dynamically, so a page loads it alongside the wasm instead of in the
 * eager JS glue. One module, so bundlers emit one lazy chunk.
 */
import "../admin/shape.ts";
import { refreshBundle, resolveBundle } from "./bundle.ts";
import { CoreClient } from "./client.ts";
import { detectPlatform } from "./env.ts";
import { loadWasm, type WasmHandle } from "./wasm.ts";
export { Transport } from "./transport.ts";
export { unwatchRoutes, watchRoutes } from "../web/routes.ts";
import { SDK_NAME, SDK_VERSION } from "../version.ts";
import type { Finding, Platform } from "../types.ts";

export interface OpenCoreOptions {
  hashKey: string;
  bundle: Uint8Array;
  session?: string;
  platform?: Platform;
  dev?: boolean;
  debug?: boolean;
  sampleRate?: number;
  /** Passed through to the core. Window rules need the dev wasm build. */
  evaluations?: string[];
  onFinding?: (finding: Finding) => void;
  wasmDir?: URL;
}

interface ConfigInput {
  hashKey: string;
  session: string;
  platform: Platform;
  dev: boolean;
  sampleRate: number;
  evaluations: string[];
}

export function configJson(input: ConfigInput): string {
  return JSON.stringify({
    provider: "firebase",
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    session: input.session,
    hash_key: input.hashKey.toLowerCase(),
    platform: input.platform,
    dev: input.dev,
    sample_rate: input.sampleRate,
    evaluations: input.evaluations,
  });
}

/** Wasm client for tests and the conformance runner. Does not touch the singleton. */
export async function openCore(opts: OpenCoreOptions): Promise<CoreClient> {
  const evaluations = opts.evaluations ?? (opts.dev === true ? ["local", "window"] : ["local"]);
  const devWasm = opts.dev === true || evaluations.includes("window");
  const wasm = await loadWasm(devWasm, opts.wasmDir);
  const client = new CoreClient({ dev: opts.dev === true, debug: opts.debug, onFinding: opts.onFinding });
  const handle = new wasm.Readmeter(
    configJson({
      hashKey: opts.hashKey,
      session: opts.session ?? "1",
      platform: opts.platform ?? detectPlatform(),
      dev: opts.dev === true,
      sampleRate: opts.sampleRate ?? 1,
      evaluations,
    }),
    opts.bundle,
  );
  client.attach(handle);
  return client;
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

export interface StartOptions {
  endpoint: string;
  apiKey: string;
  hashKey?: string;
  bundle?: Uint8Array;
  bundlePublicKey?: string;
  debug: boolean;
  dev: boolean;
  /** `wasmUrl` resolved for this build, or undefined for the bundled module. */
  wasmHref?: string;
  session: string;
  platform: Platform;
  sampleRate: number;
}

export interface Started {
  handle: WasmHandle;
  /** Fetches a newer rule bundle for the next session. */
  refresh(): Promise<void>;
}

/**
 * Hash key, rule bundle, then wasm, in that order. Returns undefined, with
 * nothing left allocated, once `current()` turns false (a newer `init`).
 */
export async function startCore(opts: StartOptions, current: () => boolean): Promise<Started | undefined> {
  const hashKey = opts.hashKey ?? (await fetchHashKey(opts.endpoint, opts.apiKey));
  if (!current()) return undefined;
  const loaded = await resolveBundle({ bundle: opts.bundle, publicKey: opts.bundlePublicKey, debug: opts.debug });
  if (!current()) return undefined;
  const wasm = await loadWasm(opts.dev, undefined, opts.wasmHref);
  if (!current()) return undefined;
  const handle = new wasm.Readmeter(
    configJson({
      hashKey,
      session: opts.session,
      platform: opts.platform,
      dev: opts.dev,
      sampleRate: opts.sampleRate,
      evaluations: opts.dev ? ["local", "window"] : ["local"],
    }),
    loaded.bytes,
  );
  if (!current()) {
    handle.free();
    return undefined;
  }
  return {
    handle,
    refresh: () =>
      refreshBundle({
        endpoint: opts.endpoint,
        apiKey: opts.apiKey,
        etag: loaded.etag,
        publicKey: opts.bundlePublicKey,
      }),
  };
}
