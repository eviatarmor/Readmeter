import { useLocation, useRouter, useRouterState } from "@tanstack/react-router";
import {
  renderQueryString,
  unstable_createAdapterProvider,
  type unstable_AdapterInterface,
  type unstable_UpdateUrlFunction,
} from "nuqs/adapters/custom";
import { startTransition, useCallback, useMemo, useRef } from "react";

// nuqs 2.10 puts the query on `navigate({ to: pathname + search })`.
// TanStack Router 1.171 treats that whole string as a pathname and drops the
// query. `href` is parsed into pathname + search, and retainSearchParams on
// the workspace route keeps project, range, and the other table keys.
type SearchRecord = Record<string, unknown>;

export function searchEntries(search: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(search).flatMap(([key, value]) => {
    if (Array.isArray(value)) {
      if (value.some((item) => item !== null && typeof item === "object")) {
        return [[key, JSON.stringify(value)]];
      }
      return value.map((item) => [key, String(item)] as [string, string]);
    }
    if (typeof value === "object" && value !== null) return [[key, JSON.stringify(value)]];
    return [[key, value == null ? "" : String(value)]];
  });
}

function useRouterSearchAdapter(watchKeys: string[]): unstable_AdapterInterface {
  const pathname = useLocation({ select: (state) => state.pathname });
  const search = useRouterState({
    select: (state): SearchRecord => {
      const current = state.location.search as Record<string, unknown>;
      const picked: SearchRecord = {};
      for (const key of watchKeys) {
        if (Object.prototype.hasOwnProperty.call(current, key)) picked[key] = current[key];
      }
      return picked;
    },
  });
  const resolvedPathname = useRouterState({
    select: (state) => state.resolvedLocation?.pathname ?? state.location.pathname,
  });
  const router = useRouter();
  const ownedPathnameRef = useRef(pathname);
  const cachedSearchRef = useRef<SearchRecord>(search);
  const isPathStable = pathname === resolvedPathname;
  if (isPathStable) {
    ownedPathnameRef.current = pathname;
    cachedSearchRef.current = search;
  }
  const activeSearch = !isPathStable && ownedPathnameRef.current !== pathname ? cachedSearchRef.current : search;
  const watched = watchKeys.join(",");

  const searchParams = useMemo(
    () =>
      new URLSearchParams(searchEntries(activeSearch)),
    [activeSearch, watched],
  );

  const updateUrl: unstable_UpdateUrlFunction = useCallback(
    (next, options) => {
      const hash = window.location.hash;
      startTransition(() => {
        void router.navigate({
          href: pathname + renderQueryString(next) + hash,
          replace: options.history === "replace",
          resetScroll: options.scroll,
          state: (current) => current,
        });
      });
    },
    [pathname, router],
  );

  return { searchParams, updateUrl, rateLimitFactor: 1 };
}

export const NuqsAdapter = unstable_createAdapterProvider(useRouterSearchAdapter);
