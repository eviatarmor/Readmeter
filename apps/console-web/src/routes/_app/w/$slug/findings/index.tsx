import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { FindingsPage } from "@/features/findings/page";

const workspaceRoute = getRouteApi("/_app/w/$slug");

export const Route = createFileRoute("/_app/w/$slug/findings/")({
  component: function FindingsRoute() {
    const { slug } = workspaceRoute.useParams();
    const search = workspaceRoute.useSearch();
    return <FindingsPage slug={slug} search={search} />;
  },
});
