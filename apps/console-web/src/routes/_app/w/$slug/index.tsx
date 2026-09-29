import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/w/$slug/")({
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/w/$slug/overview", params, search });
  },
});
