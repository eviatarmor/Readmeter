import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { KeysPage } from "@/features/keys/page";

const workspaceRoute = getRouteApi("/_app/w/$slug");
const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/w/$slug/keys")({
  component: function KeysRoute() {
    const { slug } = workspaceRoute.useParams();
    const search = workspaceRoute.useSearch();
    const { me } = appRoute.useRouteContext();
    const role = me.workspaces.find((workspace) => workspace.slug === slug)?.role;
    return <KeysPage slug={slug} search={search} role={role} />;
  },
});
