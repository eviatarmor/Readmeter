import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import * as React from "react";

import type { Me } from "@readmeter/console-api/contract";

import { AppSidebar } from "@/components/shell/app-sidebar";
import { CommandMenu } from "@/components/shell/command-menu";
import { Navbar } from "@/components/shell/navbar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useFindingBadge } from "@/features/findings/queries";
import { useProjects } from "@/features/projects/queries";
import { projectStorageKey } from "@/lib/ranges";
import type { WorkspaceSearch } from "@/lib/workspace-search";

function readSidebarOpen(): boolean {
  if (typeof document === "undefined") return true;
  const match = document.cookie.match(/(?:^|; )sidebar_state=([^;]*)/);
  if (!match?.[1]) return true;
  return match[1] !== "false";
}

const rangeSections = new Set(["overview", "findings", "events", "costs"]);
const chartSections = new Set(["overview", "costs"]);

export function Shell({
  me,
  slug,
  search,
  children,
}: {
  me: Me;
  slug: string;
  search: WorkspaceSearch;
  children?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [commandOpen, setCommandOpen] = React.useState(false);
  const projects = useProjects(slug);
  const badge = useFindingBadge(slug, search.project);
  const section = sectionFromPath(pathname);
  const workspace = me.workspaces.find((item) => item.slug === slug);

  const inWorkspace = pathname.startsWith("/w/");

  React.useEffect(() => {
    if (!inWorkspace) return;
    if (search.project) {
      localStorage.setItem(projectStorageKey(slug), search.project);
      return;
    }
    const stored = localStorage.getItem(projectStorageKey(slug));
    if (!stored) return;
    goToSection(navigate, pathname, slug, { ...search, project: stored });
  }, [inWorkspace, navigate, pathname, search, slug]);

  function onSearchChange(next: WorkspaceSearch) {
    if (!inWorkspace) {
      void navigate({ to: "/w/$slug/overview", params: { slug }, search: next, replace: true });
      return;
    }
    goToSection(navigate, pathname, slug, next);
  }

  return (
    <SidebarProvider defaultOpen={readSidebarOpen()}>
      <AppSidebar me={me} slug={slug} search={search} findingBadge={badge.data ?? 0} />
      <SidebarInset className="min-w-0">
        <Navbar
          slug={slug}
          workspaceName={workspace?.name ?? slug}
          section={section}
          search={search}
          projects={projects.data ?? []}
          onSearchChange={onSearchChange}
          showRange={rangeSections.has(section)}
          chartOnly={chartSections.has(section)}
          onCommand={() => setCommandOpen(true)}
        />
        <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
          {children ?? <Outlet />}
        </div>
      </SidebarInset>
      <CommandMenu
        open={commandOpen}
        onOpenChange={setCommandOpen}
        slug={slug}
        search={search}
        projects={projects.data ?? []}
      />
    </SidebarProvider>
  );
}

function sectionFromPath(pathname: string): string {
  if (pathname.startsWith("/account")) return "account";
  const parts = pathname.split("/").filter(Boolean);
  return parts[2] ?? "overview";
}

function goToSection(
  navigate: ReturnType<typeof useNavigate>,
  pathname: string,
  slug: string,
  search: WorkspaceSearch,
) {
  const finding = /^\/w\/[^/]+\/findings\/([^/]+)/.exec(pathname);
  const findingId = finding?.[1];
  if (findingId) {
    void navigate({
      to: "/w/$slug/findings/$id",
      params: { slug, id: decodeURIComponent(findingId) },
      search,
      replace: true,
    });
    return;
  }
  const params = { slug };
  switch (sectionFromPath(pathname)) {
    case "findings":
      void navigate({ to: "/w/$slug/findings", params, search, replace: true });
      return;
    case "events":
      void navigate({ to: "/w/$slug/events", params, search, replace: true });
      return;
    case "costs":
      void navigate({ to: "/w/$slug/costs", params, search, replace: true });
      return;
    case "rules":
      void navigate({ to: "/w/$slug/rules", params, search, replace: true });
      return;
    case "projects":
      void navigate({ to: "/w/$slug/projects", params, search, replace: true });
      return;
    case "keys":
      void navigate({ to: "/w/$slug/keys", params, search, replace: true });
      return;
    case "integrations":
      void navigate({ to: "/w/$slug/integrations", params, search, replace: true });
      return;
    case "members":
      void navigate({ to: "/w/$slug/members", params, search, replace: true });
      return;
    case "settings":
      void navigate({ to: "/w/$slug/settings", params, search, replace: true });
      return;
    default:
      void navigate({ to: "/w/$slug/overview", params, search, replace: true });
  }
}
