/**
 * Web drop-in against the Cloud Storage emulator (port 9199).
 * Sizes match the conformance fixtures: 1000-object listAll, 5 download
 * URLs, 3 uncached downloads, an image over 1 MiB, and an upload over 5 MiB.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";

import { flush, init, shutdown, type Finding } from "../../src/index.ts";
import * as storage from "../../src/web/storage.ts";
import { HASH_KEY, bundleBytes } from "../bundle.ts";

const BUCKET = "gs://demo-readmeter.appspot.com";
const raw: Record<string, unknown>[] = [];
const findings: Finding[] = [];

function emulatorAddress(): { host: string; port: number } {
  const rawHost = (process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? "127.0.0.1:9199").replace(/^https?:\/\//, "");
  const [host, portText] = rawHost.split(":");
  const port = Number(portText);
  if (!host || port !== 9199) {
    throw new Error(`Cloud Storage emulator must be 127.0.0.1:9199 (FIREBASE_STORAGE_EMULATOR_HOST=${rawHost})`);
  }
  return { host, port };
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

async function seedPrefix(root: storage.FirebaseStorage, prefix: string, count: number): Promise<void> {
  const chunk = 40;
  for (let start = 0; start < count; start += chunk) {
    const jobs: Promise<unknown>[] = [];
    const end = Math.min(count, start + chunk);
    for (let i = start; i < end; i += 1) {
      jobs.push(storage.uploadBytes(storage.ref(root, `${prefix}/${i}.txt`), new Uint8Array([120])));
    }
    await Promise.all(jobs);
  }
}

test("web drop-in records Cloud Storage and fires the fixture rules", { timeout: 300_000 }, async () => {
  const original = console.debug;
  console.debug = (...args: unknown[]) => {
    if (args[0] === "[readmeter] raw" && typeof args[1] === "string") {
      raw.push(JSON.parse(args[1]) as Record<string, unknown>);
    }
  };

  const { host, port } = emulatorAddress();
  const app: FirebaseApp = initializeApp({ apiKey: "demo", projectId: "demo-readmeter" }, "readmeter-storage-web");
  const bucket = storage.getStorage(app, BUCKET);
  storage.connectStorageEmulator(bucket, host, port);

  try {
    await boot();
    await storage.uploadBytes(storage.ref(bucket, "bootstrap/keep.txt"), new Uint8Array([1]));

    const page = await storage.list(storage.ref(bucket, "unused-unbounded"));
    assert.equal(page.items.length, 0);
    const listed = calls().find((call) => call.op === "list" && call.path === "unused-unbounded");
    assert.ok(listed, "list() was not recorded");
    assert.equal(listed.max_results, undefined);
    assert.equal(JSON.stringify(listed).includes("http"), false);

    const hero = storage.ref(bucket, "photos/hero.png");
    await storage.uploadBytes(hero, new Uint8Array([1, 2, 3]), { contentType: "image/png" });
    for (let i = 0; i < 5; i += 1) {
      const url = await storage.getDownloadURL(hero);
      assert.equal(url.startsWith("http"), true);
    }
    const urls = calls().filter((call) => call.op === "download_url");
    assert.equal(urls.length, 5);
    assert.equal(JSON.stringify(urls).includes("http"), false);

    const data = storage.ref(bucket, "files/data.bin");
    await storage.uploadBytes(data, new Uint8Array(100), { cacheControl: "no-cache" });
    const meta = await storage.getMetadata(data);
    assert.equal(typeof meta.size, "number");
    const metaCall = calls().find((call) => call.op === "get_metadata" && call.path === "files/data.bin");
    assert.ok(metaCall);
    assert.equal(metaCall.cache_control, "none");
    const metaResult = metaCall.result as { items?: number; bytes?: number };
    assert.equal(metaResult.items, 0);
    for (let i = 0; i < 3; i += 1) {
      const bytes = await storage.getBytes(data);
      assert.equal(bytes.byteLength, 100);
    }

    const photo = new Uint8Array(1_048_577);
    photo[0] = 9;
    await storage.uploadBytes(storage.ref(bucket, "photos/photo.png"), photo, { contentType: "image/png" });
    const downloaded = await storage.getBytes(storage.ref(bucket, "photos/photo.png"));
    assert.equal(downloaded.byteLength, photo.byteLength);
    const imageCall = calls().find((call) => call.op === "download" && call.path === "photos/photo.png");
    assert.equal(imageCall?.bytes, photo.byteLength);
    assert.equal(imageCall?.content_type, undefined);

    const big = new Uint8Array(5_242_881);
    await storage.uploadBytes(storage.ref(bucket, "videos/clip.bin"), big);
    const upload = calls().find((call) => call.op === "upload" && call.path === "videos/clip.bin");
    assert.equal(upload?.resumable, false);
    assert.equal(upload?.bytes, big.byteLength);

    const streamRef = storage.ref(bucket, "files/stream.bin");
    await storage.uploadBytes(streamRef, new Uint8Array([4, 5, 6, 7]));
    const stream = storage.getStream(streamRef);
    const reader = stream.getReader();
    let streamed = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      streamed += next.value.byteLength;
    }
    assert.equal(streamed, 4);
    assert.ok(calls().some((call) => call.op === "download" && call.path === "files/stream.bin"));

    const task = storage.uploadBytesResumable(storage.ref(bucket, "files/resume.bin"), new Uint8Array([8]));
    assert.equal(typeof task.on, "function");
    await task;
    const resumed = calls().find((call) => call.op === "upload" && call.path === "files/resume.bin");
    assert.equal(resumed?.resumable, true);

    await seedPrefix(bucket, "bulk", 1000);
    const all = await storage.listAll(storage.ref(bucket, "bulk"));
    assert.equal(all.items.length, 1000);
    const listAll = calls().find((call) => call.op === "list_all" && call.path === "bulk");
    const listResult = listAll?.result as { items?: number } | undefined;
    assert.equal(listResult?.items, 1000);

    await storage.updateMetadata(data, { cacheControl: "public, max-age=60" });
    const updated = calls().find((call) => call.op === "update_metadata" && call.path === "files/data.bin");
    assert.equal(updated?.cache_control, 60);
    await storage.deleteObject(storage.ref(bucket, "bootstrap/keep.txt"));
    assert.ok(calls().some((call) => call.op === "delete" && call.path === "bootstrap/keep.txt"));

    await flush();

    assertRule("firebase.storage/unbounded-list-page");
    assertRule("firebase.storage/download-url-per-render");
    assertRule("firebase.storage/redownload-without-cache-control");
    assertRule("firebase.storage/original-size-images");
    assertRule("firebase.storage/upload-without-resumable");
    assertRule("firebase.storage/list-all-large-prefix");

    const dump = JSON.stringify(calls());
    assert.equal(dump.includes("http"), false, dump);
    assert.equal(dump.includes("appspot"), false, dump);
    assert.equal(dump.includes("googleapis"), false, dump);
    assert.equal(dump.includes("downloadTokens"), false, dump);
  } finally {
    console.debug = original;
    await shutdown();
    await deleteApp(app);
  }
});
