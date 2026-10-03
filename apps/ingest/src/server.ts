// `@readmeter/ingest` server.
//
// Environment:
// - `DATABASE_URL` (default: local docker-compose Postgres on 5442)
// - `READMETER_BUNDLE`: path to bundle.json from `readmeter-rulec build`
//   (default `target/rules/bundle.json` relative to the repo root)
// - `READMETER_SDK_BUNDLE`: path to bundle.bin served at `GET /v1/bundle`
//   (default `target/rules/bundle.bin` relative to the repo root)
// - `READMETER_BUNDLE_SIGNING_KEY`: Ed25519 private key (base64 32-byte seed
//   or PKCS#8 PEM). When set, `GET /v1/bundle` responses carry an
//   `x-readmeter-signature` header. Generate one with `src/bundle-key.ts keygen`.
// - `READMETER_RATE_PER_MIN`: accepted batches per minute per API key (default 600, burst 100)
// - `PORT` (default 8090)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { connect } from "@readmeter/db";

import { bundleEtag, createApp } from "./app.ts";
import { loadCore } from "./core.ts";
import { loadSigner } from "./signing.ts";
import { PgStore } from "./store.ts";

const log = (msg: string, fields: Record<string, unknown> = {}) =>
  console.error(JSON.stringify({ ts: new Date().toISOString(), msg, ...fields }));

const bundlePath =
  process.env.READMETER_BUNDLE ??
  fileURLToPath(new URL("../../../target/rules/bundle.json", import.meta.url));
const sdkBundlePath =
  process.env.READMETER_SDK_BUNDLE ??
  fileURLToPath(new URL("../../../target/rules/bundle.bin", import.meta.url));
const port = Number(process.env.PORT ?? 8090);
const ratePerMin = Number(process.env.READMETER_RATE_PER_MIN ?? 600);
if (!Number.isFinite(ratePerMin) || ratePerMin <= 0) {
  throw new Error("READMETER_RATE_PER_MIN must be a positive number");
}

// One evaluator for every project. Aggregate state lives in this process
// and is dropped on restart; see crates/evaluator.
const core = await loadCore({
  bundleJson: readFileSync(bundlePath, "utf8"),
  maxEvents: 10_000,
  maxFindings: 1_000,
});
let sdkBundleBytes: Buffer;
try {
  sdkBundleBytes = readFileSync(sdkBundlePath);
} catch (e) {
  throw new Error(`SDK bundle not found at ${sdkBundlePath} (READMETER_SDK_BUNDLE): ${String(e)}`);
}
const sdkBundle = new Uint8Array(sdkBundleBytes);
const signingKey = process.env.READMETER_BUNDLE_SIGNING_KEY?.trim();
let signer;
try {
  signer = signingKey ? loadSigner(signingKey) : undefined;
} catch (e) {
  throw new Error(`READMETER_BUNDLE_SIGNING_KEY is invalid: ${e instanceof Error ? e.message : String(e)}`);
}
if (signer) log("bundle signing on", { key_id: signer.keyId, public_key: signer.publicKey });
const { db, close } = connect();
const app = createApp({
  core,
  store: new PgStore(db),
  limits: { ratePerMin },
  bundle: { body: sdkBundle, etag: bundleEtag(sdkBundle) },
  signer,
  log,
});

const server = serve({ fetch: app.fetch, port }, (info) => log("listening", { port: info.port }));

const shutdown = () => {
  server.close(async () => {
    await close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
