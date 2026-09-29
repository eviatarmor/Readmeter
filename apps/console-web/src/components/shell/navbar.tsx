import { Link } from "@tanstack/react-router";
import { CircleHelp, Search } from "lucide-react";

import type { Project } from "@readmeter/console-api/contract";

import { DOCS_URL, pageTitles } from "@/components/shell/nav";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { CHART_RANGES, WINDOW_RANGES, projectStorageKey, type WindowRange } from "@/lib/ranges";
import type { WorkspaceSearch } from "@/lib/workspace-search";

export function Navbar({
  slug,
  workspaceName,
  section,
  search,
  projects,
  onSearchChange,
  showRange,
  chartOnly,
  onCommand,
}: {
  slug: string;
  workspaceName: string;
  section: string;
  search: WorkspaceSearch;
  projects: Project[];
  onSearchChange: (search: WorkspaceSearch) => void;
  showRange: boolean;
  chartOnly: boolean;
  onCommand: () => void;
}) {
  const ranges = chartOnly ? CHART_RANGES : WINDOW_RANGES;
  const rangeValue = chartOnly && search.range === "24h" ? "7d" : search.range;

  function setProject(value: string) {
    if (value === "all") {
      localStorage.removeItem(projectStorageKey(slug));
      onSearchChange({ ...search, project: undefined });
      return;
    }
    localStorage.setItem(projectStorageKey(slug), value);
    onSearchChange({ ...search, project: value });
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger />
      <Breadcrumb className="hidden min-w-0 md:block">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/w/$slug/overview" params={{ slug }} search={search}>
                {workspaceName}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{pageTitles[section] ?? section}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-2">
        <Select value={search.project ?? "all"} onValueChange={(value) => value && setProject(value)}>
          <SelectTrigger className="w-40" aria-label="Project">
            <SelectValue placeholder="All projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {showRange ? (
          <Select
            value={rangeValue}
            onValueChange={(value) => value && onSearchChange({ ...search, range: value as WindowRange })}
          >
            <SelectTrigger className="w-24" aria-label="Time range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ranges.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Button variant="outline" size="sm" onClick={onCommand} className="hidden sm:inline-flex">
          <Search />
          Search
          <kbd className="ml-1 rounded border px-1 text-[10px] text-muted-foreground">⌘K</kbd>
        </Button>
        <Button variant="ghost" size="icon" asChild>
          <a href={DOCS_URL} target="_blank" rel="noreferrer" aria-label="Help">
            <CircleHelp />
          </a>
        </Button>
      </div>
    </header>
  );
}
