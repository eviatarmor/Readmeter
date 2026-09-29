import { createFileRoute } from "@tanstack/react-router";

import { AcceptInvitePage } from "@/features/auth/pages";

export const Route = createFileRoute("/invite/$id")({
  component: function InviteRoute() {
    const { id } = Route.useParams();
    return <AcceptInvitePage invitationId={id} />;
  },
});
