export const MAX_KEY_BYTES = 16 * 1024;

/**
 * BigQuery identifiers cannot be query parameters. The table is restricted to
 * `project.dataset.table` and each part is backtick-quoted.
 * Project ids: 6–30 chars, lowercase, digits, hyphens.
 */
const BILLING_TABLE =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/;

export interface ServiceAccount {
  type: "service_account";
  client_email: string;
  private_key: string;
  project_id: string;
}

export function parseServiceAccount(input: unknown): { account: ServiceAccount; json: string } | { error: string } {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  if (Buffer.byteLength(text, "utf8") > MAX_KEY_BYTES) {
    return { error: "service account JSON must be at most 16 KiB" };
  }
  let parsed: unknown;
  try {
    parsed = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    return { error: "service account JSON is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "service account JSON must be an object" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== "service_account") return { error: 'type must be "service_account"' };
  if (typeof record.client_email !== "string" || !record.client_email.includes("@")) {
    return { error: "client_email is required" };
  }
  if (typeof record.private_key !== "string" || record.private_key.length === 0) {
    return { error: "private_key is required" };
  }
  if (typeof record.project_id !== "string" || record.project_id.length === 0) {
    return { error: "project_id is required" };
  }
  const account: ServiceAccount = {
    type: "service_account",
    client_email: record.client_email,
    private_key: record.private_key,
    project_id: record.project_id,
  };
  return { account, json: JSON.stringify(parsed) };
}

export function billingTableError(value: string): string | null {
  if (!BILLING_TABLE.test(value)) {
    return "billing table must look like project.dataset.table";
  }
  return null;
}

export function quoteBillingTable(value: string): string {
  const error = billingTableError(value);
  if (error) throw new Error(error);
  return value
    .split(".")
    .map((part) => `\`${part.replaceAll("`", "")}\``)
    .join(".");
}
