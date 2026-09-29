/** JSON shapes the console API returns. Dates are ISO strings. Import type-only. */

export type Role = "owner" | "admin" | "member";
export type Environment = "production" | "staging" | "development";
export type Severity = "critical" | "high" | "medium" | "low" | "info";
/**
 * Cost-impact order for every severity list (filters, selects, charts, badges).
 * Never sort these alphabetically.
 */
export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;
export type FindingStatus = "open" | "resolved" | "ignored";
export type Range = "7d" | "30d" | "90d";

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export interface AuthConfig {
  google: boolean;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export interface Me {
  user: SessionUser;
  workspaces: WorkspaceSummary[];
  activeWorkspace: string | null;
}

export interface WorkspaceDetail {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  createdAt: string;
  counts: { projects: number; members: number };
}

export interface WorkspacePatch {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  /** Findings lists include the full match count (groups or rows), not the page size. */
  total?: number;
}

export interface Member {
  id: string;
  role: Role;
  joined: string;
  lastActive: string | null;
  user: SessionUser;
}

export interface Invitation {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: string;
  createdAt: string;
  link?: string | null;
}

export interface Project {
  id: string;
  name: string;
  environment: Environment;
  firebaseProjectId: string | null;
  createdAt: string;
  events24h: number;
  openFindings: number;
}

export interface ProjectDetail extends Omit<Project, "events24h" | "openFindings"> {
  hashKey: string;
  snippets: { web: string; functions: string };
}

export interface CreatedProject {
  id: string;
  orgId: string;
  name: string;
  hashKey: string;
  environment: Environment;
  firebaseProjectId: string | null;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  allowedOrigins: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdBy: string | null;
  creator: { id: string; name: string; email: string } | null;
}

export interface CreatedApiKey {
  id: string;
  key: string;
  prefix: string;
  name: string;
  allowedOrigins: string[];
  createdAt: string;
}

/**
 * One finding row (`group=none`) or one issue (`group=issue`, the default).
 *
 * Issue id is `{projectId}:{md5}`, where `md5` is the first 16 hex chars of
 * MD5 over UTF-8 `rule + "\n" + template + "\n" + callsite`. Postgres `md5()`
 * of that same text matches, so detail and status updates can find the group
 * without an extension. A numeric id is a single finding (`group=none`, and
 * `GET`/`PATCH /findings/:id` of that id still addresses its whole issue).
 *
 * Group fields, from members that pass the list filters:
 * - `sessions`: distinct sessions. `occurrences`: sum. `wasted`: units summed
 *   per key. `wastedMicros`: price of those summed units (one provider and
 *   service, taken from the latest member).
 * - `firstSeen`: min. `lastSeen`: max. `message`, `severity`, `provider`,
 *   `service`, and `session`: the member with the greatest `lastSeen`.
 * - `status`: `open` if any member is open (a missing `finding_states` row is
 *   open); otherwise the status with the greatest `finding_states.updated_at`.
 * - `assignee` and `note`: from the member that supplied `status` (when open,
 *   the open member with the greatest `updated_at`).
 */
export interface Finding {
  /** Numeric finding id, or an issue id (`project:hash`) when grouped. */
  id: number | string;
  projectId: string;
  rule: string;
  severity: Severity | string;
  provider: string;
  service: string;
  template: string;
  /** Latest member session. `group=none` is that row's own session. */
  session: string;
  callsite: string;
  message: string;
  occurrences: number;
  /** Distinct sessions. `1` on a `group=none` row. */
  sessions: number;
  firstSeen: string;
  lastSeen: string;
  wasted: Record<string, number>;
  status: FindingStatus | string;
  assignee: string | null;
  note: string | null;
  wastedMicros: number;
}

/** One session row inside an issue. Occurrences are this row's own count. */
export interface FindingMember {
  id: number;
  session: string;
  occurrences: number;
  lastSeen: string;
  evidence: Record<string, unknown>;
}

export interface RuleExample {
  lang: string;
  bad: string;
  good: string;
}

export interface CatalogRule {
  id: string;
  title: string;
  provider: string;
  service: string;
  severity: string;
  category: string;
  evaluation: string;
  status: string;
  default_enabled: boolean;
  summary: string;
  description: string;
  fix: string;
  docs: string[];
  params: Record<string, number | boolean | string>;
  examples: RuleExample[];
}

export interface FindingDetail extends Omit<Finding, "rule"> {
  /** Evidence from the latest member (`members[0]`). */
  evidence: Record<string, unknown>;
  rule: CatalogRule | null;
  /** Latest 20 members by `lastSeen`. */
  members: FindingMember[];
  /**
   * Occurrences bucketed onto each member's `lastSeen` UTC day.
   * Gaps of 90 days or fewer are filled with 0.
   */
  occurrencesByDay: { day: string; occurrences: number }[];
}

export interface TelemetryEvent {
  id: number;
  projectId: string;
  ts: string;
  session: string;
  provider: string;
  service: string;
  op: string;
  opDetail: unknown;
  template: string;
  callsite: string | null;
  units: Record<string, number>;
  items: number | null;
  bytes: number | null;
  fromCache: boolean;
  errorCode: string | null;
  platform: string;
  signals: Record<string, unknown> | null;
  targetKey: string;
  idShape: string | null;
  collectionGroup: boolean;
  query: unknown;
  durationUs: number | null;
  listener: string | null;
  mount: string | null;
  dev: boolean;
  attempt: number;
}

export interface RuleEffective {
  enabled: boolean;
  severity: string;
  params: Record<string, number | boolean | string>;
  overridden: boolean;
}

export interface RuleRow extends CatalogRule {
  effective?: RuleEffective;
}

export interface RulesResponse {
  rules: RuleRow[];
}

export interface OverviewPoint {
  day: string;
  events: number;
  billedUnits: number;
  estimatedCostMicros: number;
  /** Net billed micros (cost + credits) for the day. 0 when that day has no invoice row. */
  billedCostMicros: number;
  wastedMicros: number;
}

export interface SdkCoverage {
  estimatedReads: number;
  billedReads: number;
  /** Estimated Firestore reads divided by billed Firestore reads. */
  ratio: number;
}

export interface Overview {
  rangeDays: number;
  from: string;
  kpis: {
    events: number;
    billedUnits: number;
    estimatedCostMicros: number;
    /** "Billed" when cost_daily has rows in the range, otherwise "Estimated". */
    costLabel: "Billed" | "Estimated";
    /** The micros shown on the cost KPI: billed net when present, otherwise the estimate. */
    costMicros: number;
    /** Net billed micros in the range, or null when no invoice rows exist. */
    billedCostMicros: number | null;
    wastedMicros: number;
    openFindings: number;
    /** Open issues: groups with at least one open finding. */
    openIssues: number;
  };
  series: OverviewPoint[];
  sdkCoverage: SdkCoverage | null;
  topRules: { rule: string; title: string; wastedMicros: number }[];
  topTemplates: { template: string; events: number }[];
  topCallsites: { callsite: string | null; events: number }[];
  openFindingsBySeverity: Record<string, number>;
}

export interface CostItem {
  key: string;
  micros: number;
  units: Record<string, number>;
}

export interface BilledSku {
  service: string;
  sku: string;
  /** Gross cost from the billing export, in micros. */
  micros: number;
  creditsMicros: number;
  usageAmount: number;
  usageUnit: string;
}

export interface CostComparisonPoint {
  day: string;
  estimatedMicros: number;
  billedMicros: number;
}

export interface Costs {
  source: "estimate" | "billed" | string;
  currency: string;
  groupBy: "service" | "rule" | "template" | "day" | string;
  range: string;
  items: CostItem[];
  /** Sum of the daily estimate, independent of groupBy. */
  estimatedMicros: number;
  /** Net billed micros (cost + credits), or null when the range has no invoice rows. */
  billedMicros: number | null;
  billedBySku: BilledSku[];
  comparison: CostComparisonPoint[];
  sdkCoverage: SdkCoverage | null;
}

export interface GcpRole {
  role: string;
  scope: string;
  when: "always" | "billing";
}

export interface GcpConnection {
  id: string;
  projectId: string;
  gcpProjectId: string;
  clientEmail: string;
  billingTable: string | null;
  status: "pending" | "ok" | "error" | string;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GcpCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface GcpConnectionResponse {
  connection: GcpConnection | null;
  roles: GcpRole[];
}

export interface AuditEntry {
  id: number;
  orgId: string;
  actor: string | null;
  action: string;
  target: string | null;
  metadata: Record<string, unknown> | null;
  at: string;
}
