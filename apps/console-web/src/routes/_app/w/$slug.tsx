import { createFileRoute, getRouteApi, redirect } from "@tanstack/react-router";

import { Shell } from "@/components/shell/shell";
import { authClient } from "@/lib/auth-client";
import { queryClient } from "@/lib/query-client";
import { validateWorkspaceSearch, workspaceSearchOptions } from "@/lib/workspace-search";

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/w/$slug")({
  validateSearch: validateWorkspaceSearch,
  search: workspaceSearchOptions,
  beforeLoad: async ({ params }) => {
    const me = queryClient.getQueryData<import("@readmeter/console-api/contract").Me>(["me"]);
    const workspace = me?.workspaces.find((item) => item.slug === params.slug);
    if (me && !workspace) throw redirect({ to: "/" });
    if (workspace && me?.activeWorkspace !== params.slug) {
      const result = await authClient.organization.setActive({ organizationId: workspace.id });
      if (result.error) throw redirect({ to: "/" });
      queryClient.setQueryData(["me"], { ...me, activeWorkspace: params.slug });
    }
  },
  component: function WorkspaceLayout() {
    const { me } = appRoute.useRouteContext();
    const { slug } = Route.useParams();
    const search = Route.useSearch();
    return <Shell me={me} slug={slug} search={search} />;
  },
});
