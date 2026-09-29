import { Link, useRouterState } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";

import type { Me } from "@readmeter/console-api/contract";

import { UserMenu } from "@/components/shell/user-menu";
import { configureNav, DOCS_URL, monitorNav, workspaceNav, type NavItem } from "@/components/shell/nav";
import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import type { WorkspaceSearch } from "@/lib/workspace-search";

export function AppSidebar({
  me,
  slug,
  search,
  findingBadge,
}: {
  me: Me;
  slug: string;
  search: WorkspaceSearch;
  findingBadge: number;
}) {
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <WorkspaceSwitcher me={me} slug={slug} />
      </SidebarHeader>
      <SidebarContent>
        <NavGroup label="Monitor" items={monitorNav} slug={slug} search={search} findingBadge={findingBadge} />
        <NavGroup label="Configure" items={configureNav} slug={slug} search={search} findingBadge={0} />
        <NavGroup label="Workspace" items={workspaceNav} slug={slug} search={search} findingBadge={0} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Docs">
              <a href={DOCS_URL} target="_blank" rel="noreferrer">
                <BookOpen />
                <span>Docs</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <UserMenu me={me} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function NavGroup({
  label,
  items,
  slug,
  search,
  findingBadge,
}: {
  label: string;
  items: NavItem[];
  slug: string;
  search: WorkspaceSearch;
  findingBadge: number;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const href = item.to.replace("$slug", slug);
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <SidebarMenuItem key={item.to}>
              <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
                <Link to={item.to} params={{ slug }} search={search}>
                  <item.icon />
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
              {item.badge === "findings" && findingBadge > 0 ? (
                <SidebarMenuBadge>{findingBadge > 99 ? "99+" : findingBadge}</SidebarMenuBadge>
              ) : null}
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}
