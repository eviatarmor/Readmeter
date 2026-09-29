import { createFileRoute, redirect } from "@tanstack/react-router";

import type { Me } from "@readmeter/console-api/contract";

import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { queryClient } from "@/lib/query-client";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (!session.data) throw redirect({ to: "/sign-in", search: { next: undefined } });
    const me = await api<Me>("/api/v1/me", { redirect: false });
    queryClient.setQueryData(["me"], me);
    const slug = me.workspaces.find((workspace) => workspace.slug === me.activeWorkspace)?.slug ?? me.workspaces[0]?.slug;
    if (!slug) throw redirect({ to: "/onboarding" });
    throw redirect({ to: "/w/$slug/overview", params: { slug }, search: { range: "7d" } });
  },
});
