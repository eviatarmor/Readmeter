/**
 * Admin SDK against the Cloud Storage emulator (port 9199).
 * One save must not also record the createWriteStream it uses.
 * Server downloads of a large image must not fire original-size-images.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

import { instrumentStorage } from "../../src/admin/index.ts";
import { flush, init, shutdown, type Finding } from "../../src/index.ts";
import { HASH_KEY, bundleBytes } from "../bundle.ts";

const raw: Record<string, unknown>[] = [];
const findings: Finding[] = [];

function assertEmulator(): void {
  const host = process.env.STORAGE_EMULATOR_HOST ?? process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? "";
  if (!host.includes("9199")) {
    throw new Error(`Cloud Storage emulator must be on port 9199 (${host || "unset"})`);
  }
}

function calls(): Record<string, unknown>[] {
  return raw.filter((call) => call.service === "storage");
}

function assertRule(rule: string): void {
  assert.ok(
    findings.some((finding) => finding.rule === rule),
    `missing ${rule}; have ${findings.map((finding) => finding.rule).join(", ")}`,
  );
}

test("admin prototype patch records Cloud Storage calls", { timeout: 180_000 }, async () => {
  const original = console.debug;
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") {
      raw.push(JSON.parse(args[1]) as Record<string, unknown>);
    }
  };

  assertEmulator();
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

  const app: App = initializeApp({ projectId: "demo-readmeter", storageBucket: "demo-readmeter.appspot.com" }, "readmeter-storage-admin");
  const bucket = instrumentStorage(getStorage(app).bucket("demo-readmeter.appspot.com"));

  try {
    const once = bucket.file("admin/once.txt");
    await once.save(Buffer.from("hello"), { resumable: false });
    const onceUploads = calls().filter((call) => call.op === "upload" && call.path === "admin/once.txt");
    assert.equal(onceUploads.length, 1);
    assert.equal(onceUploads[0]?.bytes, 5);
    assert.equal(onceUploads[0]?.resumable, false);

    await new Promise<void>((resolve, reject) => {
      bucket.file("admin/cb.txt").save(Buffer.from("cb"), { resumable: false }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    const cbUploads = calls().filter((call) => call.op === "upload" && call.path === "admin/cb.txt");
    assert.equal(cbUploads.length, 1);

    await new Promise<void>((resolve, reject) => {
      const stream = bucket.file("admin/stream.txt").createWriteStream({ resumable: false });
      stream.on("error", reject);
      stream.on("finish", () => resolve());
      stream.end(Buffer.from("abcdef"));
    });
    const streamed = calls().filter((call) => call.op === "upload" && call.path === "admin/stream.txt");
    assert.equal(streamed.length, 1);
    assert.equal(streamed[0]?.bytes, 6);
    assert.equal(streamed[0]?.resumable, false);

    const [buf] = await once.download();
    assert.equal(buf.toString(), "hello");
    const download = calls().find((call) => call.op === "download" && call.path === "admin/once.txt");
    assert.equal(download?.bytes, 5);

    const [meta] = await once.getMetadata();
    assert.ok(meta);
    const metaCall = calls().find((call) => call.op === "get_metadata" && call.path === "admin/once.txt");
    assert.ok(metaCall);
    assert.equal((metaCall.result as { items?: number }).items, 0);

    await bucket.getFiles({ autoPaginate: false, prefix: "admin/" });
    const listed = calls().filter((call) => call.op === "list");
    assert.ok(listed.length >= 1);
    assert.equal(listed[0]?.max_results, undefined);
    assert.equal(typeof listed[0]?.page_token === "string", false);

    await bucket.file("admin/big.bin").save(Buffer.alloc(5_242_881, 1), { resumable: false });
    const photo = bucket.file("photos/photo.png");
    await photo.save(Buffer.alloc(1_048_577, 2), {
      resumable: true,
      metadata: { contentType: "image/png" },
    });
    const [image] = await photo.download();
    assert.equal(image.length, 1_048_577);

    try {
      await once.getSignedUrl({ version: "v4", action: "read", expires: Date.now() + 60_000 });
    } catch {
      // The emulator has no signing keys. The attempt is still recorded.
    }
    assert.ok(calls().some((call) => call.op === "signed_url" && call.path === "admin/once.txt"));

    await once.delete({ ignoreNotFound: true });
    assert.ok(calls().some((call) => call.op === "delete" && call.path === "admin/once.txt"));

    await flush();
    assertRule("firebase.storage/unbounded-list-page");
    assertRule("firebase.storage/upload-without-resumable");
    assert.equal(
      findings.some((finding) => finding.rule === "firebase.storage/original-size-images"),
      false,
    );

    const dump = JSON.stringify(calls());
    assert.equal(dump.includes("http"), false, dump);
    assert.equal(dump.includes("appspot"), false, dump);
    assert.equal(dump.includes("googleapis"), false, dump);
  } finally {
    console.debug = original;
    await shutdown();
    await deleteApp(app);
  }
});
