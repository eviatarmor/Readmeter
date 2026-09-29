import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { RulesPage } from "@/features/rules/page";

const workspaceRoute = getRouteApi("/_app/w/$slug");
const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/w/$slug/rules")({
  component: function RulesRoute() {
    const { slug } = workspaceRoute.useParams();
    const search = workspaceRoute.useSearch();
    const { me } = appRoute.useRouteContext();
    const role = me.workspaces.find((workspace) => workspace.slug === slug)?.role;
    return <RulesPage slug={slug} search={search} role={role} />;
  },
});
