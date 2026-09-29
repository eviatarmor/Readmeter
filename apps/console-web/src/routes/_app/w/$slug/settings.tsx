import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { SettingsPage } from "@/features/settings/page";

const workspaceRoute = getRouteApi("/_app/w/$slug");
const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/w/$slug/settings")({
  component: function SettingsRoute() {
    const { slug } = workspaceRoute.useParams();
    const { me } = appRoute.useRouteContext();
    const role = me.workspaces.find((workspace) => workspace.slug === slug)?.role;
    return <SettingsPage slug={slug} role={role} />;
  },
});
