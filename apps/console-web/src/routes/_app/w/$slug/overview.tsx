import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { OverviewPage } from "@/features/overview/page";

const workspaceRoute = getRouteApi("/_app/w/$slug");

export const Route = createFileRoute("/_app/w/$slug/overview")({
  component: function OverviewRoute() {
    const { slug } = workspaceRoute.useParams();
    const search = workspaceRoute.useSearch();
    return <OverviewPage slug={slug} search={search} />;
  },
});
