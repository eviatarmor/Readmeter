import { useQuery } from "@tanstack/react-query";

import type { AuditEntry, WorkspaceDetail } from "@readmeter/console-api/contract";

import { api, collectPages } from "@/lib/api";

export function useWorkspace(slug: string) {
  return useQuery({
    queryKey: ["workspace", slug],
    queryFn: () => api<WorkspaceDetail>(`/api/v1/workspaces/${slug}`),
  });
}

export function useAudit(slug: string, enabled: boolean) {
  return useQuery({
    queryKey: ["audit", slug],
    enabled,
    queryFn: () => collectPages<AuditEntry>(`/api/v1/workspaces/${slug}/audit`),
  });
}
