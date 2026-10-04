import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import { bundleEtag, loadCachedBundle, refreshBundle, resolveBundle, verifyBundle } from "../src/core/bundle.ts";
import { init, shutdown } from "../src/index.ts";
import { bundleBytes } from "./bundle.ts";

const { privateKey, publicKey: publicKeyObject } = generateKeyPairSync("ed25519");
const publicKey = publicKeyObject.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const otherKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

const signed = (bytes: Uint8Array) => `ed25519:${sign(null, bytes, privateKey).toString("base64")}`;

/** A bundle that differs from the packaged one, as a project with overrides would get. */
const served = new Uint8Array([...bundleBytes(), 0]);

function respond(bytes: Uint8Array, signature?: string): typeof fetch {
  return (async () => {
    const headers: Record<string, string> = { etag: await bundleEtag(bytes) };
    if (signature !== undefined) headers["x-readmeter-signature"] = signature;
    return new Response(new Uint8Array(bytes), { status: 200, headers });
  }) as typeof fetch;
}

const refresh = (fetchFn: typeof fetch, key?: string) =>
  refreshBundle({ endpoint: "http://ingest.test", apiKey: "k", etag: "none", publicKey: key, fetchFn });

let previous: string | undefined;
beforeEach(() => {
  previous = process.env.READMETER_BUNDLE_CACHE;
  process.env.READMETER_BUNDLE_CACHE = mkdtempSync(path.join(tmpdir(), "readmeter-sig-"));
});
afterEach(() => {
  if (previous === undefined) delete process.env.READMETER_BUNDLE_CACHE;
  else process.env.READMETER_BUNDLE_CACHE = previous;
});

test("verifyBundle accepts a valid signature and rejects tampering", async () => {
  assert.equal(await verifyBundle(served, signed(served), publicKey), true);
  const tampered = new Uint8Array(served);
  tampered[0] = (tampered[0] ?? 0) ^ 1;
  assert.equal(await verifyBundle(tampered, signed(served), publicKey), false);
  assert.equal(await verifyBundle(served, signed(served), otherKey), false);
  assert.equal(await verifyBundle(served, undefined, publicKey), false);
  assert.equal(await verifyBundle(served, "ed25519:!!!", publicKey), false);
  assert.equal(await verifyBundle(served, signed(served).slice(8), publicKey), false);
});

test("a validly signed bundle is cached with its signature and used on the next start", async () => {
  await refresh(respond(served, signed(served)), publicKey);
  const cached = await loadCachedBundle();
  assert.deepEqual(cached?.bytes, served);
  assert.equal(cached?.signature, signed(served));
  const loaded = await resolveBundle({ publicKey });
  assert.deepEqual(loaded.bytes, served);
});

test("tampered bytes are rejected and the packaged bundle is kept", async () => {
  const tampered = new Uint8Array(served);
  tampered[tampered.length - 1] = 7;
  await assert.rejects(refresh(respond(tampered, signed(served)), publicKey), /signature/);
  assert.equal(await loadCachedBundle(), undefined);
  assert.deepEqual((await resolveBundle({ publicKey })).bytes, bundleBytes());
});

test("a missing signature header is rejected when a key is set", async () => {
  await assert.rejects(refresh(respond(served), publicKey), /signature/);
  assert.deepEqual((await resolveBundle({ publicKey })).bytes, bundleBytes());
});

test("a cached bundle without a valid signature is skipped on load", async () => {
  // Cached by a start without a key; a later start with a key must re-verify.
  await refresh(respond(served));
  assert.deepEqual((await resolveBundle({})).bytes, served);
  assert.deepEqual((await resolveBundle({ publicKey })).bytes, bundleBytes());

  await refresh(respond(served, signed(served)));
  assert.deepEqual((await resolveBundle({ publicKey: otherKey })).bytes, bundleBytes());
  assert.deepEqual((await resolveBundle({ publicKey })).bytes, served);
});

test("without a key, unsigned bundles are cached and used as before", async () => {
  await refresh(respond(served));
  const cached = await loadCachedBundle();
  assert.deepEqual(cached?.bytes, served);
  assert.equal(cached?.signature, undefined);
  assert.deepEqual((await resolveBundle({})).bytes, served);
});

test("init({ bundle }) wins over cache and needs no signature", async () => {
  const explicit = new Uint8Array([1, 2, 3]);
  assert.deepEqual((await resolveBundle({ bundle: explicit, publicKey })).bytes, explicit);
});

test("init rejects a malformed bundlePublicKey without throwing", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => {
    lines.push(String(message));
  };
  try {
    assert.doesNotThrow(() => init({ apiKey: "k", endpoint: "http://127.0.0.1:9", bundlePublicKey: "abc" }));
    await shutdown();
    assert.ok(
      lines.some((line) => line.includes("bundlePublicKey must be") && line.includes("disabled")),
      lines.join("\n"),
    );
  } finally {
    console.error = original;
  }
});
