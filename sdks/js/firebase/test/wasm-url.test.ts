import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { flush, init, shutdown, type InitOptions } from "../src/index.ts";
import { HASH_KEY, bundleBytes } from "./bundle.ts";

const prodWasm = readFileSync(new URL("../wasm/prod/readmeter_wasm_bg.wasm", import.meta.url));

async function boot(options: Partial<InitOptions>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => {
    lines.push(String(message));
  };
  try {
    init({
      apiKey: "rm_dev_key",
      hashKey: HASH_KEY,
      endpoint: "http://127.0.0.1:9",
      bundle: bundleBytes(),
      flushIntervalMs: 60_000,
      platform: "server",
      ...options,
    });
    await flush();
    await shutdown();
  } finally {
    console.error = original;
  }
  return lines;
}

test("wasmUrl: streamed from http, chosen per build, and failures disable the SDK quietly", async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url?.split("?")[0] === "/core.wasm") {
      res.writeHead(200, { "content-type": "application/wasm" });
      res.end(prodWasm);
    } else if (req.url === "/octet.wasm") {
      // Wrong MIME type: compiled from the bytes instead of streamed.
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(prodWasm);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await boot({ wasmUrl: `${origin}/core.wasm` }), []);
    assert.deepEqual(await boot({ wasmUrl: new URL(`${origin}/octet.wasm`) }), []);
    const builds: string[] = [];
    assert.deepEqual(
      await boot({
        wasmUrl: (build) => {
          builds.push(build);
          return `${origin}/core.wasm?${build}`;
        },
      }),
      [],
    );
    assert.deepEqual(builds, ["prod"]);
    assert.deepEqual(requests, ["/core.wasm", "/octet.wasm", "/core.wasm?prod"]);

    const missing = await boot({ wasmUrl: `${origin}/missing.wasm` });
    assert.match(missing.join("\n"), /wasm fetch failed \(404\).*SDK is disabled/);
    const empty = await boot({ wasmUrl: () => "" });
    assert.match(empty.join("\n"), /wasmUrl returned no URL for the prod build/);
    const bad = await boot({ wasmUrl: 42 as unknown as string });
    assert.match(bad.join("\n"), /wasmUrl must be/);
  } finally {
    server.close();
  }
});

test("wasmUrl: file URLs are read from disk in Node", async () => {
  const lines = await boot({ wasmUrl: new URL("../wasm/prod/readmeter_wasm_bg.wasm", import.meta.url) });
  assert.deepEqual(lines, []);
});
