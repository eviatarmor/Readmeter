/**
 * Firestore trigger patterns for `trigger-cascade`. A trigger event names a
 * concrete document (`posts/abc`) and the params it matched (`{ id: "abc" }`).
 * Every id position whose value is a param value becomes a wildcard, which
 * gives back `posts/{id}` without seeing the registration. The pattern lives
 * only for one invocation and never leaves the process.
 */

/** Document path segments; `null` is a wildcard. */
export type TriggerPattern = readonly (string | null)[];

/** Firestore allows 100 path segments. */
const MAX_SEGMENTS = 100;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** `projects/p/databases/d/documents/posts/abc` or `posts/abc` → `posts/abc`. */
function documentPath(raw: string): string {
  const marker = "/documents/";
  const at = raw.indexOf(marker);
  if (at >= 0) return raw.slice(at + marker.length);
  return raw.startsWith("documents/") ? raw.slice("documents/".length) : raw;
}

function segments(path: string): string[] | undefined {
  const parts = path.split("/");
  if (parts.length < 2 || parts.length > MAX_SEGMENTS || parts.length % 2 !== 0) return undefined;
  for (const part of parts) if (part.length === 0) return undefined;
  return parts;
}

function refPath(value: unknown): string | undefined {
  const ref = asRecord(asRecord(value)?.ref);
  return typeof ref?.path === "string" ? ref.path : undefined;
}

function isFirestoreType(value: unknown): boolean {
  return typeof value !== "string" || value.toLowerCase().includes("firestore");
}

/** v2 CloudEvent: `{ document: "posts/abc", params: { id: "abc" } }`. */
function v2(event: unknown): { path: string; params: Record<string, unknown> } | undefined {
  const rec = asRecord(event);
  const params = asRecord(rec?.params);
  if (!rec || !params || typeof rec.document !== "string" || !isFirestoreType(rec.type)) return undefined;
  return { path: rec.document, params };
}

/** v1: `(snapshot | change, context)` with `context.params` and a document ref. */
function v1(data: unknown, context: unknown): { path: string; params: Record<string, unknown> } | undefined {
  const ctx = asRecord(context);
  const params = asRecord(ctx?.params);
  if (!ctx || !params || typeof ctx.eventType !== "string" || !isFirestoreType(ctx.eventType)) return undefined;
  const change = asRecord(data);
  let path = refPath(data) ?? refPath(change?.after) ?? refPath(change?.before);
  if (path === undefined) {
    const resource = typeof ctx.resource === "string" ? ctx.resource : asRecord(ctx.resource)?.name;
    if (typeof resource === "string" && resource.includes("/documents/")) path = resource;
  }
  return path === undefined ? undefined : { path, params };
}

/**
 * The trigger pattern for a handler's arguments, or `undefined` when they
 * are not a Firestore trigger event. Never throws.
 */
export function triggerPattern(args: readonly unknown[]): TriggerPattern | undefined {
  try {
    const event = v2(args[0]) ?? v1(args[0], args[1]);
    if (!event) return undefined;
    const parts = segments(documentPath(event.path));
    if (!parts) return undefined;
    const values = new Set<string>();
    for (const value of Object.values(event.params)) if (typeof value === "string") values.add(value);
    return parts.map((part, index) => (index % 2 === 1 && values.has(part) ? null : part));
  } catch {
    return undefined;
  }
}

/** True when `path` has as many segments as `pattern` and every literal segment is equal. */
export function matchesTrigger(pattern: TriggerPattern, path: string): boolean {
  if (typeof path !== "string") return false;
  const parts = path.split("/");
  if (parts.length !== pattern.length) return false;
  for (let index = 0; index < parts.length; index += 1) {
    const want = pattern[index];
    if (want !== null && want !== parts[index]) return false;
  }
  return true;
}
