import { useQuery } from "@tanstack/react-query";

import type { AuthConfig, Me } from "@readmeter/console-api/contract";

import { api } from "@/lib/api";

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/api/v1/me"),
  });
}

export function useAuthConfig() {
  return useQuery({
    queryKey: ["auth-config"],
    queryFn: () => api<AuthConfig>("/api/v1/auth-config"),
  });
}
