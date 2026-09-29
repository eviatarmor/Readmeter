// Dev user for the console. Hashes come from Better Auth, not from this file.
import { and, eq } from "drizzle-orm";

import { connect, schema } from "@readmeter/db";

import { createAuth } from "./auth.ts";
import { readEnv } from "./env.ts";
import { createMailer } from "./mail.ts";

const EMAIL = "admin@readmeter.local";
const PASSWORD = "readmeter-dev";

if (process.env.NODE_ENV === "production") {
  console.log("skipping dev user seed because NODE_ENV is production");
  process.exit(0);
}

const env = readEnv();
const { db, close } = connect();
try {
  const auth = createAuth(db, env, createMailer(env));
  const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, EMAIL)).limit(1);
  if (!existing) {
    await auth.api.signUpEmail({
      body: { name: "Admin", email: EMAIL, password: PASSWORD },
    });
  }
  const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, EMAIL)).limit(1);
  if (!user) throw new Error("dev user was not created");
  const [member] = await db
    .select({ id: schema.members.id, role: schema.members.role })
    .from(schema.members)
    .where(and(eq(schema.members.organizationId, "org_demo"), eq(schema.members.userId, user.id)))
    .limit(1);
  if (!member) {
    await db.insert(schema.members).values({
      id: `mem_${user.id}`,
      organizationId: "org_demo",
      userId: user.id,
      role: "owner",
      createdAt: new Date(),
    });
  } else if (member.role !== "owner") {
    await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  }
  console.log(`seeded ${EMAIL}`);
} finally {
  await close();
}
