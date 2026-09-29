import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDown, Plus } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import type { Me, WorkspaceSummary } from "@readmeter/console-api/contract";

import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { ApiError, api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { queryClient } from "@/lib/query-client";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function WorkspaceSwitcher({
  me,
  slug,
}: {
  me: Me;
  slug: string;
}) {
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const active = me.workspaces.find((workspace) => workspace.slug === slug) ?? me.workspaces[0];

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key < "1" || event.key > "9") return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable='true']")) return;
      const index = Number(event.key) - 1;
      const workspace = me.workspaces[index];
      if (!workspace) return;
      event.preventDefault();
      void switchWorkspace(workspace);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function switchWorkspace(workspace: WorkspaceSummary) {
    const result = await authClient.organization.setActive({ organizationId: workspace.id });
    if (result.error) {
      toast.error(result.error.message ?? "Could not switch workspace");
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["me"] });
    await navigate({ to: "/w/$slug/overview", params: { slug: workspace.slug }, search: { range: "7d" } });
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
              tooltip={active?.name ?? "Workspace"}
            >
              <Logo className="size-8 rounded-md" />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{active?.name ?? "Workspace"}</span>
                <span className="truncate text-xs capitalize text-muted-foreground">{active?.role}</span>
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">Workspaces</DropdownMenuLabel>
            {me.workspaces.map((workspace, index) => (
              <DropdownMenuItem key={workspace.id} onSelect={() => void switchWorkspace(workspace)}>
                <span className="flex size-6 items-center justify-center rounded-md border text-[10px] font-medium">
                  {workspace.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="truncate">{workspace.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {index < 9 ? `⌘${index + 1}` : workspace.role}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setOpen(true)}>
              <Plus />
              Create workspace
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <CreateWorkspaceDialog open={open} onOpenChange={setOpen} />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setSlug("");
  }, [open]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!slugPattern.test(slug)) {
      toast.error("Slug must be lowercase letters, numbers, and hyphens");
      return;
    }
    setPending(true);
    try {
      const created = await api<{ id: string; name: string; slug: string }>("/api/v1/workspaces", {
        method: "POST",
        body: JSON.stringify({ name, slug }),
      });
      await authClient.organization.setActive({ organizationId: created.id });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      onOpenChange(false);
      await navigate({ to: "/w/$slug/overview", params: { slug: created.slug }, search: { range: "7d" } });
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not create workspace");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create workspace</DialogTitle>
          <DialogDescription>A workspace owns projects, members, and audit history.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(event) => void onSubmit(event)}>
          <div className="grid gap-2">
            <Label htmlFor="workspace-name">Name</Label>
            <Input
              id="workspace-name"
              value={name}
              onChange={(event) => {
                const next = event.target.value;
                setName(next);
                if (!slug || slug === slugify(name)) setSlug(slugify(next));
              }}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="workspace-slug">Slug</Label>
            <Input id="workspace-slug" value={slug} onChange={(event) => setSlug(event.target.value)} required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
