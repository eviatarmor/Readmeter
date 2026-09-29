import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { ProjectsPage } from "@/features/projects/page";

const workspaceRoute = getRouteApi("/_app/w/$slug");
const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/w/$slug/projects/")({
  component: function ProjectsRoute() {
    const { slug } = workspaceRoute.useParams();
    const search = workspaceRoute.useSearch();
    const { me } = appRoute.useRouteContext();
    const role = me.workspaces.find((workspace) => workspace.slug === slug)?.role;
    return <ProjectsPage slug={slug} search={search} role={role} />;
  },
});
