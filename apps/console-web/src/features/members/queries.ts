import { useQuery } from "@tanstack/react-query";

import type { Invitation, Member } from "@readmeter/console-api/contract";

import { collectPages } from "@/lib/api";

export function useMembers(slug: string) {
  return useQuery({
    queryKey: ["members", slug],
    queryFn: () => collectPages<Member>(`/api/v1/workspaces/${slug}/members`),
  });
}

export function useInvitations(slug: string, enabled: boolean) {
  return useQuery({
    queryKey: ["invitations", slug],
    enabled,
    queryFn: () => collectPages<Invitation>(`/api/v1/workspaces/${slug}/invitations`),
  });
}
