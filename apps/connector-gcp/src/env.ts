import { decodeSecretKey, secretKeyError } from "./crypto.ts";

export interface WorkerEnv {
  databaseUrl: string;
  fake: boolean;
  pollMs: number;
  timeoutMs: number;
  maxBytesBilled: number;
  secretKey: Buffer | null;
  secretError: string | null;
}

const DEFAULT_DATABASE_URL = "postgres://readmeter:readmeter@127.0.0.1:5442/readmeter";
/** 1 GiB. BigQuery jobs fail instead of scanning past this. */
export const DEFAULT_MAX_BYTES_BILLED = 1_073_741_824;

export function readWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const pollMs = Number(source.READMETER_GCP_POLL_MS ?? 60_000);
  const timeoutMs = Number(source.READMETER_GCP_SYNC_TIMEOUT_MS ?? 120_000);
  const maxBytesBilled = Number(source.READMETER_GCP_MAX_BYTES_BILLED ?? DEFAULT_MAX_BYTES_BILLED);
  if (!Number.isFinite(pollMs) || pollMs < 100) {
    throw new Error("READMETER_GCP_POLL_MS must be a number of milliseconds, at least 100");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("READMETER_GCP_SYNC_TIMEOUT_MS must be a positive number of milliseconds");
  }
  if (!Number.isFinite(maxBytesBilled) || maxBytesBilled < 1) {
    throw new Error("READMETER_GCP_MAX_BYTES_BILLED must be a positive byte count");
  }
  const secretError = secretKeyError(source.READMETER_SECRET_KEY);
  return {
    databaseUrl: source.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL,
    fake: source.READMETER_GCP_FAKE === "1",
    pollMs,
    timeoutMs,
    maxBytesBilled,
    secretError,
    secretKey: secretError ? null : decodeSecretKey(source.READMETER_SECRET_KEY),
  };
}
