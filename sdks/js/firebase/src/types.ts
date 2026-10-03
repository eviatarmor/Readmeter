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
  /** Default: `window` + `document` means browser, otherwise server. */
  platform?: Platform;
  /** Called for every local finding, including while `dev` is off. */
  onFinding?: (finding: Finding) => void;
  /** Log raw calls, and rate-limit SDK errors, to `console.debug`. */
  debug?: boolean;
  /**
   * Report client-side route changes (`history.pushState`/`replaceState`,
   * `popstate`, `hashchange`) as page events. Only a route template leaves
   * the process: query string and fragment are dropped and segments that are
   * not short lowercase words become `{id}`. Default true. Set false when
   * your paths carry names or slugs you do not want reported.
   */
  routes?: boolean;
}
