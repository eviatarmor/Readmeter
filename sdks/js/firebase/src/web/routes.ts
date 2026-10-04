/**
 * SPA route changes as `navigate` page events. Part of the lazy chunk
 * (core/open.ts), so it stays out of the eager JS glue.
 */
import { recordRaw } from "../core/client.ts";
import { debugOnce } from "../core/log.ts";
import { nextCallId } from "../core/session.ts";

export interface WindowHost {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  history?: unknown;
  location?: unknown;
}

/** Adds a guarded host listener that `init`'s `unwatchPage` removes. */
export type On = (host: WindowHost | undefined, type: string, run: () => void) => void;

/** One `history` method replaced by `watchRoutes`. */
interface HistoryPatch {
  host: Record<string, unknown>;
  name: string;
  original: unknown;
  wrapper: unknown;
}

/** Patches installed by the current `watchRoutes`. */
let patches: HistoryPatch[] = [];
/**
 * Patches that could not be undone because something wrapped `history` on
 * top of ours. They stay in the chain, inert until the next `watchRoutes`,
 * which reuses them instead of wrapping twice.
 */
const stranded: HistoryPatch[] = [];
/** Called by patched `history` methods. Unset when routes are not watched. */
let routeChanged: (() => void) | undefined;
let debug = false;

/** Undoes `watchRoutes`. Listeners added through `on` are removed by the caller. */
export function unwatchRoutes(): void {
  routeChanged = undefined;
  for (const patch of patches) {
    try {
      if (patch.host[patch.name] === patch.wrapper) patch.host[patch.name] = patch.original;
      else stranded.push(patch);
    } catch (error) {
      stranded.push(patch);
      debugOnce(debug, error);
    }
  }
  patches = [];
}

/**
 * The current route: `location.pathname`, or the hash path for hash routers
 * (`#/users/1`, `#!/users/1`). Query string and fragment are cut here, and
 * the core templates what is left before anything leaves the process.
 */
function routeOf(location: unknown): string | undefined {
  if (!location || typeof location !== "object") return undefined;
  const { pathname, hash } = location as { pathname?: unknown; hash?: unknown };
  let route: string | undefined;
  if (typeof hash === "string" && (hash.startsWith("#/") || hash.startsWith("#!/"))) {
    route = hash.slice(hash.indexOf("/"));
  } else if (typeof pathname === "string") {
    route = pathname;
  }
  if (route === undefined) return undefined;
  const cut = route.search(/[?#]/);
  return cut >= 0 ? route.slice(0, cut) : route;
}

function patchHistory(history: Record<string, unknown>, name: string): void {
  const original = history[name];
  if (typeof original !== "function") return;
  if (stranded.some((patch) => patch.host === history && patch.name === name)) return;
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    const result = (original as (...a: unknown[]) => unknown).apply(this, args);
    try {
      routeChanged?.();
    } catch (error) {
      debugOnce(debug, error);
    }
    return result;
  };
  history[name] = wrapper;
  patches.push({ host: history, name, original, wrapper });
}

/**
 * Reports SPA route changes as `navigate` page events: `pushState` and
 * `replaceState` are wrapped (undone by `shutdown`/re-`init`), `popstate`
 * and `hashchange` are listened to. Only a change of route is reported, so
 * `replaceState` with the same path (scroll restoration) records nothing.
 */
export function watchRoutes(win: WindowHost | undefined, on: On, debugOn: boolean): void {
  unwatchRoutes();
  debug = debugOn;
  if (!win) return;
  const location = (): unknown => win.location ?? (globalThis as { location?: unknown }).location;
  let last = routeOf(location());
  routeChanged = () => {
    const route = routeOf(location());
    if (route === undefined || route === last) return;
    last = route;
    recordRaw({ op: "navigate", ts_ms: Date.now(), call_id: nextCallId(), route });
  };
  const history = win.history ?? (globalThis as { history?: unknown }).history;
  if (history && typeof history === "object") {
    patchHistory(history as Record<string, unknown>, "pushState");
    patchHistory(history as Record<string, unknown>, "replaceState");
  }
  on(win, "popstate", () => routeChanged?.());
  on(win, "hashchange", () => routeChanged?.());
}
