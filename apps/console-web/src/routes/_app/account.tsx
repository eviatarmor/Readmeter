import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { Shell } from "@/components/shell/shell";
import { AccountPage } from "@/features/account/page";

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/account")({
  component: function AccountRoute() {
    const { me } = appRoute.useRouteContext();
    const slug = me.workspaces.find((workspace) => workspace.slug === me.activeWorkspace)?.slug ?? me.workspaces[0]?.slug;
    if (!slug) return <AccountPage />;
    return (
      <Shell me={me} slug={slug} search={{ range: "7d" }}>
        <AccountPage />
      </Shell>
    );
  },
});
