/**
 * Realtime Database "Using an unspecified index" warnings.
 *
 * `@firebase/database` 1.1.5 checks each listen response for `no_index`
 * (`PersistentConnection.warnOnListenWarnings_`) and calls
 * `warn("Using an unspecified index. Your data will be downloaded and filtered
 * on the client. Consider adding \".indexOn\": \"<child>\" at <path> to your
 * security rules for better performance.")`. `warn` prefixes
 * "FIREBASE WARNING: " and logs through the `@firebase/logger` instance, whose
 * default handler calls `console.warn("[<iso time>]  @firebase/database:", message)`.
 * The warning arrives later and is not attached to the query, so the only
 * place to see it is `console.warn`.
 *
 * `onLog` / `setUserLogHandler` are not used: they replace a handler the host
 * may have set. Instead `console.warn` gets a pass-through wrapper, installed
 * once, that always calls the previous function with the same `this` and
 * arguments and never throws.
 */

import { recordRaw, sdkDebug } from "../core/client.ts";
import { debugOnce } from "../core/log.ts";
import { nextCallId } from "../core/session.ts";

/** Marks our wrapper; `Symbol.for` so two copies of the package install once. */
const MARK = Symbol.for("readmeter.database.indexWarning");

/** Recent ordered listeners kept for the callsite lookup. */
export const CALLSITE_CAP = 256;

const callsites = new Map<string, string>();

const PATTERN =
  /Using an unspecified index\. Your data will be downloaded and filtered on the client\. Consider adding "\.indexOn": "(.+?)" at (\/.*) to your security rules for better performance/s;

export interface IndexWarning {
  /** Concrete path without the leading slash. Empty is the root. */
  path: string;
  /** Ordered child, or `$value` for `orderByValue`. */
  child: string;
}

interface ConsoleLike {
  warn: (...args: unknown[]) => void;
}

type Wrapped = ((...args: unknown[]) => void) & { [MARK]?: (...args: unknown[]) => void };

function key(path: string, child: string): string {
  return `${path}\u0000${child}`;
}

function trimPath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Remembers where an ordered listener was opened so a later warning for the
 * same path and child can carry its callsite. Oldest entries go first.
 */
export function rememberQuery(path: string, orderBy: string | undefined, site: string | undefined): void {
  if (!orderBy || !site || orderBy === "$key" || orderBy === "$priority") return;
  const k = key(trimPath(path), orderBy);
  callsites.delete(k);
  callsites.set(k, site);
  while (callsites.size > CALLSITE_CAP) {
    const oldest = callsites.keys().next();
    if (oldest.done) break;
    callsites.delete(oldest.value);
  }
}

/** Entries in the callsite map. For tests. */
export function rememberedQueries(): number {
  return callsites.size;
}

export function forgetQueries(): void {
  callsites.clear();
}

function childName(spec: string): string {
  if (spec === ".value") return "$value";
  if (spec === ".key") return "$key";
  if (spec === ".priority") return "$priority";
  return spec;
}

/** The path and child named by an unspecified-index warning, if `args` hold one. */
export function parseIndexWarning(args: readonly unknown[]): IndexWarning | undefined {
  for (const arg of args) {
    if (typeof arg !== "string" || !arg.includes("unspecified index")) continue;
    const match = PATTERN.exec(arg);
    const spec = match?.[1];
    const path = match?.[2];
    if (spec === undefined || path === undefined) continue;
    return { path: trimPath(path), child: childName(spec) };
  }
  return undefined;
}

let recording = false;

function report(hit: IndexWarning, record: (raw: unknown) => unknown): void {
  const call: Record<string, unknown> = {
    service: "database",
    op: "index_warning",
    ts_ms: Date.now(),
    call_id: nextCallId(),
    path: hit.path,
    order_by_child: hit.child,
  };
  const site = callsites.get(key(hit.path, hit.child));
  if (site) call.callsite = site;
  record(call);
}

function observe(args: unknown[], record: (raw: unknown) => unknown): void {
  // A recorder that logs a warning must not loop back here.
  if (recording) return;
  recording = true;
  try {
    const hit = parseIndexWarning(args);
    if (hit) report(hit, record);
  } catch (error) {
    try {
      debugOnce(sdkDebug(), error);
    } catch {
      // Never let the host's console.warn throw because of us.
    }
  } finally {
    recording = false;
  }
}

/**
 * Wraps `target.warn` once. Returns false when it is already wrapped or
 * cannot be. The original runs first, with the same `this` and arguments,
 * and its return value and exceptions reach the caller unchanged.
 */
export function installIndexWarning(
  target: ConsoleLike | undefined = globalThis.console,
  record: (raw: unknown) => unknown = recordRaw,
): boolean {
  try {
    if (!target || typeof target.warn !== "function") return false;
    const current = target.warn as Wrapped;
    if (current[MARK]) return false;
    const original = current;
    const wrapper: Wrapped = function (this: unknown, ...args: unknown[]): void {
      try {
        return original.apply(this, args);
      } finally {
        observe(args, record);
      }
    };
    Object.defineProperty(wrapper, MARK, { value: original });
    target.warn = wrapper;
    return true;
  } catch (error) {
    debugOnce(sdkDebug(), error);
    return false;
  }
}

/**
 * Puts the previous `warn` back if ours is still the one installed. A wrapper
 * someone added on top of ours is left alone.
 */
export function uninstallIndexWarning(target: ConsoleLike | undefined = globalThis.console): boolean {
  try {
    if (!target) return false;
    const current = target.warn as Wrapped;
    const original = typeof current === "function" ? current[MARK] : undefined;
    if (!original) return false;
    target.warn = original;
    return true;
  } catch (error) {
    debugOnce(sdkDebug(), error);
    return false;
  }
}
