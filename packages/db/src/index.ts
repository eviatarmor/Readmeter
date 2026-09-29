import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.ts";

export * as schema from "./schema.ts";

export const DEFAULT_DATABASE_URL = "postgres://readmeter:readmeter@127.0.0.1:5442/readmeter";

export function connect(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}

export type Db = ReturnType<typeof connect>["db"];

/** SHA-256 hex of an API key, as stored in `api_keys.key_hash`. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Findings for one project. Opens and closes its own connection. */
export async function findingRules(
  projectId: string,
  url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
): Promise<{ rule: string; occurrences: number; template: string }[]> {
  const { db, close } = connect(url);
  try {
    return await db
      .select({
        rule: schema.findings.rule,
        occurrences: schema.findings.occurrences,
        template: schema.findings.template,
      })
      .from(schema.findings)
      .where(eq(schema.findings.projectId, projectId));
  } finally {
    await close();
  }
}
