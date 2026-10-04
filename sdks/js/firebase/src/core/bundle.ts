import { isNode } from "./env.ts";
import { debugOnce } from "./log.ts";

const LS_BYTES = "readmeter.bundle.v1";
const LS_ETAG = "readmeter.bundle.etag";
const LS_SIG = "readmeter.bundle.sig";
/** Response header ingest signs bundles with: `ed25519:<base64>`. */
const SIGNATURE_HEADER = "x-readmeter-signature";

/**
 * Node-only module load. A literal `import("node:fs")` is a bundler warning:
 * Vite externalizes the builtin and tells the browser build it cannot be resolved.
 */
function importSpecifier<T>(specifier: string): Promise<T> {
  const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<T>;
  return load(specifier);
}

export interface CachedBundle {
  bytes: Uint8Array;
  etag: string;
  /** `x-readmeter-signature` value served with these bytes, if any. */
  signature?: string;
}

/** First 16 hex chars of SHA-256, the same etag ingest sends. */
export async function bundleEtag(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex.slice(0, 16);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function nodeCachePaths(): Promise<{ dir: string; bin: string; etag: string; sig: string } | undefined> {
  if (!isNode()) return undefined;
  const path = await importSpecifier<typeof import("node:path")>("node:path");
  const os = await importSpecifier<typeof import("node:os")>("node:os");
  const dir = process.env.READMETER_BUNDLE_CACHE ?? path.join(os.homedir(), ".readmeter", "cache");
  return {
    dir,
    bin: path.join(dir, "bundle.bin"),
    etag: path.join(dir, "etag.txt"),
    sig: path.join(dir, "signature.txt"),
  };
}

function browserCache(): CachedBundle | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    const etag = localStorage.getItem(LS_ETAG);
    const raw = localStorage.getItem(LS_BYTES);
    if (!etag || !raw) return undefined;
    const signature = localStorage.getItem(LS_SIG);
    return signature ? { bytes: base64ToBytes(raw), etag, signature } : { bytes: base64ToBytes(raw), etag };
  } catch {
    return undefined;
  }
}

/** Bundle saved from the previous `GET /v1/bundle`, if any. */
export async function loadCachedBundle(): Promise<CachedBundle | undefined> {
  const paths = await nodeCachePaths();
  if (paths) {
    try {
      const fs = await importSpecifier<typeof import("node:fs")>("node:fs");
      const bytes = new Uint8Array(fs.readFileSync(paths.bin));
      const etag = fs.readFileSync(paths.etag, "utf8").trim();
      let signature = "";
      try {
        signature = fs.readFileSync(paths.sig, "utf8").trim();
      } catch {
        // cached before signing was on
      }
      if (bytes.byteLength > 0 && etag) return signature ? { bytes, etag, signature } : { bytes, etag };
    } catch {
      // no cache yet
    }
  }
  return browserCache();
}

export async function saveCachedBundle(bytes: Uint8Array, etag: string, signature?: string): Promise<void> {
  const paths = await nodeCachePaths();
  if (paths) {
    const fs = await importSpecifier<typeof import("node:fs")>("node:fs");
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.bin, bytes);
    fs.writeFileSync(paths.etag, etag);
    if (signature) fs.writeFileSync(paths.sig, signature);
    else fs.rmSync(paths.sig, { force: true });
  }
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LS_BYTES, bytesToBase64(bytes));
      localStorage.setItem(LS_ETAG, etag);
      if (signature) localStorage.setItem(LS_SIG, signature);
      else localStorage.removeItem(LS_SIG);
    }
  } catch {
    // private mode or quota; the packaged bundle still works
  }
}

/** `bundle/bundle.bin` shipped with the package. Node reads it; the browser fetches it. */
export async function loadPackagedBundle(): Promise<Uint8Array | undefined> {
  const url = new URL("../../bundle/bundle.bin", import.meta.url);
  try {
    if (isNode()) {
      const fs = await importSpecifier<typeof import("node:fs")>("node:fs");
      return new Uint8Array(fs.readFileSync(url));
    }
    const res = await fetch(url);
    if (!res.ok) return undefined;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return undefined;
  }
}

/**
 * True when `signature` (`ed25519:<base64>`) is a valid Ed25519 signature of
 * `bytes` under `publicKey` (base64, raw 32 bytes). False on any failure,
 * including a runtime without Ed25519 in WebCrypto.
 */
export async function verifyBundle(bytes: Uint8Array, signature: string | undefined, publicKey: string): Promise<boolean> {
  try {
    if (!signature?.startsWith("ed25519:")) return false;
    const key = await crypto.subtle.importKey("raw", new Uint8Array(base64ToBytes(publicKey)), { name: "Ed25519" }, false, [
      "verify",
    ]);
    const sig = new Uint8Array(base64ToBytes(signature.slice(8).trim()));
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, new Uint8Array(bytes));
  } catch {
    return false;
  }
}

/**
 * Bundle for this start, in order: `init({ bundle })`, the cached
 * `GET /v1/bundle` response, the packaged default. With a public key, a
 * cached bundle whose signature does not verify is skipped.
 */
export async function resolveBundle(opts: {
  bundle?: Uint8Array;
  publicKey?: string;
  debug?: boolean;
}): Promise<{ bytes: Uint8Array; etag: string }> {
  if (opts.bundle) return { bytes: opts.bundle, etag: await bundleEtag(opts.bundle) };
  const cached = await loadCachedBundle();
  if (cached) {
    if (!opts.publicKey || (await verifyBundle(cached.bytes, cached.signature, opts.publicKey))) {
      return { bytes: cached.bytes, etag: cached.etag };
    }
    debugOnce(opts.debug ?? false, "cached rule bundle signature missing or invalid; using the packaged bundle");
  }
  const packaged = await loadPackagedBundle();
  if (!packaged) throw new Error("rule bundle missing; build the package or pass init({ bundle })");
  return { bytes: packaged, etag: await bundleEtag(packaged) };
}

export function bundleUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/v1/bundle`;
}

/**
 * Background refresh. A 200 is stored for the next start; this process keeps
 * the bundle it already loaded. With `publicKey`, a response whose signature
 * does not verify is not stored. Failures are the caller's to ignore.
 */
export async function refreshBundle(opts: {
  endpoint: string;
  apiKey: string;
  etag: string;
  publicKey?: string;
  fetchFn?: typeof fetch;
}): Promise<void> {
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(bundleUrl(opts.endpoint), {
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "if-none-match": opts.etag,
    },
  });
  if (res.status === 304) return;
  if (!res.ok) throw new Error(`GET /v1/bundle failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) return;
  const header = res.headers.get("etag")?.replace(/^W\//i, "").replace(/"/g, "").trim();
  const signature = res.headers.get(SIGNATURE_HEADER)?.trim() || undefined;
  if (opts.publicKey && !(await verifyBundle(bytes, signature, opts.publicKey))) {
    throw new Error("GET /v1/bundle signature missing or invalid; keeping the current bundle");
  }
  const etag = header && header.length > 0 ? header : await bundleEtag(bytes);
  await saveCachedBundle(bytes, etag, signature);
}
