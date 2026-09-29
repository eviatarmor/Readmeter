// Idempotent local project `demo_local` and its ingest key.
// Writes `.readmeter/local.env` with the fields the example apps read.
import { randomBytes } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { and, eq, isNull } from "drizzle-orm";

import { connect, hashApiKey, schema } from "./index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ENV_FILE = resolve(ROOT, ".readmeter/local.env");
const PROJECT = "demo_local";
const ORG = "org_local";
const ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];
const ENDPOINT = "http://127.0.0.1:8090";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBase62(length: number): string {
  const chars: string[] = [];
  while (chars.length < length) {
    const bytes = randomBytes(length);
    for (const byte of bytes) {
      if (byte >= 248) continue;
      chars.push(BASE62[byte % 62]!);
      if (chars.length === length) break;
    }
  }
  return chars.join("");
}

function readEnv(file: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqAt = trimmed.indexOf("=");
      if (eqAt <= 0) continue;
      out[trimmed.slice(0, eqAt).trim()] = trimmed.slice(eqAt + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

function sameOrigins(left: string[] | null | undefined, right: string[]): boolean {
  const a = [...(left ?? [])].sort().join("\n");
  return a === [...right].sort().join("\n");
}

const { db, close } = connect();
try {
  await db
    .insert(schema.organizations)
    .values({ id: ORG, name: "Local", slug: "local" })
    .onConflictDoNothing();
  const [org] = await db
    .select({ slug: schema.organizations.slug })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, ORG))
    .limit(1);
  if (!org) throw new Error(`organization ${ORG} was not created`);
  // A row created before slugs existed was backfilled to slug = id. The demo
  // login should open a stable slug. A slug someone set on purpose stays.
  if (!org.slug || org.slug === ORG) {
    await db.update(schema.organizations).set({ slug: "local" }).where(eq(schema.organizations.id, ORG));
  }

  const [devUser] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "admin@readmeter.local"))
    .limit(1);
  if (devUser) {
    const [membership] = await db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(and(eq(schema.members.organizationId, ORG), eq(schema.members.userId, devUser.id)))
      .limit(1);
    if (!membership) {
      await db.insert(schema.members).values({
        id: `mem_${devUser.id}_local`,
        organizationId: ORG,
        userId: devUser.id,
        role: "owner",
        createdAt: new Date(),
      });
    }
  }

  let [project] = await db
    .select({ hashKey: schema.projects.hashKey })
    .from(schema.projects)
    .where(eq(schema.projects.id, PROJECT))
    .limit(1);
  if (!project) {
    const hashKey = randomBytes(16).toString("hex");
    await db.insert(schema.projects).values({
      id: PROJECT,
      orgId: ORG,
      name: PROJECT,
      hashKey,
      environment: "development",
    });
    project = { hashKey };
  }

  const current = readEnv(ENV_FILE);
  const currentOrigins = (current.READMETER_ORIGINS ?? "").split(",").filter((origin) => origin.length > 0);
  let apiKey = current.READMETER_API_KEY ?? "";
  const reusable =
    apiKey.length > 0 &&
    current.READMETER_HASH_KEY === project.hashKey &&
    sameOrigins(currentOrigins, ORIGINS);
  if (reusable) {
    const [key] = await db
      .select({ allowedOrigins: schema.apiKeys.allowedOrigins })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.projectId, PROJECT),
          eq(schema.apiKeys.keyHash, hashApiKey(apiKey)),
          isNull(schema.apiKeys.revokedAt),
        ),
      )
      .limit(1);
    if (!key || !sameOrigins(key.allowedOrigins, ORIGINS)) apiKey = "";
  } else {
    apiKey = "";
  }

  if (!apiKey) {
    apiKey = `rm_${randomBase62(32)}`;
    await db.insert(schema.apiKeys).values({
      projectId: PROJECT,
      keyHash: hashApiKey(apiKey),
      prefix: apiKey.slice(0, 8),
      name: "local",
      allowedOrigins: ORIGINS,
    });
  }

  mkdirSync(dirname(ENV_FILE), { recursive: true });
  writeFileSync(
    ENV_FILE,
    [
      `READMETER_PROJECT=${PROJECT}`,
      `READMETER_API_KEY=${apiKey}`,
      `READMETER_HASH_KEY=${project.hashKey}`,
      `READMETER_ENDPOINT=${ENDPOINT}`,
      `READMETER_ORIGINS=${ORIGINS.join(",")}`,
      "",
    ].join("\n"),
  );
  console.log(apiKey === current.READMETER_API_KEY ? `reusing ${ENV_FILE}` : `wrote ${ENV_FILE}`);
} finally {
  await close();
}
