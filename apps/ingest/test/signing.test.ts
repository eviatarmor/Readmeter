import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { bundleEtag, createApp } from "../src/app.ts";
import { generateSigningKey, loadSigner, SIGNATURE_HEADER, type BundleSigner } from "../src/signing.ts";
import { access, core, HASH_KEY, MemoryStore } from "./helpers.ts";

const KEY = "rm_test_key";
const base = new Uint8Array(readFileSync(new URL("../../../target/rules/bundle.bin", import.meta.url)));
const headers = { authorization: `Bearer ${KEY}` };

/** Verifies `ed25519:<b64>` over `bytes` with a raw base64 public key, as the SDK does. */
function verifies(header: string | null, bytes: Uint8Array, publicKey: string): boolean {
  if (!header?.startsWith("ed25519:")) return false;
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "base64")]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  return verify(null, bytes, key, Buffer.from(header.slice(8), "base64"));
}

async function appWith(store: MemoryStore, signer?: BundleSigner) {
  return createApp({ core: await core(), store, bundle: { body: base, etag: bundleEtag(base) }, signer });
}

test("seed and PEM keys load to the expected public key", () => {
  const { privateSeed, publicKey, keyId } = generateSigningKey();
  const fromSeed = loadSigner(privateSeed);
  assert.equal(fromSeed.publicKey, publicKey);
  assert.equal(fromSeed.keyId, keyId);
  assert.equal(Buffer.from(publicKey, "base64").length, 32);

  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const raw = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  assert.equal(loadSigner(pem).publicKey, raw.toString("base64"));

  assert.throws(() => loadSigner("not a key"));
  assert.throws(() => loadSigner(Buffer.alloc(16).toString("base64")));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" });
  assert.throws(() => loadSigner(rsa.toString()));
});

test("GET /v1/bundle carries a valid signature when a key is set", async () => {
  const signer = loadSigner(generateSigningKey().privateSeed);
  const app = await appWith(new MemoryStore({ [KEY]: access("proj_a") }), signer);
  const res = await app.request(new Request("http://x/v1/bundle", { headers }));
  assert.equal(res.status, 200);
  const body = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(body, base);
  const signature = res.headers.get(SIGNATURE_HEADER);
  assert.ok(verifies(signature, body, signer.publicKey));
  assert.ok(!verifies(signature, body.slice(1), signer.publicKey));

  const cached = await app.request(
    new Request("http://x/v1/bundle", { headers: { ...headers, "if-none-match": res.headers.get("etag") ?? "" } }),
  );
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get(SIGNATURE_HEADER), signature);
});

test("browsers can read the etag and signature headers", async () => {
  const signer = loadSigner(generateSigningKey().privateSeed);
  const app = await appWith(new MemoryStore({ [KEY]: access("proj_a") }), signer);
  const res = await app.request(new Request("http://x/v1/bundle", { headers: { ...headers, origin: "http://ok.test" } }));
  const exposed = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
  assert.ok(exposed.includes("etag"), exposed);
  assert.ok(exposed.includes(SIGNATURE_HEADER), exposed);
});

test("no signature header without a key", async () => {
  const app = await appWith(new MemoryStore({ [KEY]: access("proj_a") }));
  const res = await app.request(new Request("http://x/v1/bundle", { headers }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get(SIGNATURE_HEADER), null);
});

test("overrides change the bytes and the signature, and both are cached", async () => {
  const signer = loadSigner(generateSigningKey().privateSeed);
  const store = new MemoryStore({ [KEY]: access("proj_a") });
  const app = await appWith(store, signer);
  const get = async () => {
    const res = await app.request(new Request("http://x/v1/bundle", { headers }));
    return {
      body: new Uint8Array(await res.arrayBuffer()),
      etag: res.headers.get("etag"),
      sig: res.headers.get(SIGNATURE_HEADER),
    };
  };
  const plain = await get();

  store.overrides = [
    {
      rule: "firebase.firestore/unbounded-list",
      enabled: false,
      severity: null,
      params: null,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  ];
  const tuned = await get();
  assert.notDeepEqual(tuned.body, plain.body);
  assert.notEqual(tuned.etag, plain.etag);
  assert.notEqual(tuned.sig, plain.sig);
  assert.ok(verifies(tuned.sig, tuned.body, signer.publicKey));
  assert.deepEqual(await get(), tuned);

  store.overrides = [];
  assert.deepEqual(await get(), plain);
});

test("GET /v1/config exposes the bundle public key only when signing", async () => {
  const signer = loadSigner(generateSigningKey().privateSeed);
  const store = new MemoryStore({ [KEY]: access("proj_a") });
  const signed = await (await appWith(store, signer)).request(new Request("http://x/v1/config", { headers }));
  assert.deepEqual(await signed.json(), {
    project: "proj_a",
    hash_key: HASH_KEY,
    bundle_public_key: signer.publicKey,
    bundle_key_id: signer.keyId,
  });
  const plain = await (await appWith(store)).request(new Request("http://x/v1/config", { headers }));
  assert.deepEqual(await plain.json(), { project: "proj_a", hash_key: HASH_KEY });
});
