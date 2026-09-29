import { useQuery } from "@tanstack/react-query";

import type { ApiKey, Project } from "@readmeter/console-api/contract";

import { collectPages } from "@/lib/api";
import type { QueryKeys } from "@/lib/data-table-types";

export interface KeyRow extends ApiKey {
  projectId: string;
  projectName: string;
}

export const keyTableKeys: QueryKeys = {
  page: "kpage",
  perPage: "kperPage",
  sort: "ksort",
  filters: "kfilters",
  joinOperator: "kjoin",
};

export function useKeys(slug: string, projects: Project[]) {
  const ids = projects.map((project) => project.id).join(",");
  return useQuery({
    queryKey: ["keys", slug, ids],
    enabled: projects.length > 0,
    queryFn: async () => {
      const rows: KeyRow[] = [];
      for (const project of projects) {
        const keys = await collectPages<ApiKey>(`/api/v1/workspaces/${slug}/projects/${project.id}/keys`);
        for (const key of keys) {
          rows.push({ ...key, projectId: project.id, projectName: project.name });
        }
      }
      return rows;
    },
  });
}
