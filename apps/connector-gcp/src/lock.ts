import { createHash } from "node:crypto";

import type { Sql } from "postgres";

/** Two int4 keys for pg_advisory_lock. Stable for a connection id. */
export function lockKeys(id: string): [number, number] {
  const hash = createHash("sha256").update(id).digest();
  return [hash.readInt32BE(0), hash.readInt32BE(4)];
}

/**
 * Session advisory locks stick to the connection that took them. The pool
 * must not run the unlock on a different session, so this reserves one.
 */
export async function withConnectionLock<T>(
  sql: Sql,
  id: string,
  fn: () => Promise<T>,
): Promise<{ locked: true; value: T } | { locked: false }> {
  const [k1, k2] = lockKeys(id);
  const reserved = await sql.reserve();
  try {
    const rows = await reserved<{ locked: boolean | string }[]>`
      select pg_try_advisory_lock(${k1}::integer, ${k2}::integer) as locked
    `;
    const locked = rows[0]?.locked;
    if (locked !== true && locked !== "t" && locked !== "true") return { locked: false };
    try {
      const value = await fn();
      return { locked: true, value };
    } finally {
      await reserved`select pg_advisory_unlock(${k1}::integer, ${k2}::integer)`;
    }
  } finally {
    reserved.release();
  }
}
