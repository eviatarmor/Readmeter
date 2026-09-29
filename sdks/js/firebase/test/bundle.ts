import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HASH_KEY = "000102030405060708090a0b0c0d0e0f";

export function bundleBytes(): Uint8Array {
  const path = fileURLToPath(new URL("../bundle/bundle.bin", import.meta.url));
  return new Uint8Array(readFileSync(path));
}
