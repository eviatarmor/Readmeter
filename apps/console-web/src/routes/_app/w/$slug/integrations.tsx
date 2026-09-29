import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { IntegrationsPage } from "@/features/integrations/page";

const workspaceRoute = getRouteApi("/_app/w/$slug");

export const Route = createFileRoute("/_app/w/$slug/integrations")({
  component: function IntegrationsRoute() {
    const { slug } = workspaceRoute.useParams();
    const search = workspaceRoute.useSearch();
    return <IntegrationsPage slug={slug} search={search} />;
  },
});
