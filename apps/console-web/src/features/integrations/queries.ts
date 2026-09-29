import { useQuery } from "@tanstack/react-query";

import type { GcpConnectionResponse } from "@readmeter/console-api/contract";

import { api } from "@/lib/api";

export function useGcp(slug: string, projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["gcp", slug, projectId ?? ""],
    enabled: Boolean(projectId) && enabled,
    queryFn: () => api<GcpConnectionResponse>(`/api/v1/workspaces/${slug}/projects/${projectId}/gcp`),
    refetchInterval: (query) => {
      const connection = query.state.data?.connection;
      return connection && !connection.lastSyncAt ? 1000 : false;
    },
  });
}
