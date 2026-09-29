import type { ClientFactory } from "./clients.ts";
import { clientsFromEnv } from "./clients.ts";
import { decodeSecretKey, secretKeyError } from "./crypto.ts";
import { DEFAULT_MAX_BYTES_BILLED } from "./env.ts";

export { billingQuery, billingProbeQuery, parseBillingRows, toMicros } from "./billing.ts";
export { testConnection, type Check } from "./checks.ts";
export { clientsFromEnv, fakeClients, isFailAccount, type ClientFactory, type GcpClients } from "./clients.ts";
export { decodeSecretKey, decryptSecret, encryptSecret, publicError, secretKeyError, type SealedKey } from "./crypto.ts";
export { GCP_ROLES, USAGE_METRICS, type GcpRoleInfo } from "./metrics.ts";
export { syncDue, type SyncOptions, type SyncPass } from "./sync.ts";
export { billingTableError, parseServiceAccount, quoteBillingTable, type ServiceAccount } from "./validate.ts";

export interface GcpDeps {
  secretKey: Buffer | null;
  secretError: string | null;
  maxBytesBilled: number;
  clients: ClientFactory;
}

/** Reads process env. A missing or bad key does not throw; PUT reports `secretError`. */
export function gcpDepsFromEnv(source: NodeJS.ProcessEnv = process.env): GcpDeps {
  const parsed = Number(source.READMETER_GCP_MAX_BYTES_BILLED ?? DEFAULT_MAX_BYTES_BILLED);
  const maxBytesBilled = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES_BILLED;
  const secretError = secretKeyError(source.READMETER_SECRET_KEY);
  return {
    secretError,
    secretKey: secretError ? null : decodeSecretKey(source.READMETER_SECRET_KEY),
    maxBytesBilled,
    clients: clientsFromEnv(source.READMETER_GCP_FAKE === "1"),
  };
}
