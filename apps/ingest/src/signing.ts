// Ed25519 signatures over the SDK rule bundle bytes.
//
// `READMETER_BUNDLE_SIGNING_KEY` holds the private key, either as a base64
// 32-byte seed (what `readmeter bundle-keygen` prints) or as a PKCS#8 PEM
// (`openssl genpkey -algorithm ed25519`). SDKs verify with the raw 32-byte
// public key, base64, passed as `init({ bundlePublicKey })`.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/** Header ingest sets on `GET /v1/bundle`: `ed25519:<base64 signature>`. */
export const SIGNATURE_HEADER = "x-readmeter-signature";

// PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410): the DER prefix is fixed.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface BundleSigner {
  /** Raw 32-byte public key, base64. */
  publicKey: string;
  /** First 16 hex chars of the SHA-256 of the raw public key. */
  keyId: string;
  /** Raw 64-byte Ed25519 signature over `bytes`. */
  signRaw(bytes: Uint8Array): Buffer;
  /** Header value: `ed25519:<base64 signature>`. */
  sign(bytes: Uint8Array): string;
}

function privateKeyFrom(value: string): KeyObject {
  const text = value.trim();
  if (text.includes("-----BEGIN")) {
    const key = createPrivateKey({ key: text, format: "pem" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("bundle signing key must be an Ed25519 key");
    return key;
  }
  const seed = Buffer.from(text, "base64");
  if (seed.length !== 32 || seed.toString("base64").replace(/=+$/, "") !== text.replace(/=+$/, "")) {
    throw new Error("bundle signing key must be a base64 32-byte Ed25519 seed or a PKCS#8 PEM");
  }
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

/** Raw 32-byte public key: the tail of the SPKI DER encoding. */
function rawPublicKey(key: KeyObject): Buffer {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32);
}

export function keyId(rawPublic: Uint8Array): string {
  return createHash("sha256").update(rawPublic).digest("hex").slice(0, 16);
}

/** Throws on a malformed key so ingest fails at start, not on first request. */
export function loadSigner(value: string): BundleSigner {
  const key = privateKeyFrom(value);
  const raw = rawPublicKey(key);
  const signRaw = (bytes: Uint8Array) => sign(null, bytes, key);
  return {
    publicKey: raw.toString("base64"),
    keyId: keyId(raw),
    signRaw,
    sign: (bytes) => `ed25519:${signRaw(bytes).toString("base64")}`,
  };
}

/** New key pair: the base64 seed for `READMETER_BUNDLE_SIGNING_KEY` and the raw public key. */
export function generateSigningKey(): { privateSeed: string; publicKey: string; keyId: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const seed = der.subarray(der.length - 32);
  const raw = rawPublicKey(privateKey);
  return { privateSeed: seed.toString("base64"), publicKey: raw.toString("base64"), keyId: keyId(raw) };
}
