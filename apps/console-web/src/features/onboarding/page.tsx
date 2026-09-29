import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";

import type { CreatedApiKey, CreatedProject, Page, ProjectDetail, TelemetryEvent } from "@readmeter/console-api/contract";

import { CodeBlock, CopyButton } from "@/components/code-block";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { queryClient } from "@/lib/query-client";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = React.useState(0);
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [projectName, setProjectName] = React.useState("Demo");
  const [workspaceSlug, setWorkspaceSlug] = React.useState("");
  const [projectId, setProjectId] = React.useState("");
  const [snippets, setSnippets] = React.useState<{ web: string; functions: string } | null>(null);
  const [secret, setSecret] = React.useState("");

  const events = useQuery({
    queryKey: ["onboarding-events", workspaceSlug, projectId],
    enabled: step === 2 && workspaceSlug.length > 0 && projectId.length > 0,
    refetchInterval: 3000,
    queryFn: () =>
      api<Page<TelemetryEvent>>(
        `/api/v1/workspaces/${workspaceSlug}/events?project=${encodeURIComponent(projectId)}&limit=1`,
      ),
  });

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    if (!slugPattern.test(slug)) {
      toast.error("Slug must be lowercase letters, numbers, and hyphens");
      return;
    }
    try {
      const created = await api<{ id: string; slug: string }>("/api/v1/workspaces", {
        method: "POST",
        body: JSON.stringify({ name, slug }),
      });
      await authClient.organization.setActive({ organizationId: created.id });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      setWorkspaceSlug(created.slug);
      setStep(1);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not create the workspace");
    }
  }

  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    try {
      const created = await api<CreatedProject>(`/api/v1/workspaces/${workspaceSlug}/projects`, {
        method: "POST",
        body: JSON.stringify({ name: projectName, environment: "development" }),
      });
      const detail = await api<ProjectDetail>(`/api/v1/workspaces/${workspaceSlug}/projects/${created.id}`);
      const key = await api<CreatedApiKey>(`/api/v1/workspaces/${workspaceSlug}/projects/${created.id}/keys`, {
        method: "POST",
        body: JSON.stringify({ name: "first", allowedOrigins: [] }),
      });
      setProjectId(created.id);
      setSecret(key.key);
      setSnippets({
        web: detail.snippets.web.replaceAll("YOUR_API_KEY", key.key),
        functions: detail.snippets.functions.replaceAll("YOUR_API_KEY", key.key),
      });
      setStep(2);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not create the project");
    }
  }

  const seen = (events.data?.items.length ?? 0) > 0;

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <Logo />
          <CardTitle>Set up Readmeter</CardTitle>
          <CardDescription>Workspace, a project, and the first ingest key.</CardDescription>
        </CardHeader>
        <CardContent>
          {step === 0 ? (
            <form className="grid gap-3" onSubmit={(event) => void createWorkspace(event)}>
              <Label htmlFor="org-name">Workspace name</Label>
              <Input
                id="org-name"
                value={name}
                onChange={(event) => {
                  const next = event.target.value;
                  setName(next);
                  setSlug(next.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
                }}
                required
              />
              <Label htmlFor="org-slug">Slug</Label>
              <Input id="org-slug" value={slug} onChange={(event) => setSlug(event.target.value)} required />
              <Button type="submit">Continue</Button>
            </form>
          ) : null}
          {step === 1 ? (
            <form className="grid gap-3" onSubmit={(event) => void createProject(event)}>
              <Label htmlFor="project-name">First project</Label>
              <Input id="project-name" value={projectName} onChange={(event) => setProjectName(event.target.value)} required />
              <Button type="submit">Create project and key</Button>
            </form>
          ) : null}
          {step === 2 && snippets ? (
            <div className="grid gap-3">
              <p className="text-sm">Copy the key into your app. This page checks for an event every 3 seconds.</p>
              <p className="break-all font-mono text-xs" data-testid="onboarding-key">
                {secret}
              </p>
              <CopyButton value={secret} />
              <Tabs defaultValue="web">
                <TabsList>
                  <TabsTrigger value="web">Web</TabsTrigger>
                  <TabsTrigger value="functions">Cloud Functions</TabsTrigger>
                </TabsList>
                <TabsContent value="web">
                  <CodeBlock code={snippets.web} lang="ts" />
                </TabsContent>
                <TabsContent value="functions">
                  <CodeBlock code={snippets.functions} lang="ts" />
                </TabsContent>
              </Tabs>
              <p className="text-sm">{seen ? "Event received." : "Waiting for the first event…"}</p>
              <Button
                type="button"
                onClick={() => void navigate({ to: "/w/$slug/overview", params: { slug: workspaceSlug }, search: { range: "7d" } })}
              >
                Open the console
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
