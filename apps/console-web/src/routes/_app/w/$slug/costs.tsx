import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { CostsPage } from "@/features/costs/page";

const workspaceRoute = getRouteApi("/_app/w/$slug");

export const Route = createFileRoute("/_app/w/$slug/costs")({
  component: function CostsRoute() {
    const { slug } = workspaceRoute.useParams();
    const search = workspaceRoute.useSearch();
    return <CostsPage slug={slug} search={search} />;
  },
});
