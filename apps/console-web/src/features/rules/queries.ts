import { useQuery } from "@tanstack/react-query";

import type { RulesResponse } from "@readmeter/console-api/contract";

import { api } from "@/lib/api";

export function useRules(slug: string, project: string | undefined) {
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  const query = params.size > 0 ? `?${params}` : "";
  return useQuery({
    queryKey: ["rules", slug, project ?? ""],
    queryFn: () => api<RulesResponse>(`/api/v1/workspaces/${slug}/rules${query}`),
  });
}
