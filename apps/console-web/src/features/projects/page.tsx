import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";

import type { Environment, ProjectDetail } from "@readmeter/console-api/contract";

import { CodeBlock, CopyButton } from "@/components/code-block";
import { Mono } from "@/components/severity-badge";
import { PageHeader, QueryError } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProject, useProjects } from "@/features/projects/queries";
import { ApiError, api } from "@/lib/api";
import { formatCount } from "@/lib/format-value";
import { canManage } from "@/lib/permissions";
import { queryClient } from "@/lib/query-client";
import type { WorkspaceSearch } from "@/lib/workspace-search";
import type { Role } from "@readmeter/console-api/contract";

const environments: Environment[] = ["production", "staging", "development"];

export function ProjectsPage({ slug, search, role }: { slug: string; search: WorkspaceSearch; role: Role | undefined }) {
  const query = useProjects(slug);
  const [open, setOpen] = React.useState(false);
  const manage = canManage(role);
  if (query.isError) return <QueryError message="Could not load projects" onRetry={() => void query.refetch()} />;
  const projects = (query.data ?? []).filter((project) => !search.project || project.id === search.project);
  return (
    <div className="grid gap-4">
      <PageHeader
        title="Projects"
        description="Each project has its own ingest keys and rule overrides."
        actions={
          manage ? (
            <Button onClick={() => setOpen(true)}>Create project</Button>
          ) : null
        }
      />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {projects.map((project) => (
          <Card key={project.id}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2 text-sm">
                <Link to="/w/$slug/projects/$projectId" params={{ slug, projectId: project.id }} search={search} className="truncate">
                  {project.name}
                </Link>
                <Badge variant="outline">{project.environment}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1 text-sm text-muted-foreground">
              <span>Firebase {project.firebaseProjectId ?? "—"}</span>
              <span>{formatCount(project.events24h)} events in 24h</span>
              <span>{formatCount(project.openFindings)} open findings</span>
              <RelativeTime value={project.createdAt} />
            </CardContent>
          </Card>
        ))}
      </div>
      {manage ? <CreateProjectDialog slug={slug} open={open} onOpenChange={setOpen} /> : null}
    </div>
  );
}

export function ProjectSettingsPage({
  slug,
  projectId,
  search,
  role,
}: {
  slug: string;
  projectId: string;
  search: WorkspaceSearch;
  role: Role | undefined;
}) {
  const query = useProject(slug, projectId);
  const manage = canManage(role);
  if (query.isLoading) return <PageHeader title="Project" />;
  if (query.isError || !query.data) return <QueryError message="Could not load project" onRetry={() => void query.refetch()} />;
  return (
    <ProjectSettingsBody slug={slug} project={query.data} search={search} manage={manage} />
  );
}

function ProjectSettingsBody({
  slug,
  project,
  search,
  manage,
}: {
  slug: string;
  project: ProjectDetail;
  search: WorkspaceSearch;
  manage: boolean;
}) {
  const [name, setName] = React.useState(project.name);
  const [environment, setEnvironment] = React.useState<Environment>(project.environment);
  const [firebaseProjectId, setFirebaseProjectId] = React.useState(project.firebaseProjectId ?? "");
  const [confirmDelete, setConfirmDelete] = React.useState("");
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/workspaces/${slug}/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          environment,
          firebaseProjectId: firebaseProjectId.length > 0 ? firebaseProjectId : null,
        }),
      }),
    onSuccess: () => {
      toast.success("Project saved");
      void queryClient.invalidateQueries({ queryKey: ["project", slug, project.id] });
      void queryClient.invalidateQueries({ queryKey: ["projects", slug] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not save project"),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/workspaces/${slug}/projects/${project.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Project deleted");
      window.location.assign(`/w/${slug}/projects`);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not delete project"),
  });
  return (
    <div className="grid gap-4">
      <PageHeader title={project.name} description={project.id} />
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="sdk">SDK</TabsTrigger>
          <TabsTrigger value="keys">Keys</TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="grid max-w-lg gap-3 pt-4">
          <Label htmlFor="project-name">Name</Label>
          <Input id="project-name" value={name} disabled={!manage} onChange={(event) => setName(event.target.value)} />
          <Label htmlFor="project-env">Environment</Label>
          <Select value={environment} onValueChange={(value) => value && setEnvironment(value as Environment)} disabled={!manage}>
            <SelectTrigger id="project-env">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {environments.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label htmlFor="project-firebase">Firebase project id</Label>
          <Input
            id="project-firebase"
            value={firebaseProjectId}
            disabled={!manage}
            onChange={(event) => setFirebaseProjectId(event.target.value)}
          />
          {manage ? (
            <div className="grid gap-2">
              <Button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
                Save
              </Button>
              <Label htmlFor="project-delete">Type the project name to delete it</Label>
              <Input id="project-delete" value={confirmDelete} onChange={(event) => setConfirmDelete(event.target.value)} />
              <Button
                type="button"
                variant="destructive"
                onClick={() => remove.mutate()}
                disabled={confirmDelete !== project.name || remove.isPending}
              >
                Delete project
              </Button>
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="sdk" className="grid gap-3 pt-4">
          <div className="flex items-center justify-between gap-3">
            <div className="grid gap-1">
              <span className="text-sm font-medium">Hash key</span>
              <Mono>{project.hashKey}</Mono>
            </div>
            <CopyButton value={project.hashKey} />
          </div>
          <p className="text-sm text-muted-foreground">Replace YOUR_API_KEY with a key from the Keys tab.</p>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Web</span>
            <CopyButton value={project.snippets.web} />
          </div>
          <CodeBlock code={project.snippets.web} lang="ts" />
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Cloud Functions</span>
            <CopyButton value={project.snippets.functions} />
          </div>
          <CodeBlock code={project.snippets.functions} lang="ts" />
        </TabsContent>
        <TabsContent value="keys" className="pt-4">
          <Button asChild>
            <Link to="/w/$slug/keys" params={{ slug }} search={{ ...search, project: project.id }}>
              Manage API keys
            </Link>
          </Button>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CreateProjectDialog({ slug, open, onOpenChange }: { slug: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = React.useState("");
  const [environment, setEnvironment] = React.useState<Environment>("production");
  const [firebaseProjectId, setFirebaseProjectId] = React.useState("");
  const create = useMutation({
    mutationFn: () =>
      api(`/api/v1/workspaces/${slug}/projects`, {
        method: "POST",
        body: JSON.stringify({
          name,
          environment,
          firebaseProjectId: firebaseProjectId.length > 0 ? firebaseProjectId : null,
        }),
      }),
    onSuccess: () => {
      toast.success("Project created");
      onOpenChange(false);
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["projects", slug] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not create project"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Label htmlFor="new-project-name">Name</Label>
          <Input id="new-project-name" value={name} onChange={(event) => setName(event.target.value)} />
          <Label>Environment</Label>
          <Select value={environment} onValueChange={(value) => value && setEnvironment(value as Environment)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {environments.map((item) => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label htmlFor="new-project-firebase">Firebase project id</Label>
          <Input id="new-project-firebase" value={firebaseProjectId} onChange={(event) => setFirebaseProjectId(event.target.value)} />
        </div>
        <DialogFooter>
          <Button type="button" disabled={name.length === 0 || create.isPending} onClick={() => create.mutate()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
