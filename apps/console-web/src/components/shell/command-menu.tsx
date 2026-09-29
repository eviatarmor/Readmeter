import { useNavigate, useRouterState } from "@tanstack/react-router";
import * as React from "react";

import type { Project } from "@readmeter/console-api/contract";

import { configureNav, monitorNav, pageTitles, workspaceNav } from "@/components/shell/nav";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import type { WorkspaceSearch } from "@/lib/workspace-search";

export function CommandMenu({
  open,
  onOpenChange,
  slug,
  search,
  projects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  search: WorkspaceSearch;
  projects: Project[];
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      onOpenChange(!open);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange, open]);

  function go(to: (typeof monitorNav)[number]["to"]) {
    onOpenChange(false);
    void navigate({ to, params: { slug }, search });
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command palette" description="Jump to a page or action">
      <Command>
        <CommandInput placeholder="Search pages, projects, and actions" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Pages">
            {[...monitorNav, ...configureNav, ...workspaceNav].map((item) => (
              <CommandItem key={item.to} value={item.title} onSelect={() => go(item.to)}>
                <item.icon />
                <span>{item.title}</span>
              </CommandItem>
            ))}
            <CommandItem
              value="Profile"
              onSelect={() => {
                onOpenChange(false);
                void navigate({ to: "/account" });
              }}
            >
              <span>{pageTitles.account}</span>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Projects">
            <CommandItem
              value="All projects"
              onSelect={() => {
                onOpenChange(false);
                void navigate({ to: pathname as "/w/$slug/overview", params: { slug }, search: { ...search, project: undefined } });
              }}
            >
              All projects
            </CommandItem>
            {projects.map((project) => (
              <CommandItem
                key={project.id}
                value={`${project.name} ${project.id}`}
                onSelect={() => {
                  onOpenChange(false);
                  void navigate({
                    to: pathname as "/w/$slug/overview",
                    params: { slug },
                    search: { ...search, project: project.id },
                  });
                }}
              >
                {project.name}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Actions">
            <CommandItem value="Search rules" onSelect={() => go("/w/$slug/rules")}>
              Search rules
            </CommandItem>
            <CommandItem value="Create API key" onSelect={() => go("/w/$slug/keys")}>
              Create API key
            </CommandItem>
            <CommandItem value="Invite member" onSelect={() => go("/w/$slug/members")}>
              Invite member
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
