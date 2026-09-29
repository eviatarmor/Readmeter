import { createFileRoute } from "@tanstack/react-router";

import { ResetPasswordPage } from "@/features/auth/pages";

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: function ResetRoute() {
    const { token } = Route.useSearch();
    return <ResetPasswordPage token={token} />;
  },
});
