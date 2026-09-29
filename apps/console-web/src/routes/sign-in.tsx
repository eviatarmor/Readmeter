import { createFileRoute } from "@tanstack/react-router";

import { SignInPage } from "@/features/auth/pages";

export const Route = createFileRoute("/sign-in")({
  validateSearch: (search: Record<string, unknown>) => {
    const next = typeof search.next === "string" ? search.next : undefined;
    return {
      next: next && next.startsWith("/") && !next.startsWith("//") ? next : undefined,
    };
  },
  component: function SignInRoute() {
    const { next } = Route.useSearch();
    return <SignInPage next={next} />;
  },
});
