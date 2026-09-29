import {
  Activity,
  CircleDollarSign,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  Plug,
  Settings,
  SlidersHorizontal,
  TriangleAlert,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavItem {
  title: string;
  to:
    | "/w/$slug/overview"
    | "/w/$slug/findings"
    | "/w/$slug/events"
    | "/w/$slug/costs"
    | "/w/$slug/rules"
    | "/w/$slug/projects"
    | "/w/$slug/keys"
    | "/w/$slug/integrations"
    | "/w/$slug/members"
    | "/w/$slug/settings";
  icon: LucideIcon;
  badge?: "findings";
}

export const monitorNav: NavItem[] = [
  { title: "Overview", to: "/w/$slug/overview", icon: LayoutDashboard },
  { title: "Findings", to: "/w/$slug/findings", icon: TriangleAlert, badge: "findings" },
  { title: "Events", to: "/w/$slug/events", icon: Activity },
  { title: "Costs", to: "/w/$slug/costs", icon: CircleDollarSign },
];

export const configureNav: NavItem[] = [
  { title: "Rules", to: "/w/$slug/rules", icon: SlidersHorizontal },
  { title: "Projects", to: "/w/$slug/projects", icon: FolderKanban },
  { title: "API keys", to: "/w/$slug/keys", icon: KeyRound },
  { title: "Integrations", to: "/w/$slug/integrations", icon: Plug },
];

export const workspaceNav: NavItem[] = [
  { title: "Members", to: "/w/$slug/members", icon: Users },
  { title: "Settings", to: "/w/$slug/settings", icon: Settings },
];

export const pageTitles: Record<string, string> = {
  overview: "Overview",
  findings: "Findings",
  events: "Events",
  costs: "Costs",
  rules: "Rules",
  projects: "Projects",
  keys: "API keys",
  integrations: "Integrations",
  members: "Members",
  settings: "Settings",
  account: "Profile",
};

export const DOCS_URL = "https://github.com/eviatarmor/Readmeter";
