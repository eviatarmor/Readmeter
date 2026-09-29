import { retainSearchParams, type SearchMiddleware } from "@tanstack/react-router";

import { isWindowRange, type WindowRange } from "@/lib/ranges";

export interface WorkspaceSearch {
  project?: string;
  range: WindowRange;
}

export const retainedTableKeys = [
  "filters",
  "sort",
  "page",
  "perPage",
  "joinOperator",
  "ffilters",
  "fsort",
  "fpage",
  "fperPage",
  "fjoin",
  "efilters",
  "esort",
  "epage",
  "eperPage",
  "ejoin",
  "kfilters",
  "ksort",
  "kpage",
  "kperPage",
  "kjoin",
  "rfilters",
  "rsort",
  "rpage",
  "rperPage",
  "rjoin",
  "mfilters",
  "msort",
  "mpage",
  "mperPage",
  "mjoin",
  "afilters",
  "asort",
  "apage",
  "aperPage",
  "ajoin",
  "pfilters",
  "psort",
  "ppage",
  "pperPage",
  "pjoin",
] as const;

export function validateWorkspaceSearch(search: Record<string, unknown>): WorkspaceSearch {
  const range = typeof search.range === "string" && isWindowRange(search.range) ? search.range : "7d";
  const project = typeof search.project === "string" && search.project.length > 0 ? search.project : undefined;
  return { project, range };
}

export const workspaceSearchOptions = {
  middlewares: [
    retainSearchParams([...retainedTableKeys]) as unknown as SearchMiddleware<WorkspaceSearch>,
  ],
};
