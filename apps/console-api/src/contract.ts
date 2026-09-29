/** JSON shapes the console API returns. Dates are ISO strings. Import type-only. */

export type Role = "owner" | "admin" | "member";
export type Environment = "production" | "staging" | "development";
export type Severity = "critical" | "high" | "medium" | "low" | "info";
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

export interface Finding {
  id: number;
  projectId: string;
  rule: string;
  severity: Severity | string;
  provider: string;
  service: string;
  template: string;
  session: string;
  callsite: string;
  message: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  wasted: Record<string, number>;
  status: FindingStatus | string;
  assignee: string | null;
  note: string | null;
  wastedMicros: number;
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
  evidence: Record<string, unknown>;
  rule: CatalogRule | null;
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
  wastedMicros: number;
}

export interface Overview {
  rangeDays: number;
  from: string;
  kpis: {
    events: number;
    billedUnits: number;
    estimatedCostMicros: number;
    wastedMicros: number;
    openFindings: number;
  };
  series: OverviewPoint[];
  topRules: { rule: string; wastedMicros: number }[];
  topTemplates: { template: string; events: number }[];
  topCallsites: { callsite: string | null; events: number }[];
  openFindingsBySeverity: Record<string, number>;
}

export interface CostItem {
  key: string;
  micros: number;
  units: Record<string, number>;
}

export interface Costs {
  source: "estimate" | "billed" | string;
  currency: string;
  groupBy: "service" | "rule" | "template" | "day" | string;
  range: string;
  items: CostItem[];
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
