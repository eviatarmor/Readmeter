import { randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Unbiased base62. Bytes >= 248 are rejected so the modulo stays uniform. */
export function randomBase62(length: number): string {
  const chars: string[] = [];
  while (chars.length < length) {
    const bytes = randomBytes(length);
    for (const byte of bytes) {
      if (byte >= 248) continue;
      chars.push(BASE62[byte % 62]!);
      if (chars.length === length) break;
    }
  }
  return chars.join("");
}

export function randomHashKey(): string {
  return randomBytes(16).toString("hex");
}

/**
 * `rm_live_` plus 32 base62 characters. The stored prefix is the first 16:
 * `rm_live_` is already 8 characters, so a shorter prefix would be identical
 * for every live key.
 */
export function newLiveKey(): { apiKey: string; prefix: string } {
  const apiKey = `rm_live_${randomBase62(32)}`;
  return { apiKey, prefix: apiKey.slice(0, 16) };
}
