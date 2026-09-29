// Dev seed: one org, one project, one API key. Idempotent.
// The key comes from READMETER_DEV_KEY (default `rm_dev_key`).
// proj_demo's hash key is fixed so tests and docs can use it.
import { connect, hashApiKey } from "./index.ts";
import { apiKeys, organizations, projects } from "./schema.ts";

const key = process.env.READMETER_DEV_KEY ?? "rm_dev_key";
const DEMO_HASH_KEY = "000102030405060708090a0b0c0d0e0f";

const { db, close } = connect();
try {
  await db.insert(organizations).values({ id: "org_demo", name: "Demo" }).onConflictDoNothing();
  await db
    .insert(projects)
    .values({ id: "proj_demo", orgId: "org_demo", name: "Demo project", hashKey: DEMO_HASH_KEY })
    .onConflictDoUpdate({ target: projects.id, set: { hashKey: DEMO_HASH_KEY } });
  await db
    .insert(apiKeys)
    .values({ projectId: "proj_demo", keyHash: hashApiKey(key), prefix: key.slice(0, 8) })
    .onConflictDoNothing();
  console.log(`seeded proj_demo with API key ${key}`);
} finally {
  await close();
}
