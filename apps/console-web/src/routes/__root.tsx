import { createRootRoute, Outlet } from "@tanstack/react-router";
import { NuqsAdapter } from "@/lib/nuqs-adapter";

export const Route = createRootRoute({
  component: () => (
    <NuqsAdapter>
      <Outlet />
    </NuqsAdapter>
  ),
});
