import type { Role } from "@readmeter/console-api/contract";

export function canManage(role: Role | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function canDeleteWorkspace(role: Role | undefined): boolean {
  return role === "owner";
}
