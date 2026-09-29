import { useMutation } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import * as React from "react";
import { toast } from "sonner";

import type { CreatedApiKey } from "@readmeter/console-api/contract";

import { CopyButton } from "@/components/code-block";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { EmptyState, PageHeader, QueryError } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { ResourceTable } from "@/components/resource-table";
import { Mono } from "@/components/severity-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { keyTableKeys, useKeys, type KeyRow } from "@/features/keys/queries";
import { useProjects } from "@/features/projects/queries";
import { ApiError, api } from "@/lib/api";
import type { DataTableFeatures } from "@/lib/data-table-features";
import { canManage } from "@/lib/permissions";
import { queryClient } from "@/lib/query-client";
import type { WorkspaceSearch } from "@/lib/workspace-search";
import type { Role } from "@readmeter/console-api/contract";

export function KeysPage({ slug, search, role }: { slug: string; search: WorkspaceSearch; role: Role | undefined }) {
  const projects = useProjects(slug);
  const scoped = (projects.data ?? []).filter((project) => !search.project || project.id === search.project);
  const keys = useKeys(slug, scoped);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [created, setCreated] = React.useState<CreatedApiKey | null>(null);
  const [revoke, setRevoke] = React.useState<KeyRow | null>(null);
  const manage = canManage(role);
  const columns = React.useMemo(() => keyColumns(manage, setRevoke), [manage]);
  if (projects.isError || keys.isError) return <QueryError message="Could not load API keys" onRetry={() => void keys.refetch()} />;
  return (
    <div className="grid gap-4">
      <PageHeader
        title="API keys"
        description="A key is shown once, when you create it."
        actions={
          manage ? (
            <Button onClick={() => setCreateOpen(true)} disabled={scoped.length === 0}>
              Create key
            </Button>
          ) : null
        }
      />
      {scoped.length === 0 ? <EmptyState title="No project" body="Create a project before issuing a key." /> : null}
      <ResourceTable
        data={keys.data ?? []}
        columns={columns}
        getRowId={(row) => row.id}
        queryKeys={keyTableKeys}
        isLoading={projects.isLoading || keys.isLoading}
      />
      <CreateKeyDialog
        slug={slug}
        projectId={search.project ?? scoped[0]?.id}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={setCreated}
      />
      <Dialog open={created !== null} onOpenChange={(open) => !open && setCreated(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy this key</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">This is the only time the full key is available.</p>
          <p className="break-all font-mono text-sm" data-testid="api-key-secret">
            {created?.key}
          </p>
          {created ? <CopyButton value={created.key} /> : null}
        </DialogContent>
      </Dialog>
      <AlertDialog open={revoke !== null} onOpenChange={(open) => !open && setRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoke?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Requests that use this key will be rejected.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!revoke) return;
                void api(`/api/v1/workspaces/${slug}/projects/${revoke.projectId}/keys/${revoke.id}`, { method: "DELETE" })
                  .then(() => {
                    toast.success("Key revoked");
                    setRevoke(null);
                    void queryClient.invalidateQueries({ queryKey: ["keys", slug] });
                  })
                  .catch((error: unknown) => toast.error(error instanceof ApiError ? error.message : "Could not revoke key"));
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function keyColumns(manage: boolean, onRevoke: (row: KeyRow) => void): ColumnDef<DataTableFeatures, KeyRow>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Name" />,
      enableColumnFilter: true,
      meta: { label: "Name", variant: "text" },
    },
    {
      id: "projectName",
      accessorKey: "projectName",
      header: "Project",
    },
    {
      id: "prefix",
      accessorKey: "prefix",
      header: "Prefix",
      cell: ({ row }) => <Mono>{row.original.prefix}</Mono>,
    },
    {
      id: "allowedOrigins",
      accessorKey: "allowedOrigins",
      header: "Origins",
      cell: ({ row }) => (row.original.allowedOrigins.length > 0 ? row.original.allowedOrigins.join(", ") : "Any"),
    },
    {
      id: "lastUsedAt",
      accessorKey: "lastUsedAt",
      header: "Last used",
      cell: ({ row }) => (row.original.lastUsedAt ? <RelativeTime value={row.original.lastUsedAt} /> : "—"),
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => (row.original.revokedAt ? "Revoked" : "Active"),
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: "Created",
      cell: ({ row }) => <RelativeTime value={row.original.createdAt} />,
    },
    {
      id: "creator",
      header: "Created by",
      cell: ({ row }) => row.original.creator?.name ?? "—",
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) =>
        manage && row.original.revokedAt === null ? (
          <Button variant="outline" size="sm" onClick={() => onRevoke(row.original)}>
            Revoke
          </Button>
        ) : null,
    },
  ];
}

function CreateKeyDialog({
  slug,
  projectId,
  open,
  onOpenChange,
  onCreated,
}: {
  slug: string;
  projectId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: CreatedApiKey) => void;
}) {
  const [name, setName] = React.useState("");
  const [origins, setOrigins] = React.useState("");
  const create = useMutation({
    mutationFn: () =>
      api<CreatedApiKey>(`/api/v1/workspaces/${slug}/projects/${projectId}/keys`, {
        method: "POST",
        body: JSON.stringify({
          name,
          allowedOrigins: origins
            .split(/[\n,]/)
            .map((item) => item.trim())
            .filter((item) => item.length > 0),
        }),
      }),
    onSuccess: (key) => {
      setName("");
      setOrigins("");
      onOpenChange(false);
      onCreated(key);
      void queryClient.invalidateQueries({ queryKey: ["keys", slug] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not create key"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Label htmlFor="key-name">Name</Label>
          <Input id="key-name" value={name} onChange={(event) => setName(event.target.value)} />
          <Label htmlFor="key-origins">Allowed origins</Label>
          <Input
            id="key-origins"
            placeholder="https://app.example.com"
            value={origins}
            onChange={(event) => setOrigins(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" disabled={!projectId || name.length === 0 || create.isPending} onClick={() => create.mutate()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
