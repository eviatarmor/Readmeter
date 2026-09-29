import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { MembersPage } from "@/features/members/page";

const workspaceRoute = getRouteApi("/_app/w/$slug");
const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/w/$slug/members")({
  component: function MembersRoute() {
    const { slug } = workspaceRoute.useParams();
    const { me } = appRoute.useRouteContext();
    const role = me.workspaces.find((workspace) => workspace.slug === slug)?.role;
    return <MembersPage slug={slug} role={role} />;
  },
});
