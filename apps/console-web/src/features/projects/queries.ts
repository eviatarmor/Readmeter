import { useQuery } from "@tanstack/react-query";

import type { Project, ProjectDetail } from "@readmeter/console-api/contract";

import { api, collectPages } from "@/lib/api";

export function useProjects(slug: string) {
  return useQuery({
    queryKey: ["projects", slug],
    queryFn: () => collectPages<Project>(`/api/v1/workspaces/${slug}/projects`),
  });
}

export function useProject(slug: string, projectId: string) {
  return useQuery({
    queryKey: ["project", slug, projectId],
    queryFn: () => api<ProjectDetail>(`/api/v1/workspaces/${slug}/projects/${projectId}`),
  });
}
