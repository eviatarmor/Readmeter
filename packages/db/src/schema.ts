// Postgres schema for Readmeter: control plane (orgs, projects, API keys)
// and telemetry (batches, events, findings).
//
// Hashes arrive from the core as 16-char hex strings (JS cannot hold u64)
// and are stored as text. Nothing here holds raw document data, ids or
// filter values: the SDK core redacts them before anything is sent.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations, users } from "./auth-schema.ts";

export {
  accounts,
  invitations,
  members,
  organizations,
  sessions,
  users,
  verifications,
} from "./auth-schema.ts";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const counter = (name: string) => bigint(name, { mode: "number" }).notNull().default(0);

export type ParamMap = Record<string, number | boolean | string>;

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * 32 lowercase hex chars (128-bit). SDKs use this as the keyed-hash key.
     * It is not an API secret: the API key is what authenticates ingest.
     */
    hashKey: text("hash_key").notNull(),
    firebaseProjectId: text("firebase_project_id"),
    environment: text("environment").notNull().default("production"),
    createdAt: createdAt(),
  },
  (t) => [
    index("projects_org_idx").on(t.orgId),
    check("projects_hash_key_hex", sql`${t.hashKey} ~ '^[0-9a-f]{32}$'`),
    check(
      "projects_environment",
      sql`${t.environment} in ('production', 'staging', 'development')`,
    ),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** SHA-256 of the full key, lowercase hex. The key itself is never stored. */
    keyHash: text("key_hash").notNull(),
    /** First characters of the key, for display in the console. */
    prefix: text("prefix").notNull(),
    name: text("name").notNull().default("default"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /**
     * Exact `Origin` values allowed to call ingest. Empty means any origin
     * (dev keys, and non-browser callers, which send no Origin).
     */
    allowedOrigins: text("allowed_origins")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("api_keys_hash_idx").on(t.keyHash)],
);

export const batches = pgTable(
  "batches",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    schema: integer("schema").notNull(),
    sdkName: text("sdk_name").notNull(),
    sdkVersion: text("sdk_version").notNull(),
    session: text("session").notNull(),
    events: integer("events").notNull(),
    findings: integer("findings").notNull(),
    droppedEvents: counter("dropped_events"),
    droppedFindings: counter("dropped_findings"),
  },
  (t) => [index("batches_project_received_idx").on(t.projectId, t.receivedAt)],
);

export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    batchId: bigint("batch_id", { mode: "number" })
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    session: text("session").notNull(),
    provider: text("provider").notNull(),
    service: text("service").notNull(),
    op: text("op").notNull(),
    opDetail: jsonb("op_detail"),
    template: text("template").notNull(),
    targetKey: text("target_key").notNull(),
    idShape: text("id_shape"),
    collectionGroup: boolean("collection_group").notNull().default(false),
    query: jsonb("query"),
    fingerprint: text("fingerprint"),
    baseKey: text("base_key"),
    items: counter("items"),
    bytes: counter("bytes"),
    fromCache: boolean("from_cache").notNull().default(false),
    errorCode: text("error_code"),
    durationUs: bigint("duration_us", { mode: "number" }),
    callId: text("call_id").notNull(),
    callsite: text("callsite"),
    listener: text("listener"),
    mount: text("mount"),
    platform: text("platform").notNull(),
    attempt: integer("attempt").notNull().default(0),
    dev: boolean("dev").notNull().default(false),
    units: jsonb("units").$type<Record<string, number>>().notNull(),
    signals: jsonb("signals").$type<Record<string, unknown> | null>(),
  },
  (t) => [
    index("events_project_ts_idx").on(t.projectId, t.ts),
    index("events_project_template_idx").on(t.projectId, t.template),
    index("events_project_callsite_idx").on(t.projectId, t.callsite),
  ],
);

/**
 * One row per (project, rule, session, callsite, template); repeats bump
 * `occurrences` and `last_seen`. `callsite` is the empty string when
 * unknown so the unique index covers it.
 */
export const findings = pgTable(
  "findings",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    rule: text("rule").notNull(),
    severity: text("severity").notNull(),
    /** `sdk` (local rule) or `evaluator` (window rule, found by ingest). */
    source: text("source").notNull(),
    provider: text("provider").notNull(),
    service: text("service").notNull(),
    template: text("template").notNull(),
    session: text("session").notNull(),
    callsite: text("callsite").notNull().default(""),
    message: text("message").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    wasted: jsonb("wasted").$type<Record<string, number>>().notNull(),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull(),
    occurrences: integer("occurrences").notNull().default(1),
  },
  (t) => [
    uniqueIndex("findings_dedupe_idx").on(t.projectId, t.rule, t.session, t.callsite, t.template),
    index("findings_project_last_seen_idx").on(t.projectId, t.lastSeen),
    index("findings_project_rule_idx").on(t.projectId, t.rule),
  ],
);

export const ruleOverrides = pgTable(
  "rule_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    rule: text("rule").notNull(),
    enabled: boolean("enabled"),
    severity: text("severity"),
    params: jsonb("params").$type<ParamMap>(),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("rule_overrides_project_rule_idx").on(t.projectId, t.rule),
    check(
      "rule_overrides_severity",
      sql`${t.severity} is null or ${t.severity} in ('info', 'low', 'medium', 'high', 'critical')`,
    ),
  ],
);

/** Console workflow state. Absent row means the finding is open. */
export const findingStates = pgTable(
  "finding_states",
  {
    findingId: bigint("finding_id", { mode: "number" })
      .primaryKey()
      .references(() => findings.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("open"),
    assignee: text("assignee").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("finding_states_status", sql`${t.status} in ('open', 'resolved', 'ignored')`),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** User id, or null for a system action. */
    actor: text("actor"),
    action: text("action").notNull(),
    target: text("target"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_org_at_idx").on(t.orgId, t.at.desc())],
);
