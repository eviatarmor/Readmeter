import assert from "node:assert/strict";
import test from "node:test";

import { connect } from "@readmeter/db";
import type { Hono } from "hono";

import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { loadCore } from "../src/core.ts";
import { readEnv, type ConsoleEnv } from "../src/env.ts";
import { createMailer } from "../src/mail.ts";

const databaseUrl = process.env.DATABASE_URL;
const ORIGIN = "http://localhost:5174";
const BASE = "http://127.0.0.1:8091";

function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((cookie) => cookie.includes("="))
    .join("; ");
}

async function call(
  app: Hono,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; origin?: string } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin) headers.set("origin", options.origin);
  const mutating = method !== "GET" && method !== "HEAD";
  if (mutating) headers.set("content-type", "application/json");
  return app.request(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      body: mutating ? JSON.stringify(options.body ?? {}) : undefined,
    }),
  );
}

function envFor(overrides: Record<string, string> = {}): ConsoleEnv {
  return readEnv({
    PORT: "8091",
    BETTER_AUTH_URL: BASE,
    CONSOLE_ORIGIN: ORIGIN,
    ...overrides,
  });
}

test("only an owner can grant, demote, or remove an owner", { skip: !databaseUrl }, async () => {
  const { db, close } = connect(databaseUrl);
  const env = envFor();
  const mailer = createMailer(env);
  const auth = createAuth(db, env, mailer);
  const app = createApp({ db, auth, core: await loadCore(), env, mailer });
  const suffix = Math.random().toString(36).slice(2, 10);
  const slug = `own-${suffix}`;
  try {
    const ownerEmail = `owner-${suffix}@readmeter.test`;
    const ownerSign = await call(app, "POST", "/api/auth/sign-up/email", {
      origin: ORIGIN,
      body: { name: "Owner", email: ownerEmail, password: "readmeter-dev" },
    });
    assert.equal(ownerSign.status, 200, await ownerSign.clone().text());
    const ownerCookie = cookies(ownerSign);
    const created = await call(app, "POST", "/api/v1/workspaces", {
      cookie: ownerCookie,
      body: { name: "Owners", slug },
    });
    assert.equal(created.status, 201, await created.clone().text());

    const adminEmail = `admin-${suffix}@readmeter.test`;
    const adminInvite = await call(app, "POST", `/api/v1/workspaces/${slug}/invitations`, {
      cookie: ownerCookie,
      body: { email: adminEmail, role: "admin" },
    });
    assert.equal(adminInvite.status, 201, await adminInvite.clone().text());
    const adminInviteBody = (await adminInvite.json()) as { id: string };
    const adminSign = await call(app, "POST", "/api/auth/sign-up/email", {
      origin: ORIGIN,
      body: { name: "Admin", email: adminEmail, password: "readmeter-dev" },
    });
    const adminCookie = cookies(adminSign);
    const accepted = await call(app, "POST", "/api/auth/organization/accept-invitation", {
      origin: ORIGIN,
      cookie: adminCookie,
      body: { invitationId: adminInviteBody.id },
    });
    assert.equal(accepted.status, 200, await accepted.clone().text());

    const ownerGrant = await call(app, "POST", `/api/v1/workspaces/${slug}/invitations`, {
      cookie: adminCookie,
      body: { email: `nope-${suffix}@readmeter.test`, role: "owner" },
    });
    assert.equal(ownerGrant.status, 403);

    const listed = await call(app, "GET", `/api/v1/workspaces/${slug}/members`, { cookie: adminCookie });
    assert.equal(listed.status, 200, await listed.clone().text());
    const members = (await listed.json()) as { items: { id: string; role: string; user: { email: string } }[] };
    const owner = members.items.find((item) => item.user.email === ownerEmail);
    assert.ok(owner);
    const demote = await call(app, "PATCH", `/api/v1/workspaces/${slug}/members/${owner.id}`, {
      cookie: adminCookie,
      body: { role: "admin" },
    });
    assert.equal(demote.status, 403);
    const removed = await call(app, "DELETE", `/api/v1/workspaces/${slug}/members/${owner.id}`, {
      cookie: adminCookie,
    });
    assert.equal(removed.status, 403);

    const memberEmail = `member-${suffix}@readmeter.test`;
    const memberInvite = await call(app, "POST", `/api/v1/workspaces/${slug}/invitations`, {
      cookie: adminCookie,
      body: { email: memberEmail, role: "member" },
    });
    assert.equal(memberInvite.status, 201, await memberInvite.clone().text());
    const memberInviteBody = (await memberInvite.json()) as { id: string };
    const memberSign = await call(app, "POST", "/api/auth/sign-up/email", {
      origin: ORIGIN,
      body: { name: "Member", email: memberEmail, password: "readmeter-dev" },
    });
    const memberCookie = cookies(memberSign);
    assert.equal(
      (
        await call(app, "POST", "/api/auth/organization/accept-invitation", {
          origin: ORIGIN,
          cookie: memberCookie,
          body: { invitationId: memberInviteBody.id },
        })
      ).status,
      200,
    );
    const again = await call(app, "GET", `/api/v1/workspaces/${slug}/members`, { cookie: adminCookie });
    const rows = (await again.json()) as { items: { id: string; role: string; user: { email: string } }[] };
    const member = rows.items.find((item) => item.user.email === memberEmail);
    assert.ok(member);
    const promoted = await call(app, "PATCH", `/api/v1/workspaces/${slug}/members/${member.id}`, {
      cookie: adminCookie,
      body: { role: "admin" },
    });
    assert.equal(promoted.status, 200, await promoted.clone().text());

    const self = rows.items.find((item) => item.user.email === ownerEmail);
    const last = await call(app, "PATCH", `/api/v1/workspaces/${slug}/members/${self?.id}`, {
      cookie: ownerCookie,
      body: { role: "member" },
    });
    assert.equal(last.status, 409);

    const granted = await call(app, "POST", `/api/v1/workspaces/${slug}/invitations`, {
      cookie: ownerCookie,
      body: { email: `second-${suffix}@readmeter.test`, role: "owner" },
    });
    assert.equal(granted.status, 201, await granted.clone().text());
  } finally {
    await close();
  }
});

