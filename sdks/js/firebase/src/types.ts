/** Where the SDK is running. Omitted at init means "detect". */
export type Platform = "browser" | "server" | "mobile";

/** A local finding, the same fields the wasm `record` call returns. */
export interface Finding {
  rule: string;
  severity: string;
  template: string;
  message: string;
  wasted: Record<string, number>;
}

export type WriteOp = "set" | "update" | "create" | "delete";

export interface InitOptions {
  /** Ingest API key, sent as `Authorization: Bearer`. */
  apiKey: string;
  /**
   * 32 hex chars. When omitted, fetched once from `GET {endpoint}/v1/config`.
   * The key never leaves the process; the core uses it only to hash ids.
   */
  hashKey?: string;
  /** Ingest origin, for example `http://127.0.0.1:8090`. No trailing path. */
  endpoint: string;
  /** Dev wasm (window rules in-process) and `console.warn` for each finding. */
  dev?: boolean;
  /** Fraction of sessions uploaded, `0..1`. Default 1. */
  sampleRate?: number;
  /** Timer between flushes. Default 10000. */
  flushIntervalMs?: number;
  /** Flush early after this many recorded calls. Default 200. */
  maxBatchEvents?: number;
  /**
   * Rule bundle (`bundle.bin`) for this start. Otherwise the packaged
   * bundle, or the bundle cached from the previous `GET /v1/bundle`.
   */
  bundle?: Uint8Array;
  /**
   * Ed25519 public key (base64, raw 32 bytes) that signs this ingest's
   * bundles (`READMETER_BUNDLE_SIGNING_KEY`). When set, a fetched or cached
   * bundle is used only if its signature verifies; otherwise the packaged
   * bundle is kept. Needs Ed25519 in WebCrypto (Node 22+, current browsers).
   */
  bundlePublicKey?: string;
  /** Default: `window` + `document` means browser, otherwise server. */
  platform?: Platform;
  /** Called for every local finding, including while `dev` is off. */
  onFinding?: (finding: Finding) => void;
  /** Log raw calls, and rate-limit SDK errors, to `console.debug`. */
  debug?: boolean;
  /**
   * Where to fetch the `.wasm` core from instead of the base64 chunk bundled
   * into JavaScript. A function gets the build `dev` selects, so prod and dev
   * can point at their own file (`wasm/prod/readmeter_wasm_bg.wasm` or
   * `wasm/dev/readmeter_wasm_bg.wasm` in the package). The file must match
   * the build. A failed fetch disables the SDK like any other load failure.
   */
  wasmUrl?: string | URL | ((build: WasmBuild) => string | URL);
  /**
   * Report client-side route changes (`history.pushState`/`replaceState`,
   * `popstate`, `hashchange`) as page events. Only a route template leaves
   * the process: query string and fragment are dropped and segments that are
   * not short lowercase words become `{id}`. Default true. Set false when
   * your paths carry names or slugs you do not want reported.
   */
  routes?: boolean;
}

/** Which wasm core `init` loads: `dev` when `init({ dev: true })`. */
export type WasmBuild = "prod" | "dev";
