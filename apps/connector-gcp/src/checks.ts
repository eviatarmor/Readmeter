import { billingProbeQuery } from "./billing.ts";
import type { ClientFactory } from "./clients.ts";
import { MONITORING_PROBE } from "./metrics.ts";
import { seriesRequest } from "./monitoring.ts";
import { publicError } from "./crypto.ts";
import type { ServiceAccount } from "./validate.ts";

export interface Check {
  name: string;
  ok: boolean;
  message: string;
}

export async function testConnection(input: {
  account: ServiceAccount;
  gcpProjectId: string;
  billingTable: string | null;
  clients: ClientFactory;
  maxBytesBilled: number;
  now?: Date;
}): Promise<Check[]> {
  const now = input.now ?? new Date();
  const clients = await input.clients(input.account, input.gcpProjectId);
  const secrets = [input.account.private_key];
  const checks: Check[] = [];
  const end = now;
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  try {
    await clients.monitoring.listTimeSeries(
      seriesRequest(clients.monitoring.projectPath(input.gcpProjectId), MONITORING_PROBE, start, end, 3600),
    );
    checks.push({
      name: "monitoring",
      ok: true,
      message: "Cloud Monitoring accepted a time series list for the last hour.",
    });
  } catch (error) {
    checks.push({ name: "monitoring", ok: false, message: publicError(error, secrets) });
  }
  if (input.billingTable) {
    try {
      await clients.bigquery.query(billingProbeQuery(input.billingTable, String(input.maxBytesBilled)));
      checks.push({
        name: "billing",
        ok: true,
        message: "Billing export dry run succeeded.",
      });
    } catch (error) {
      checks.push({ name: "billing", ok: false, message: publicError(error, secrets) });
    }
  }
  return checks;
}
