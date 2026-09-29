import { createFileRoute } from "@tanstack/react-router";

import { AcceptInvitePage } from "@/features/auth/pages";

export const Route = createFileRoute("/accept-invitation/$id")({
  component: function AcceptRoute() {
    const { id } = Route.useParams();
    return <AcceptInvitePage invitationId={id} />;
  },
});
