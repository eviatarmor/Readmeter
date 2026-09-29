import { createFileRoute, redirect } from "@tanstack/react-router";

import { OnboardingPage } from "@/features/onboarding/page";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/onboarding")({
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (!session.data) throw redirect({ to: "/sign-in", search: { next: "/onboarding" } });
  },
  component: OnboardingPage,
});
