import { useQuery } from "@tanstack/react-query";
import { useQueryState } from "nuqs";

import type { TelemetryEvent } from "@readmeter/console-api/contract";

import { collectPages } from "@/lib/api";
import type { QueryKeys } from "@/lib/data-table-types";
import { getValidFilters } from "@/lib/data-table-utils";
import { filterValues } from "@/lib/filters";
import { getFiltersStateParser } from "@/lib/parsers";
import { rangeBounds, type WindowRange } from "@/lib/ranges";

export const eventKeys: QueryKeys = {
  page: "epage",
  perPage: "eperPage",
  sort: "esort",
  filters: "efilters",
  joinOperator: "ejoin",
};

export function useEvents(slug: string, project: string | undefined, range: WindowRange) {
  const [filters] = useQueryState(eventKeys.filters, getFiltersStateParser<TelemetryEvent>().withDefault([]));
  const valid = getValidFilters(filters);
  const bounds = rangeBounds(range);
  const params = new URLSearchParams({ from: bounds.from, to: bounds.to });
  if (project) params.set("project", project);
  const op = filterValues(valid, "op");
  if (op.length === 1 && op[0]) params.set("op", op[0]);
  const service = filterValues(valid, "service");
  if (service.length === 1 && service[0]) params.set("service", service[0]);
  const template = filterValues(valid, "template");
  if (template.length === 1 && template[0]) params.set("template", template[0]);
  const session = filterValues(valid, "session");
  if (session.length === 1 && session[0]) params.set("session", session[0]);
  return useQuery({
    queryKey: ["events", slug, params.toString()],
    queryFn: () => collectPages<TelemetryEvent>(`/api/v1/workspaces/${slug}/events?${params}`),
  });
}
