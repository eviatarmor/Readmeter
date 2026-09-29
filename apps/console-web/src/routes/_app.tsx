import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import type { Me } from "@readmeter/console-api/contract";

import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { queryClient } from "@/lib/query-client";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location }) => {
    const session = await authClient.getSession();
    if (!session.data) {
      const next = `${location.pathname}${location.searchStr}`;
      throw redirect({
        to: "/sign-in",
        search: { next: next.startsWith("/") && !next.startsWith("//") ? next : "/" },
      });
    }
    try {
      const me = await queryClient.ensureQueryData({
        queryKey: ["me"],
        queryFn: () => api<Me>("/api/v1/me", { redirect: false }),
      });
      if (me.workspaces.length === 0) throw redirect({ to: "/onboarding" });
      return { me };
    } catch (error) {
      if (isRedirect(error)) throw error;
      throw redirect({ to: "/sign-in", search: { next: undefined } });
    }
  },
  component: () => <Outlet />,
});

function isRedirect(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "href" in error);
}
