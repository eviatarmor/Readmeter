// Test helpers: real batches from the SDK wasm (scripts/build-wasm.sh output)
// and the real server core (scripts/build-wasm-server.sh output).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadCore, type CoreOptions } from "../src/core.ts";
import type { ProjectAccess, StoredOverride, Store } from "../src/store.ts";
import type { Ingested } from "../src/types.ts";

const root = new URL("../../../", import.meta.url);
export const bundleJson = readFileSync(new URL("target/rules/bundle.json", root), "utf8");
const bundleBin = readFileSync(new URL("target/rules/bundle.bin", root));

export function core(options: Partial<CoreOptions> = {}) {
  return loadCore({ bundleJson, maxEvents: 10_000, maxFindings: 1_000, ...options });
}

type Sdk = {
  initSync(o: { module: Buffer }): void;
  Readmeter: new (config: string, bundle: Uint8Array) => {
    record(raw: string): string;
    flush(now: number): Uint8Array | undefined;
  };
};

const sdkDir = new URL("target/wasm-pkg/", root);
const sdk = (await import(new URL("readmeter_wasm.js", sdkDir).href)) as Sdk;
sdk.initSync({ module: readFileSync(fileURLToPath(new URL("readmeter_wasm_bg.wasm", sdkDir))) });

/** Encoded batch from the production SDK build, one raw call per entry. */
export function batch(calls: object[], session = "7"): Uint8Array<ArrayBuffer> {
  const rm = new sdk.Readmeter(
    JSON.stringify({
      provider: "firebase",
      sdk: { name: "test", version: "0" },
      session,
      hash_key: "000102030405060708090a0b0c0d0e0f",
    }),
    bundleBin,
  );
  for (const call of calls) rm.record(JSON.stringify(call));
  const bytes = rm.flush(Date.now());
  if (!bytes) throw new Error("empty batch");
  return new Uint8Array(bytes);
}

export const offsetQuery = (ts_ms: number) => ({
  service: "firestore",
  op: "query",
  ts_ms,
  path: "posts",
  query: { offset: 100, limit: 10 },
  result: { docs: 10 },
});

export const growingPages = [20, 40, 60].map((limit, i) => ({
  service: "firestore",
  op: "query",
  ts_ms: 1_000 * i,
  path: "feed",
  query: { order_by: [{ field: "ts" }], limit },
  result: { docs: limit },
}));

export const HASH_KEY = "000102030405060708090a0b0c0d0e0f";

export function access(projectId: string, allowedOrigins: string[] = [], hashKey = HASH_KEY): ProjectAccess {
  return { projectId, allowedOrigins, hashKey };
}

export class MemoryStore implements Store {
  readonly writes: { project: string; ingested: Ingested }[] = [];
  overrides: StoredOverride[] = [];
  constructor(
    private readonly keys: Record<string, ProjectAccess>,
    private readonly delay?: Promise<void>,
  ) {}
  async projectForKey(key: string) {
    return this.keys[key] ?? null;
  }
  async write(project: string, _at: Date, ingested: Ingested) {
    await this.delay;
    this.writes.push({ project, ingested });
  }
  async ruleOverrides() {
    return this.overrides;
  }
}
