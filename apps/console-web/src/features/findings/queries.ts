import { useQuery } from "@tanstack/react-query";
import { parseAsStringEnum, useQueryState } from "nuqs";

import type { Finding, FindingDetail, Page } from "@readmeter/console-api/contract";

import { useRules } from "@/features/rules/queries";
import { api, collectPages } from "@/lib/api";
import type { QueryKeys } from "@/lib/data-table-types";
import { getValidFilters } from "@/lib/data-table-utils";
import { filterValues } from "@/lib/filters";
import { getFiltersStateParser, getSortingStateParser } from "@/lib/parsers";
import { rangeBounds, type WindowRange } from "@/lib/ranges";

export interface FindingRow extends Finding {
  ruleTitle: string;
}

export const findingKeys: QueryKeys = {
  page: "fpage",
  perPage: "fperPage",
  sort: "fsort",
  filters: "ffilters",
  joinOperator: "fjoin",
};

const sortMap: Record<string, string> = {
  lastSeen: "last_seen",
  occurrences: "occurrences",
  wastedMicros: "wasted_micros",
  sessions: "sessions",
};

export function useFindingRows(slug: string, project: string | undefined, range: WindowRange) {
  const rules = useRules(slug, project);
  const [sort] = useQueryState(findingKeys.sort, getSortingStateParser<FindingRow>().withDefault([]));
  const [filters] = useQueryState(findingKeys.filters, getFiltersStateParser<FindingRow>().withDefault([]));
  const valid = getValidFilters(filters);
  const bounds = rangeBounds(range);
  const params = new URLSearchParams({ from: bounds.from, to: bounds.to });
  if (project) params.set("project", project);
  const severity = filterValues(valid, "severity");
  if (severity.length > 0) params.set("severity", severity.join(","));
  const status = filterValues(valid, "status");
  if (status.length === 1 && status[0]) params.set("status", status[0]);
  const rule = filterValues(valid, "rule");
  if (rule.length === 1 && rule[0]) params.set("rule", rule[0]);
  const service = filterValues(valid, "service");
  if (service.length === 1 && service[0]) params.set("service", service[0]);
  const template = filterValues(valid, "template");
  if (template.length === 1 && template[0]) params.set("template", template[0]);
  const first = sort[0];
  if (first?.desc && sortMap[first.id]) params.set("sort", sortMap[first.id] ?? "");
  const query = useQuery({
    queryKey: ["findings", slug, params.toString()],
    queryFn: () => collectPages<Finding>(`/api/v1/workspaces/${slug}/findings?${params}`),
  });
  const titles = new Map((rules.data?.rules ?? []).map((rule) => [rule.id, rule.title]));
  const rows: FindingRow[] = (query.data ?? []).map((row) => ({
    ...row,
    ruleTitle: titles.get(row.rule) ?? row.rule,
  }));
  return { ...query, rows, isLoading: query.isLoading || rules.isLoading };
}

export function useFinding(slug: string, id: string | undefined) {
  return useQuery({
    queryKey: ["finding", slug, id ?? ""],
    enabled: Boolean(id),
    queryFn: () => api<FindingDetail>(`/api/v1/workspaces/${slug}/findings/${encodeURIComponent(id ?? "")}`),
  });
}

export function useFindingBadge(slug: string, project: string | undefined) {
  const params = new URLSearchParams({ status: "open", severity: "critical,high", limit: "1" });
  if (project) params.set("project", project);
  return useQuery({
    queryKey: ["finding-badge", slug, project ?? ""],
    queryFn: async () => {
      const page = await api<Page<Finding>>(`/api/v1/workspaces/${slug}/findings?${params}`);
      return page.total ?? page.items.length;
    },
  });
}

export function useJoinOperator(keys: QueryKeys) {
  return useQueryState(keys.joinOperator, parseAsStringEnum(["and", "or"]).withDefault("and"));
}
