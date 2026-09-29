import type { ServiceAccount } from "./validate.ts";

export interface SeriesPoint {
  interval?: {
    startTime?: { seconds?: number | string | null } | null;
    endTime?: { seconds?: number | string | null } | null;
  } | null;
  value?: { int64Value?: string | number | null; doubleValue?: number | null } | null;
}

export interface TimeSeries {
  points?: SeriesPoint[] | null;
}

export interface ListTimeSeriesRequest {
  name: string;
  filter: string;
  interval: {
    startTime: { seconds: number };
    endTime: { seconds: number };
  };
  aggregation: {
    alignmentPeriod: { seconds: number };
    perSeriesAligner: "ALIGN_DELTA";
    crossSeriesReducer: "REDUCE_SUM";
  };
}

export interface MonitoringClient {
  projectPath(projectId: string): string;
  listTimeSeries(request: ListTimeSeriesRequest): Promise<[TimeSeries[]]>;
}

export interface BillingQuery {
  query: string;
  params?: Record<string, unknown>;
  types?: Record<string, string>;
  dryRun?: boolean;
  /** BigQuery INT64, sent as a decimal string. */
  maximumBytesBilled?: string;
}

export interface BillingClient {
  query(options: BillingQuery): Promise<[Record<string, unknown>[]]>;
}

export interface GcpClients {
  monitoring: MonitoringClient;
  bigquery: BillingClient;
}

export type ClientFactory = (account: ServiceAccount, gcpProjectId: string) => Promise<GcpClients>;

/** Emails that start with `fail@` make the fake clients reject every call. */
export function isFailAccount(account: ServiceAccount): boolean {
  return account.client_email.startsWith("fail@");
}

const DAY_SECONDS = 86_400;

/**
 * Fixed series and one billing row. No network.
 * Points are today and ten days ago so a 35-day sync and a later 3-day sync
 * can be told apart by the caller filtering the window.
 */
export function fakeClients(account: ServiceAccount, now = new Date()): GcpClients {
  const fail = isFailAccount(account);
  return {
    monitoring: {
      projectPath: (projectId) => `projects/${projectId}`,
      async listTimeSeries() {
        if (fail) throw new Error("monitoring denied");
        const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
        const older = today - 10 * DAY_SECONDS;
        return [
          [
            {
              points: [point(today, "10"), point(older, "4")],
            },
          ],
        ];
      },
    },
    bigquery: {
      async query(options) {
        if (fail) throw new Error("billing denied");
        if (options.dryRun) return [[]];
        const day = new Date(now).toISOString().slice(0, 10);
        const older = new Date(now.getTime() - 10 * DAY_SECONDS * 1000).toISOString().slice(0, 10);
        return [
          [
            {
              day,
              service: "Cloud Firestore",
              sku: "Read Ops",
              usage_amount: 10,
              usage_unit: "count",
              cost: 1.25,
              currency: "USD",
              credits: -0.25,
            },
            {
              day: older,
              service: "Cloud Firestore",
              sku: "Read Ops",
              usage_amount: 4,
              usage_unit: "count",
              cost: 0.5,
              currency: "USD",
              credits: 0,
            },
          ],
        ];
      },
    },
  };
}

function point(startSeconds: number, value: string): SeriesPoint {
  return {
    interval: {
      startTime: { seconds: startSeconds },
      endTime: { seconds: startSeconds + DAY_SECONDS },
    },
    value: { int64Value: value },
  };
}

export function clientsFromEnv(fake: boolean, now = new Date()): ClientFactory {
  if (fake) return async (account) => fakeClients(account, now);
  return (account, gcpProjectId) => realClients(account, gcpProjectId);
}

async function realClients(account: ServiceAccount, gcpProjectId: string): Promise<GcpClients> {
  const monitoringMod = await import("@google-cloud/monitoring");
  const bigqueryMod = await import("@google-cloud/bigquery");
  const MetricServiceClient =
    monitoringMod.MetricServiceClient ??
    (monitoringMod as { default?: { MetricServiceClient?: typeof monitoringMod.MetricServiceClient } }).default
      ?.MetricServiceClient;
  const BigQuery =
    bigqueryMod.BigQuery ??
    (bigqueryMod as { default?: { BigQuery?: typeof bigqueryMod.BigQuery } }).default?.BigQuery;
  if (!MetricServiceClient || !BigQuery) throw new Error("Google client libraries did not load");
  const credentials = { client_email: account.client_email, private_key: account.private_key };
  const monitoring = new MetricServiceClient({ credentials, projectId: gcpProjectId });
  const bigquery = new BigQuery({ credentials, projectId: gcpProjectId });
  return {
    monitoring: {
      projectPath: (projectId) => monitoring.projectPath(projectId),
      listTimeSeries: async (request) => {
        const [series] = (await monitoring.listTimeSeries(request)) as unknown as [TimeSeries[]];
        return [series];
      },
    },
    bigquery: {
      async query(options) {
        const [rows] = await bigquery.query({
          query: options.query,
          params: options.params,
          types: options.types,
          dryRun: options.dryRun,
          maximumBytesBilled: options.maximumBytesBilled,
        });
        return [rows as Record<string, unknown>[]];
      },
    },
  };
}
