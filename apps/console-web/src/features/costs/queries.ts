import { useQuery } from "@tanstack/react-query";

import type { Costs } from "@readmeter/console-api/contract";

import { api } from "@/lib/api";
import { chartRange } from "@/lib/ranges";

export type CostGroup = "service" | "rule" | "template" | "day";

export function useCosts(slug: string, project: string | undefined, range: string, groupBy: CostGroup) {
  const resolved = chartRange(range);
  const params = new URLSearchParams({ range: resolved, groupBy });
  if (project) params.set("project", project);
  return useQuery({
    queryKey: ["costs", slug, project ?? "", resolved, groupBy],
    queryFn: () => api<Costs>(`/api/v1/workspaces/${slug}/costs?${params}`),
  });
}
