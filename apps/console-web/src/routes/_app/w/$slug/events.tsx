import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { EventsPage } from "@/features/events/page";

const workspaceRoute = getRouteApi("/_app/w/$slug");

export const Route = createFileRoute("/_app/w/$slug/events")({
  component: function EventsRoute() {
    const { slug } = workspaceRoute.useParams();
    const search = workspaceRoute.useSearch();
    return <EventsPage slug={slug} search={search} />;
  },
});
