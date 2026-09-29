// HTTP ingest for SDK batches.
//
// `POST /v1/batches` with `Authorization: Bearer <api key>` and the bytes
// from the SDK core's `flush()` as the body. The handler authenticates,
// hands the body to the Rust core (decode, limits, window rules) and stores
// the result in Postgres before answering 202, so an accepted batch is a
// stored batch. When too many writes are in flight it answers 503 with
// `Retry-After`; SDKs keep the batch buffered and retry.
//
// Browser SDKs also call `GET /v1/config` (hash key) and `GET /v1/bundle`
// (rule bundle). `sendBeacon` may post `application/octet-stream` or omit
// the content type; the body is raw bytes either way.
import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";

import { CoreError, type Core } from "./core.ts";
import { TokenBucket } from "./rate.ts";
import type { ProjectAccess, Store } from "./store.ts";

export interface Limits {
  maxBodyBytes: number;
  maxInflight: number;
  /** Accepted batches per minute per API key. */
  ratePerMin: number;
  /** Token bucket capacity (burst). */
  rateBurst: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxBodyBytes: 1 << 20,
  maxInflight: 64,
  ratePerMin: 600,
  rateBurst: 100,
};

/** SDK rule bundle served at `GET /v1/bundle`. Hashed once at startup. */
export interface SdkBundle {
  body: Uint8Array;
  etag: string;
}

/** First 16 hex chars of the SHA-256 of the bundle bytes. */
export function bundleEtag(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

export interface Deps {
  core: Core;
  store: Store;
  limits?: Partial<Limits>;
  log?: (msg: string, fields: Record<string, unknown>) => void;
  bundle?: SdkBundle;
}

const STATUS = { bad_batch: 400, batch_too_large: 413, internal: 500 } as const;

function etagMatches(header: string, etag: string): boolean {
  return header.split(",").some((part) => {
    const value = part.trim().replace(/^W\//i, "").replace(/^"/, "").replace(/"$/, "");
    return value === "*" || value === etag;
  });
}

type Authed = { ok: true; access: ProjectAccess; apiKey: string } | { ok: false; response: Response };

export function createApp({ core, store, limits: overrides, log = () => {}, bundle }: Deps) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  let inflight = 0;
  const rates = new TokenBucket(limits.ratePerMin, limits.rateBurst);
  const app = new Hono();

  const fail = (status: 400 | 401 | 403 | 413 | 429 | 500 | 503, error: string, detail?: string) =>
    Response.json(detail === undefined ? { error } : { error, detail }, { status });

  app.get("/healthz", (c) => c.text("ok"));

  // Preflight carries no key, so every origin is reflected here. The
  // allowlist is enforced on the request that actually presents a key.
  app.use(
    "/v1/*",
    cors({
      origin: (origin) => origin || null,
      allowMethods: ["POST", "GET", "OPTIONS"],
      allowHeaders: ["authorization", "content-type"],
      maxAge: 600,
    }),
  );

  const authorize = async (c: Context): Promise<Authed> => {
    const auth = c.req.header("authorization") ?? "";
    const apiKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const access = apiKey ? await store.projectForKey(apiKey) : null;
    if (!access) return { ok: false, response: fail(401, "unauthorized", "missing or invalid API key") };
    const origin = c.req.header("origin");
    if (access.allowedOrigins.length > 0 && origin && !access.allowedOrigins.includes(origin)) {
      return { ok: false, response: fail(403, "origin_not_allowed") };
    }
    return { ok: true, access, apiKey };
  };

  app.post(
    "/v1/batches",
    bodyLimit({
      maxSize: limits.maxBodyBytes,
      onError: () => fail(413, "batch_too_large", `body exceeds ${limits.maxBodyBytes} bytes`),
    }),
    async (c) => {
      const authz = await authorize(c);
      if (!authz.ok) return authz.response;

      const retryAfter = rates.take(authz.apiKey);
      if (retryAfter !== null) {
        const res = fail(429, "rate_limited", "too many batches");
        res.headers.set("retry-after", String(retryAfter));
        return res;
      }

      if (inflight >= limits.maxInflight) {
        const res = fail(503, "busy", "too many batches in flight");
        res.headers.set("retry-after", "5");
        return res;
      }

      const body = new Uint8Array(await c.req.arrayBuffer());
      let ingested;
      try {
        ingested = core.ingest(authz.access.projectId, body);
      } catch (e) {
        if (e instanceof CoreError) return fail(STATUS[e.code], e.code, e.message);
        throw e;
      }

      inflight += 1;
      try {
        await store.write(authz.access.projectId, new Date(), ingested);
      } catch (e) {
        log("store write failed", { project: authz.access.projectId, error: String(e) });
        return fail(500, "internal", "could not store batch");
      } finally {
        inflight -= 1;
      }

      const sdkFindings = ingested.findings.filter((f) => f.source === "sdk").length;
      return c.json(
        {
          events: ingested.events.length,
          findings: sdkFindings,
          evaluator_findings: ingested.findings.length - sdkFindings,
          dropped_events: ingested.batch.dropped_events,
        },
        202,
      );
    },
  );

  app.get("/v1/bundle", async (c) => {
    const authz = await authorize(c);
    if (!authz.ok) return authz.response;
    if (!bundle) return fail(500, "internal", "sdk bundle is not configured");
    const served = await projectBundle(core, store, bundle, authz.access.projectId);
    const inm = c.req.header("if-none-match");
    if (inm && etagMatches(inm, served.etag)) {
      return new Response(null, { status: 304, headers: { etag: served.etag } });
    }
    return new Response(Buffer.from(served.body), {
      status: 200,
      headers: { "content-type": "application/octet-stream", etag: served.etag },
    });
  });

  app.get("/v1/config", async (c) => {
    const authz = await authorize(c);
    if (!authz.ok) return authz.response;
    return c.json({ project: authz.access.projectId, hash_key: authz.access.hashKey });
  });

  return app;
}

/** Override map the wasm core accepts. Null columns are left off so they stay defaults. */
export function overrideJson(
  rows: { rule: string; enabled: boolean | null; severity: string | null; params: Record<string, unknown> | null }[],
): Record<string, { enabled?: boolean; severity?: string; params?: Record<string, unknown> }> {
  const out: Record<string, { enabled?: boolean; severity?: string; params?: Record<string, unknown> }> = {};
  for (const row of rows) {
    const entry: { enabled?: boolean; severity?: string; params?: Record<string, unknown> } = {};
    if (row.enabled !== null) entry.enabled = row.enabled;
    if (row.severity) entry.severity = row.severity;
    if (row.params && Object.keys(row.params).length > 0) entry.params = row.params;
    if (Object.keys(entry).length > 0) out[row.rule] = entry;
  }
  return out;
}

async function projectBundle(
  core: Core,
  store: Store,
  bundle: SdkBundle,
  projectId: string,
): Promise<SdkBundle> {
  const overrides = overrideJson(await store.ruleOverrides(projectId));
  if (Object.keys(overrides).length === 0) return bundle;
  const body = core.applyOverrides(bundle.body, JSON.stringify(overrides));
  return { body, etag: bundleEtag(body) };
}
