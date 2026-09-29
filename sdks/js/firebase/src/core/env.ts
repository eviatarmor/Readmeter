import type { Platform } from "../types.ts";

export function isNode(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}

/** Browser when both `window` and `document` exist; otherwise a server runtime. */
export function detectPlatform(): Exclude<Platform, "mobile"> {
  const g = globalThis as { window?: unknown; document?: unknown };
  if (g.window != null && g.document != null) return "browser";
  return "server";
}
