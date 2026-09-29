import { canDeleteWorkspace, canManage } from "@/lib/permissions";

describe("permissions", () => {
  it("lets owners and admins manage the workspace", () => {
    expect(canManage("owner")).toBe(true);
    expect(canManage("admin")).toBe(true);
    expect(canManage("member")).toBe(false);
    expect(canManage(undefined)).toBe(false);
  });

  it("lets only the owner delete the workspace", () => {
    expect(canDeleteWorkspace("owner")).toBe(true);
    expect(canDeleteWorkspace("admin")).toBe(false);
    expect(canDeleteWorkspace("member")).toBe(false);
    expect(canDeleteWorkspace(undefined)).toBe(false);
  });
});
