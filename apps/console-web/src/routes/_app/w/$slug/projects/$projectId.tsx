import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { ProjectSettingsPage } from "@/features/projects/page";

const workspaceRoute = getRouteApi("/_app/w/$slug");
const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/w/$slug/projects/$projectId")({
  component: function ProjectRoute() {
    const { slug } = workspaceRoute.useParams();
    const { projectId } = Route.useParams();
    const search = workspaceRoute.useSearch();
    const { me } = appRoute.useRouteContext();
    const role = me.workspaces.find((workspace) => workspace.slug === slug)?.role;
    return <ProjectSettingsPage slug={slug} projectId={projectId} search={search} role={role} />;
  },
});
