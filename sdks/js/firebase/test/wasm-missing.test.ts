import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { flush, init, shutdown } from "../src/index.ts";
import { HASH_KEY } from "./bundle.ts";

test("missing wasm disables the SDK without throwing", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => {
    lines.push(String(message));
  };
  process.env.READMETER_WASM_DIR = fileURLToPath(new URL("./missing-wasm/", import.meta.url));
  try {
    init({
      apiKey: "rm_dev_key",
      hashKey: HASH_KEY,
      endpoint: "http://127.0.0.1:9",
      flushIntervalMs: 60_000,
      platform: "server",
    });
    await flush();
    await shutdown();
    assert.match(lines.join("\n"), /wasm/i);
  } finally {
    console.error = original;
    delete process.env.READMETER_WASM_DIR;
  }
});
