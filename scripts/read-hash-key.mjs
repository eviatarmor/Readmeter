// Prints projects.hash_key for one id. Uses the postgres driver from packages/db.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, "packages/db/package.json"));
const postgres = require("postgres");

const id = process.argv[2];
if (!id) {
  console.error("missing project id");
  process.exit(1);
}
const url = process.env.DATABASE_URL ?? "postgres://readmeter:readmeter@127.0.0.1:5442/readmeter";
const sql = postgres(url, { max: 1 });
try {
  const rows = await sql`select hash_key from projects where id = ${id}`;
  if (rows.length === 0) {
    console.error(`unknown project ${id}`);
    process.exit(1);
  }
  process.stdout.write(String(rows[0].hash_key));
} finally {
  await sql.end({ timeout: 5 });
}