test("reset links stay out of the response unless the dev flag is on", { skip: !databaseUrl }, async () => {
  const { db, close } = connect(databaseUrl);
  const suffix = Math.random().toString(36).slice(2, 10);
  const email = `reset-${suffix}@readmeter.test`;
  try {
    const base = envFor();
    const mailer = createMailer(base);
    const app = createApp({ db, auth: createAuth(db, base, mailer), core: await loadCore(), env: base, mailer });
    const signed = await call(app, "POST", "/api/auth/sign-up/email", {
      origin: ORIGIN,
      body: { name: "Reset", email, password: "readmeter-dev" },
    });
    assert.equal(signed.status, 200, await signed.clone().text());

    const ask = (target: Hono) =>
      call(target, "POST", "/api/auth/request-password-reset", {
        origin: ORIGIN,
        body: { email, redirectTo: `${ORIGIN}/reset-password` },
      });

    const plain = await ask(app);
    assert.equal(plain.status, 200, await plain.clone().text());
    assert.equal("resetLink" in ((await plain.json()) as object), false);

    const flaggedEnv = envFor({ CONSOLE_DEV_RESET_LINKS: "1" });
    const flaggedMailer = createMailer(flaggedEnv);
    const flagged = createApp({
      db,
      auth: createAuth(db, flaggedEnv, flaggedMailer),
      core: await loadCore(),
      env: flaggedEnv,
      mailer: flaggedMailer,
    });
    const withLink = await ask(flagged);
    assert.equal(withLink.status, 200, await withLink.clone().text());
    const withBody = (await withLink.json()) as { resetLink?: string };
    assert.match(withBody.resetLink ?? "", /^https?:\/\//);

    const prodEnv = envFor({
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "production-secret-at-least-32-characters-long",
      CONSOLE_DEV_RESET_LINKS: "1",
    });
    const prodMailer = createMailer(prodEnv);
    const prod = createApp({
      db,
      auth: createAuth(db, prodEnv, prodMailer),
      core: await loadCore(),
      env: prodEnv,
      mailer: prodMailer,
    });
    const hidden = await ask(prod);
    assert.equal(hidden.status, 200, await hidden.clone().text());
    assert.equal("resetLink" in ((await hidden.json()) as object), false);
  } finally {
    await close();
  }
});
