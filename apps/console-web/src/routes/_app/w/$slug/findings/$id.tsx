import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { FindingsPage } from "@/features/findings/page";

const workspaceRoute = getRouteApi("/_app/w/$slug");

export const Route = createFileRoute("/_app/w/$slug/findings/$id")({
  component: function FindingRoute() {
    const { slug } = workspaceRoute.useParams();
    const { id } = Route.useParams();
    const search = workspaceRoute.useSearch();
    return <FindingsPage slug={slug} search={search} findingId={id} />;
  },
});
