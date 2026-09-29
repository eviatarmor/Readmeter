// Loads the Rust core (decode + window rules) built by
// scripts/build-wasm-server.sh into ../wasm.
import { readFileSync } from "node:fs";

import type { Ingested } from "./types.ts";

export interface Core {
  /** Throws {@link CoreError} for batches that must be rejected. */
  ingest(project: string, body: Uint8Array): Ingested;
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

export async function loadCore(options: CoreOptions): Promise<Core> {
  const pkg = new URL("../wasm/", import.meta.url);
  const mod = await import(new URL("readmeter_wasm_server.js", pkg).href).catch(() => {
    throw new Error("Rust core not built: run `pnpm --filter @readmeter/ingest build:core`");
  });
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
  };
}
