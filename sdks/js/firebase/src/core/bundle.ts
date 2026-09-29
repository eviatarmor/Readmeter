import { isNode } from "./env.ts";

const LS_BYTES = "readmeter.bundle.v1";
const LS_ETAG = "readmeter.bundle.etag";

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

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function nodeCachePaths(): Promise<{ dir: string; bin: string; etag: string } | undefined> {
  if (!isNode()) return undefined;
  const path = await importSpecifier<typeof import("node:path")>("node:path");
  const os = await importSpecifier<typeof import("node:os")>("node:os");
  const dir = process.env.READMETER_BUNDLE_CACHE ?? path.join(os.homedir(), ".readmeter", "cache");
  return { dir, bin: path.join(dir, "bundle.bin"), etag: path.join(dir, "etag.txt") };
}

function browserCache(): CachedBundle | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    const etag = localStorage.getItem(LS_ETAG);
    const raw = localStorage.getItem(LS_BYTES);
    if (!etag || !raw) return undefined;
    return { bytes: base64ToBytes(raw), etag };
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
      if (bytes.byteLength > 0 && etag) return { bytes, etag };
    } catch {
      // no cache yet
    }
  }
  return browserCache();
}

export async function saveCachedBundle(bytes: Uint8Array, etag: string): Promise<void> {
  const paths = await nodeCachePaths();
  if (paths) {
    const fs = await importSpecifier<typeof import("node:fs")>("node:fs");
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.bin, bytes);
    fs.writeFileSync(paths.etag, etag);
  }
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LS_BYTES, bytesToBase64(bytes));
      localStorage.setItem(LS_ETAG, etag);
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

export function bundleUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/v1/bundle`;
}

/**
 * Background refresh. A 200 is stored for the next start; this process keeps
 * the bundle it already loaded. Failures are the caller's to ignore.
 */
export async function refreshBundle(opts: {
  endpoint: string;
  apiKey: string;
  etag: string;
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
  const etag = header && header.length > 0 ? header : await bundleEtag(bytes);
  await saveCachedBundle(bytes, etag);
}
