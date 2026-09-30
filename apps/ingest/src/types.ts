// Mirrors crates/evaluator/src/rows.rs. 64-bit hashes are 16-char hex strings.

export type Units = Record<string, number>;

export interface BatchRow {
  schema: number;
  sdk: { name: string; version: string };
  session: string;
  sent_at_ms: number;
  dropped_events: number;
  dropped_findings: number;
}

export interface EventRow {
  ts_ms: number;
  session: string;
  provider: string;
  service: string;
  op: string;
  op_detail: Record<string, unknown> | null;
  template: string;
  target_key: string;
  id_shape: string | null;
  collection_group: boolean;
  query: Record<string, unknown> | null;
  fingerprint: string | null;
  base_key: string | null;
  items: number;
  bytes: number;
  from_cache: boolean;
  error_code: string | null;
  duration_us: number | null;
  call_id: string;
  callsite: string | null;
  callsite_label: string | null;
  listener: string | null;
  mount: string | null;
  platform: string;
  attempt: number;
  dev: boolean;
  units: Units;
  /** Present signals only. `null` when the call carries none. */
  signals: Record<string, unknown> | null;
}

export interface FindingRow {
  rule: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  source: "sdk" | "evaluator";
  ts_ms: number;
  provider: string;
  service: string;
  template: string;
  session: string;
  callsite: string | null;
  callsite_label: string | null;
  message: string;
  evidence: Record<string, unknown>;
  wasted: Units;
}

export interface Ingested {
  batch: BatchRow;
  events: EventRow[];
  findings: FindingRow[];
}
