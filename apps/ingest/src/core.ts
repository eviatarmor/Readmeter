// Loads the Rust core (decode + window and aggregate rules) built by
// scripts/build-wasm-server.sh into ../wasm.
import { readFileSync } from "node:fs";

import type { Ingested } from "./types.ts";

export interface Core {
  /** Throws {@link CoreError} for batches that must be rejected. */
  ingest(project: string, body: Uint8Array): Ingested;
  /**
   * Applies project rule overrides to an SDK bundle. An empty override map
   * must not be passed: re-encoding is not byte-identical.
   */
  applyOverrides(bundle: Uint8Array, overridesJson: string): Uint8Array;
}

export type CoreErrorCode = "bad_batch" | "batch_too_large" | "internal";

export class CoreError extends Error {
  constructor(
    readonly code: CoreErrorCode,
    detail: string,
  ) {
    super(detail);
  }
}

export interface CoreOptions {
  bundleJson: string;
  maxEvents: number;
  maxFindings: number;
}

const CODES = new Set<CoreErrorCode>(["bad_batch", "batch_too_large", "internal"]);

/** The wasm side reports errors as `"<code>: <detail>"`. */
function toCoreError(e: unknown): CoreError {
  const message = e instanceof Error ? e.message : String(e);
  const sep = message.indexOf(": ");
  const code = sep > 0 ? message.slice(0, sep) : "";
  return CODES.has(code as CoreErrorCode)
    ? new CoreError(code as CoreErrorCode, message.slice(sep + 2))
    : new CoreError("internal", message);
}

interface WasmServer {
  initSync(options: { module: Buffer }): void;
  Evaluator: new (
    bundleJson: string,
    maxEvents: number,
    maxFindings: number,
  ) => { ingest(project: string, body: Uint8Array): string };
  bundle_with_overrides(bundle: Uint8Array, overridesJson: string): Uint8Array;
}

export async function loadCore(options: CoreOptions): Promise<Core> {
  const pkg = new URL("../wasm/", import.meta.url);
  const mod = (await import(new URL("readmeter_wasm_server.js", pkg).href).catch(() => {
    throw new Error("Rust core not built: run `pnpm --filter @readmeter/ingest build:core`");
  })) as WasmServer;
  mod.initSync({ module: readFileSync(new URL("readmeter_wasm_server_bg.wasm", pkg)) });
  const evaluator = new mod.Evaluator(options.bundleJson, options.maxEvents, options.maxFindings);
  return {
    ingest(project, body) {
      let json: string;
      try {
        json = evaluator.ingest(project, body);
      } catch (e) {
        throw toCoreError(e);
      }
      return JSON.parse(json) as Ingested;
    },
    applyOverrides(bundle, overridesJson) {
      const out = mod.bundle_with_overrides(bundle, overridesJson);
      return out instanceof Uint8Array ? out : new Uint8Array(out);
    },
  };
}
