import { hashApiKey, schema, type Db } from "@readmeter/db";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { FindingRow, Ingested } from "./types.ts";

/** What an active API key is allowed to do. Cached with the key hash. */
export interface ProjectAccess {
  projectId: string;
  /** Empty means any origin. Otherwise the request Origin must match exactly. */
  allowedOrigins: string[];
  /** 32 lowercase hex chars. SDKs fetch this from `GET /v1/config`. */
  hashKey: string;
}

/** One project rule override, as stored. Null fields are "leave the default". */
export interface StoredOverride {
  rule: string;
  enabled: boolean | null;
  severity: string | null;
  params: Record<string, number | boolean | string> | null;
}

export interface Store {
  /** Access for an active API key, or `null`. */
  projectForKey(apiKey: string): Promise<ProjectAccess | null>;
  /** Stores one accepted batch atomically. */
  write(project: string, receivedAt: Date, ingested: Ingested): Promise<void>;
  /** Rule overrides for the project that owns the API key. */
  ruleOverrides(projectId: string): Promise<StoredOverride[]>;
}

// Postgres caps a statement at 65535 bind parameters; events have ~29 columns.
const EVENT_CHUNK = 1_000;
const KEY_CACHE_TTL_MS = 30_000;
const KEY_CACHE_MAX = 10_000;
const LAST_USED_MIN_MS = 60_000;

/** Collapses findings that share the dedupe key: one upsert may not touch a row twice. */
export function collapseFindings(findings: FindingRow[]) {
  const byKey = new Map<string, { row: FindingRow; first: number; last: number; count: number }>();
  for (const f of findings) {
    const key = [f.rule, f.session, f.callsite ?? "", f.template].join("\u0000");
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { row: f, first: f.ts_ms, last: f.ts_ms, count: 1 });
      continue;
    }
    seen.count += 1;
    seen.first = Math.min(seen.first, f.ts_ms);
    if (f.ts_ms >= seen.last) {
      seen.last = f.ts_ms;
      seen.row = f;
    }
  }
  return [...byKey.values()];
}

export class PgStore implements Store {
  // Revocations and origin-list edits take effect within KEY_CACHE_TTL_MS.
  private readonly keys = new Map<string, { access: ProjectAccess | null; expires: number }>();
  // At most one last_used_at write per key per minute. Not awaited.
  private readonly lastUsed = new Map<string, number>();
  private loggedLastUsed = false;

  constructor(private readonly db: Db) {}

  async projectForKey(apiKey: string): Promise<ProjectAccess | null> {
    const hash = hashApiKey(apiKey);
    const now = Date.now();
    const cached = this.keys.get(hash);
    if (cached && cached.expires > now) {
      if (cached.access) this.touchLastUsed(hash, now);
      return cached.access;
    }

    const [row] = await this.db
      .select({
        projectId: schema.apiKeys.projectId,
        allowedOrigins: schema.apiKeys.allowedOrigins,
        hashKey: schema.projects.hashKey,
      })
      .from(schema.apiKeys)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.apiKeys.projectId))
      .where(and(eq(schema.apiKeys.keyHash, hash), isNull(schema.apiKeys.revokedAt)))
      .limit(1);
    const access: ProjectAccess | null = row
      ? {
          projectId: row.projectId,
          allowedOrigins: row.allowedOrigins ?? [],
          hashKey: row.hashKey,
        }
      : null;
    if (this.keys.size >= KEY_CACHE_MAX) this.keys.clear();
    this.keys.set(hash, { access, expires: now + KEY_CACHE_TTL_MS });
    if (access) this.touchLastUsed(hash, now);
    return access;
  }

  async ruleOverrides(projectId: string): Promise<StoredOverride[]> {
    return this.db
      .select({
        rule: schema.ruleOverrides.rule,
        enabled: schema.ruleOverrides.enabled,
        severity: schema.ruleOverrides.severity,
        params: schema.ruleOverrides.params,
      })
      .from(schema.ruleOverrides)
      .where(eq(schema.ruleOverrides.projectId, projectId));
  }

  private touchLastUsed(keyHash: string, now: number) {
    const prev = this.lastUsed.get(keyHash) ?? 0;
    if (now - prev < LAST_USED_MIN_MS) return;
    this.lastUsed.set(keyHash, now);
    void this.db
      .update(schema.apiKeys)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(schema.apiKeys.keyHash, keyHash))
      .then(() => undefined)
      .catch((error: unknown) => {
        if (this.loggedLastUsed) return;
        this.loggedLastUsed = true;
        console.error(
          JSON.stringify({ msg: "last_used_at update failed", error: String(error) }),
        );
      });
  }

  async write(project: string, receivedAt: Date, { batch, events, findings }: Ingested) {
    await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(schema.batches)
        .values({
          projectId: project,
          receivedAt,
          sentAt: new Date(batch.sent_at_ms),
          schema: batch.schema,
          sdkName: batch.sdk.name,
          sdkVersion: batch.sdk.version,
          session: batch.session,
          events: events.length,
          findings: findings.length,
          droppedEvents: batch.dropped_events,
          droppedFindings: batch.dropped_findings,
        })
        .returning({ id: schema.batches.id });
      if (!inserted) throw new Error("batch insert returned no id");

      for (let i = 0; i < events.length; i += EVENT_CHUNK) {
        await tx.insert(schema.events).values(
          events.slice(i, i + EVENT_CHUNK).map((e) => ({
            projectId: project,
            batchId: inserted.id,
            ts: new Date(e.ts_ms),
            session: e.session,
            provider: e.provider,
            service: e.service,
            op: e.op,
            opDetail: e.op_detail,
            template: e.template,
            targetKey: e.target_key,
            idShape: e.id_shape,
            collectionGroup: e.collection_group,
            query: e.query,
            fingerprint: e.fingerprint,
            baseKey: e.base_key,
            items: e.items,
            bytes: e.bytes,
            fromCache: e.from_cache,
            errorCode: e.error_code,
            durationUs: e.duration_us,
            callId: e.call_id,
            callsite: e.callsite,
            listener: e.listener,
            mount: e.mount,
            platform: e.platform,
            attempt: e.attempt,
            dev: e.dev,
            units: e.units,
            signals: e.signals,
          })),
        );
      }

      const collapsed = collapseFindings(findings);
      if (collapsed.length === 0) return;
      const f = schema.findings;
      await tx
        .insert(f)
        .values(
          collapsed.map(({ row, first, last, count }) => ({
            projectId: project,
            rule: row.rule,
            severity: row.severity,
            source: row.source,
            provider: row.provider,
            service: row.service,
            template: row.template,
            session: row.session,
            callsite: row.callsite ?? "",
            message: row.message,
            evidence: row.evidence,
            wasted: row.wasted,
            firstSeen: new Date(first),
            lastSeen: new Date(last),
            occurrences: count,
          })),
        )
        .onConflictDoUpdate({
          target: [f.projectId, f.rule, f.session, f.callsite, f.template],
          set: {
            occurrences: sql`${f.occurrences} + excluded.occurrences`,
            firstSeen: sql`least(${f.firstSeen}, excluded.first_seen)`,
            lastSeen: sql`greatest(${f.lastSeen}, excluded.last_seen)`,
            severity: sql`excluded.severity`,
            message: sql`excluded.message`,
            evidence: sql`excluded.evidence`,
            wasted: sql`excluded.wasted`,
          },
        });
    });
  }
}
