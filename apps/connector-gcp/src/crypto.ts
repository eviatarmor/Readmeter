import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;

export interface SealedKey {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** `READMETER_SECRET_KEY` is 32 raw bytes, base64. Unset is null; a bad length throws. */
export function decodeSecretKey(value: string | undefined): Buffer | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  const buf = Buffer.from(trimmed, "base64");
  if (buf.length !== 32) {
    throw new Error("READMETER_SECRET_KEY must decode to exactly 32 bytes");
  }
  return buf;
}

export function secretKeyError(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "Set READMETER_SECRET_KEY to 32 bytes, base64-encoded, before connecting Google Cloud.";
  }
  try {
    decodeSecretKey(trimmed);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "READMETER_SECRET_KEY is invalid";
  }
}

export function encryptSecret(plaintext: string, key: Buffer): SealedKey {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptSecret(sealed: SealedKey, key: Buffer): string {
  if (!sealed.iv || !sealed.tag) throw new Error("stored key is missing its IV or tag");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

/** Drop credential material if a client library echoes the request. */
export function publicError(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : "request failed";
  for (const secret of secrets) {
    if (secret.length >= 8) message = message.split(secret).join("[redacted]");
  }
  message = message.replace(/-----BEGIN[\s\S]*?-----END [A-Z ]*-----/g, "[redacted]");
  if (message.length > 500) message = `${message.slice(0, 500)}…`;
  return message;
}
