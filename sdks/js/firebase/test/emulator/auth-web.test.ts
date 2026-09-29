/**
 * Web drop-in against the Auth emulator (port 9099).
 * Node's auth build stubs phone sign-in; that error is recorded and is not an SMS.
 * Platform is forced to browser so memory persistence can fire.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";

import { flush, init, shutdown, type Finding } from "../../src/index.ts";
import * as auth from "../../src/web/auth.ts";
import { HASH_KEY, bundleBytes } from "../bundle.ts";

const raw: Record<string, unknown>[] = [];
const findings: Finding[] = [];

function emulatorUrl(): string {
  const rawHost = (process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099").replace(/^https?:\/\//, "");
  const [host, portText] = rawHost.split(":");
  const port = Number(portText);
  if (!host || port !== 9099) {
    throw new Error(`Auth emulator must be 127.0.0.1:9099 (FIREBASE_AUTH_EMULATOR_HOST=${rawHost})`);
  }
  return `http://${host}:${port}`;
}

function calls(): Record<string, unknown>[] {
  return raw.filter((call) => call.service === "auth");
}

function assertRule(rule: string): void {
  assert.ok(
    findings.some((finding) => finding.rule === rule),
    `missing ${rule}; have ${findings.map((finding) => finding.rule).join(", ")}`,
  );
}

async function boot(): Promise<void> {
  init({
    apiKey: "rm_test",
    endpoint: "http://127.0.0.1:9",
    hashKey: HASH_KEY,
    bundle: bundleBytes(),
    dev: true,
    debug: true,
    platform: "browser",
    onFinding(finding) {
      findings.push(finding);
    },
  });
  await flush();
  raw.length = 0;
  findings.length = 0;
}

test("web drop-in records Authentication and fires the client rules", { timeout: 180_000 }, async () => {
  const original = console.debug;
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") {
      raw.push(JSON.parse(args[1]) as Record<string, unknown>);
    }
  };

  const app: FirebaseApp = initializeApp({ apiKey: "demo", projectId: "demo-readmeter" }, "readmeter-auth-web");
  const userAuth = auth.getAuth(app);
  auth.connectAuthEmulator(userAuth, emulatorUrl(), { disableWarnings: true });

  const email = "leak.check@example.com";
  const phone = "+15555550123";
  const password = "super-secret-password";

  try {
    await boot();
    await auth.setPersistence(userAuth, auth.inMemoryPersistence);
    const memory = calls().find((call) => call.op === "init" && call.method === "setPersistence");
    assert.ok(memory, "setPersistence was not recorded");
    assert.equal(memory.persistence, "NONE");
    assertRule("firebase.auth/memory-persistence");

    await auth.signInAnonymously(userAuth);
    await auth.signOut(userAuth);
    const second = await auth.signInAnonymously(userAuth);
    assert.equal(second.user.isAnonymous, true);
    assertRule("firebase.auth/anonymous-user-churn");
    const anon = calls().filter((call) => call.op === "sign_in_anonymous");
    assert.equal(anon.length, 2);

    const before = calls().filter((call) => call.op === "token_refresh").length;
    for (let i = 0; i < 5; i += 1) {
      const token = await auth.getIdToken(second.user, true);
      assert.equal(typeof token, "string");
      assert.equal(token.length > 0, true);
    }
    const refreshes = calls().filter((call) => call.op === "token_refresh");
    assert.equal(refreshes.length - before, 5);
    assert.equal(refreshes.every((call) => call.force === true), true);
    assertRule("firebase.auth/id-token-refresh-storm");

    for (let i = 0; i < 20; i += 1) auth.onAuthStateChanged(userAuth, () => {});
    const subs = calls().filter((call) => call.op === "subscribe" && call.method === "onAuthStateChanged");
    const unsubs = calls().filter((call) => call.op === "unsubscribe");
    assert.equal(subs.length, 20);
    assert.equal(unsubs.length, 0);
    assertRule("generic/listener-leak");

    await assert.rejects(auth.signInWithPhoneNumber(userAuth, phone, { type: "recaptcha", verify: () => Promise.resolve("skip") }));
    const phones = calls().filter((call) => call.op === "phone");
    assert.equal(phones.length, 1);
    assert.equal(typeof phones[0]?.error, "string");
    assert.equal(findings.some((finding) => finding.rule === "firebase.auth/phone-auth-retry"), false);

    const created = await auth.createUserWithEmailAndPassword(userAuth, email, password);
    const dumped = JSON.stringify(calls());
    assert.equal(dumped.includes(email), false);
    assert.equal(dumped.includes(phone), false);
    assert.equal(dumped.includes(password), false);
    assert.equal(dumped.includes(created.user.uid), false);
    const token = await auth.getIdToken(created.user, true);
    assert.equal(JSON.stringify(calls()).includes(token), false);
  } finally {
    console.debug = original;
    await flush();
    await shutdown();
    await deleteApp(app);
  }
});
