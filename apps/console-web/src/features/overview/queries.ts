import { useQuery } from "@tanstack/react-query";

import type { Overview } from "@readmeter/console-api/contract";

import { api } from "@/lib/api";
import { chartRange } from "@/lib/ranges";

export function useOverview(slug: string, project: string | undefined, range: string) {
  const resolved = chartRange(range);
  const params = new URLSearchParams({ range: resolved });
  if (project) params.set("project", project);
  return useQuery({
    queryKey: ["overview", slug, project ?? "", resolved],
    queryFn: () => api<Overview>(`/api/v1/workspaces/${slug}/overview?${params}`),
  });
}
