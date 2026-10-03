// `@readmeter/ingest` server.
//
// Environment:
// - `DATABASE_URL` (default: local docker-compose Postgres on 5442)
// - `READMETER_BUNDLE`: path to bundle.json from `readmeter-rulec build`
//   (default `target/rules/bundle.json` relative to the repo root)
// - `READMETER_SDK_BUNDLE`: path to bundle.bin served at `GET /v1/bundle`
//   (default `target/rules/bundle.bin` relative to the repo root)
// - `READMETER_RATE_PER_MIN`: accepted batches per minute per project, for projects
//   without their own `rate_per_min` (default 600). Burst is ceil(rate / 6), at least 1.
// - `READMETER_RATE_PER_IP_PER_MIN`: batches per minute per client IP for browser
//   requests, those with an `Origin` header (default 120, 0 disables)
// - `READMETER_TRUST_PROXY`: `1` takes the client IP from the last `X-Forwarded-For`
//   entry instead of the socket address
// - `PORT` (default 8090)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { connect } from "@readmeter/db";

import { bundleEtag, createApp, DEFAULT_LIMITS } from "./app.ts";
import { loadCore } from "./core.ts";
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
const ratePerIpPerMin = Number(process.env.READMETER_RATE_PER_IP_PER_MIN ?? DEFAULT_LIMITS.ratePerIpPerMin);
if (!Number.isFinite(ratePerIpPerMin) || ratePerIpPerMin < 0) {
  throw new Error("READMETER_RATE_PER_IP_PER_MIN must be 0 (off) or a positive number");
}
const trustProxy = process.env.READMETER_TRUST_PROXY === "1";

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
const { db, close } = connect();
const app = createApp({
  core,
  store: new PgStore(db),
  limits: {
    ratePerMin,
    rateBurst: Math.max(1, Math.ceil(ratePerMin / 6)),
    ratePerIpPerMin,
    trustProxy,
  },
  bundle: { body: sdkBundle, etag: bundleEtag(sdkBundle) },
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
