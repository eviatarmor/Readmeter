import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "next-themes";
import type { Me } from "@readmeter/console-api/contract";

import { DirectionProvider } from "@/components/ui/direction";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient } from "@/lib/query-client";
import { routeTree } from "@/routeTree.gen";

const me: Me = {
  user: { id: "user_admin", name: "Admin", email: "admin@readmeter.local", image: null },
  activeWorkspace: "local",
  workspaces: [
    { id: "org_local", name: "Local", slug: "local", role: "owner" },
    { id: "org_demo", name: "Demo", slug: "demo", role: "admin" },
  ],
};

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    getSession: vi.fn(async () => ({
      data: { user: { id: "user_admin", email: "admin@readmeter.local", name: "Admin" } },
    })),
    signOut: vi.fn(async () => ({ data: { success: true } })),
    useSession: () => ({ data: { user: { name: "Admin", email: "admin@readmeter.local" } }, isPending: false }),
    organization: {
      setActive: vi.fn(async () => ({ data: { id: "org_demo" } })),
    },
  },
}));

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/v1/me")) return json(me);
      if (url.includes("/overview")) {
        return json({
          rangeDays: 7,
          from: "2026-09-23T00:00:00.000Z",
          kpis: { events: 4, billedUnits: 4, estimatedCostMicros: 0, wastedMicros: 0, openFindings: 1 },
          series: [],
          topRules: [],
          topTemplates: [],
          topCallsites: [],
          openFindingsBySeverity: { critical: 1 },
        });
      }
      if (url.includes("/rules")) return json({ rules: [] });
      return json({ items: [], nextCursor: null });
    }),
  );
}

async function renderShell() {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/w/local/overview?range=7d"] }),
  });
  await router.load();
  render(
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} storageKey="readmeter-theme">
      <QueryClientProvider client={queryClient}>
        <DirectionProvider dir="ltr">
          <TooltipProvider>
            <RouterProvider router={router} />
          </TooltipProvider>
        </DirectionProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.cookie = "sidebar_state=true; path=/";
  queryClient.clear();
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("app shell", () => {
  it("collapses the sidebar to icons and lists workspaces", async () => {
    const user = userEvent.setup();
    await renderShell();
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(document.querySelector("[data-slot=sidebar][data-collapsible=icon]")).toBeNull();

    await user.click(document.querySelector("[data-slot=sidebar-trigger]") as HTMLElement);
    expect(document.querySelector("[data-slot=sidebar][data-collapsible=icon]")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: /Local/ }));
    expect(await screen.findByRole("menuitem", { name: /Demo/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Local/ })).toBeInTheDocument();
  });
});
