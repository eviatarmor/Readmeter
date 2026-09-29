/**
 * Admin Auth against the Auth emulator (port 9099).
 * `listUsers` inside `withFlush` fires once per invocation.
 * `createUser` is not recorded. Uids and tokens stay off the record.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

import { instrumentAuth, withFlush } from "../../src/admin/index.ts";
import { flush, init, shutdown, type Finding } from "../../src/index.ts";
import { HASH_KEY, bundleBytes } from "../bundle.ts";

const raw: Record<string, unknown>[] = [];
const findings: Finding[] = [];

function assertEmulator(): string {
  const host = (process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "").replace(/^https?:\/\//, "");
  if (!host.endsWith(":9099")) throw new Error(`Auth emulator must be on port 9099 (${host || "unset"})`);
  return host;
}

function calls(): Record<string, unknown>[] {
  return raw.filter((call) => call.service === "auth");
}

function assertRule(rule: string): Finding[] {
  const matched = findings.filter((finding) => finding.rule === rule);
  assert.ok(matched.length > 0, `missing ${rule}; have ${findings.map((finding) => finding.rule).join(", ")}`);
  return matched;
}

test("admin auth records observations and listUsers per request", { timeout: 180_000 }, async () => {
  const original = console.debug;
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") {
      raw.push(JSON.parse(args[1]) as Record<string, unknown>);
    }
  };

  const emulator = assertEmulator();
  init({
    apiKey: "rm_test",
    endpoint: "http://127.0.0.1:9",
    hashKey: HASH_KEY,
    bundle: bundleBytes(),
    dev: true,
    debug: true,
    platform: "server",
    onFinding(finding) {
      findings.push(finding);
    },
  });
  await flush();
  raw.length = 0;
  findings.length = 0;

  const app: App = initializeApp({ projectId: "demo-readmeter" }, "readmeter-auth-admin");
  const auth = instrumentAuth(getAuth(app));
  const email = "admin-leak.check@example.com";
  const phone = "+15555550123";

  try {
    const created = await auth.createUser({ email, password: "super-secret-password" });
    assert.equal(calls().some((call) => call.method === "createUser"), false);
    // firebase-admin createUser loads the new record with getUser. That lookup is recorded.
    assert.equal(calls().filter((call) => call.op === "get_user").length, 1);

    await auth.getUser(created.uid);
    const got = calls().filter((call) => call.op === "get_user");
    assert.equal(got.length, 2);
    assert.equal(got.every((call) => call.invocation === undefined), true);

    await auth.setCustomUserClaims(created.uid, { role: "member" });
    assert.equal(calls().filter((call) => call.op === "set_claims").length, 1);

    const custom = await auth.createCustomToken(created.uid);
    assert.equal(calls().filter((call) => call.op === "custom_token").length, 1);
    assert.equal(JSON.stringify(calls()).includes(custom), false);

    const exchanged = await fetch(`http://${emulator}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: custom, returnSecureToken: true }),
    });
    assert.equal(exchanged.ok, true);
    const body = (await exchanged.json()) as { idToken?: string };
    assert.equal(typeof body.idToken, "string");
    await auth.verifyIdToken(body.idToken ?? "");
    assert.equal(calls().filter((call) => call.op === "verify_id_token").length, 1);
    assert.equal(JSON.stringify(calls()).includes(body.idToken ?? "missing-token"), false);

    await auth.listUsers(1);
    const outside = calls().filter((call) => call.op === "list_users");
    assert.equal(outside.length, 1);
    assert.equal(outside[0]?.invocation, undefined);
    assert.equal(findings.some((finding) => finding.rule === "firebase.auth/server-list-users-in-request"), false);

    const listed = withFlush(async () => {
      const first = await auth.listUsers(1);
      if (first.pageToken) await auth.listUsers(1, first.pageToken);
      return first.users.length;
    });
    await listed();
    const firstHit = assertRule("firebase.auth/server-list-users-in-request");
    assert.equal(firstHit.length, 1);
    const inside = calls().filter((call) => call.op === "list_users" && call.invocation !== undefined);
    assert.ok(inside.length >= 1);
    assert.equal(inside.every((call) => call.invocation === inside[0]?.invocation), true);

    await withFlush(async () => {
      await auth.listUsers(1);
    })();
    assert.equal(assertRule("firebase.auth/server-list-users-in-request").length, 2);

    const dumped = JSON.stringify(calls());
    assert.equal(dumped.includes(email), false);
    assert.equal(dumped.includes(phone), false);
    assert.equal(dumped.includes(created.uid), false);
    const pageTokens = calls()
      .map((call) => call.page_token)
      .filter((value) => value !== undefined);
    assert.equal(pageTokens.every((value) => value === true || value === false), true);
  } finally {
    console.debug = original;
    await flush();
    await shutdown();
    await deleteApp(app);
  }
});
