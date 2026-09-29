/**
 * Cloud Monitoring metric types checked against the metrics list
 * (cloud.google.com/monitoring/api/metrics_gcp, pages D–H and P–Z, 2026-09-28).
 * Every entry below is DELTA / INT64. ALIGN_DELTA is valid for DELTA metrics.
 * None were dropped.
 *
 * `run.googleapis.com/request_count` labels are response_code, response_code_class,
 * and route. `goog-managed-by` is not a metric label; gen 2 functions set it as a
 * Cloud Run user label, so the filter uses metadata.user_labels.
 */
export interface UsageMetric {
  type: string;
  provider: "firebase";
  service: string;
  /** Readmeter unit name stored on usage_daily.metric. */
  metric: string;
  /** ANDed onto `metric.type="..."`. */
  extraFilter?: string;
  /** Documented unit, for readers. Not sent to the API. */
  unit: "1" | "By";
}

export const USAGE_METRICS: readonly UsageMetric[] = [
  {
    type: "firestore.googleapis.com/document/read_count",
    provider: "firebase",
    service: "firestore",
    metric: "reads",
    unit: "1",
  },
  {
    type: "firestore.googleapis.com/document/write_count",
    provider: "firebase",
    service: "firestore",
    metric: "writes",
    unit: "1",
  },
  {
    type: "firestore.googleapis.com/document/delete_count",
    provider: "firebase",
    service: "firestore",
    metric: "deletes",
    unit: "1",
  },
  {
    type: "firebasedatabase.googleapis.com/network/sent_bytes_count",
    provider: "firebase",
    service: "database",
    metric: "egress_bytes",
    unit: "By",
  },
  {
    type: "storage.googleapis.com/network/sent_bytes_count",
    provider: "firebase",
    service: "storage",
    metric: "egress_bytes",
    unit: "By",
  },
  {
    type: "storage.googleapis.com/api/request_count",
    provider: "firebase",
    service: "storage",
    metric: "operations",
    unit: "1",
  },
  {
    type: "cloudfunctions.googleapis.com/function/execution_count",
    provider: "firebase",
    service: "functions",
    metric: "invocations",
    unit: "1",
  },
  {
    type: "run.googleapis.com/request_count",
    provider: "firebase",
    service: "functions",
    metric: "invocations",
    unit: "1",
    extraFilter: 'metadata.user_labels."goog-managed-by"="cloudfunctions"',
  },
];

export const MONITORING_PROBE = USAGE_METRICS[0]!;

export function metricFilter(metric: UsageMetric): string {
  const type = `metric.type="${metric.type}"`;
  return metric.extraFilter ? `${type} AND ${metric.extraFilter}` : type;
}

export interface GcpRoleInfo {
  role: string;
  scope: string;
  when: "always" | "billing";
}

export const GCP_ROLES: readonly GcpRoleInfo[] = [
  { role: "roles/monitoring.viewer", scope: "the Firebase project", when: "always" },
  { role: "roles/bigquery.dataViewer", scope: "the billing export dataset", when: "billing" },
  { role: "roles/bigquery.jobUser", scope: "the project that runs the query", when: "billing" },
];
