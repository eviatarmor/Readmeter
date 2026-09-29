import { useMutation } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";

import type { AuditEntry, Role } from "@readmeter/console-api/contract";

import { PageHeader, QueryError } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { ResourceTable } from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAudit, useWorkspace } from "@/features/settings/queries";
import { ApiError, api } from "@/lib/api";
import type { DataTableFeatures } from "@/lib/data-table-features";
import type { QueryKeys } from "@/lib/data-table-types";
import { canDeleteWorkspace, canManage } from "@/lib/permissions";
import { queryClient } from "@/lib/query-client";

const auditKeys: QueryKeys = {
  page: "apage",
  perPage: "aperPage",
  sort: "asort",
  filters: "afilters",
  joinOperator: "ajoin",
};

export function SettingsPage({ slug, role }: { slug: string; role: Role | undefined }) {
  const workspace = useWorkspace(slug);
  const manage = canManage(role);
  const owner = canDeleteWorkspace(role);
  const audit = useAudit(slug, manage);
  if (workspace.isError) return <QueryError message="Could not load settings" onRetry={() => void workspace.refetch()} />;
  return (
    <div className="grid gap-4">
      <PageHeader title="Settings" description="Workspace name, audit log, and deletion." />
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          {manage ? <TabsTrigger value="audit">Audit</TabsTrigger> : null}
          {owner ? <TabsTrigger value="danger">Danger zone</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="general" className="max-w-lg pt-4">
          {workspace.data ? (
            <GeneralForm
              slug={slug}
              name={workspace.data.name}
              currentSlug={workspace.data.slug}
              logo={workspace.data.logo}
              manage={manage}
            />
          ) : null}
        </TabsContent>
        {manage ? (
          <TabsContent value="audit" className="pt-4">
            <ResourceTable
              data={audit.data ?? []}
              columns={auditColumns}
              getRowId={(row) => String(row.id)}
              queryKeys={auditKeys}
              isLoading={audit.isLoading}
            />
          </TabsContent>
        ) : null}
        {owner && workspace.data ? (
          <TabsContent value="danger" className="max-w-lg pt-4">
            <DangerZone slug={workspace.data.slug} />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}

function GeneralForm({
  slug,
  name,
  currentSlug,
  logo,
  manage,
}: {
  slug: string;
  name: string;
  currentSlug: string;
  logo: string | null;
  manage: boolean;
}) {
  const navigate = useNavigate();
  const [nextName, setNextName] = React.useState(name);
  const [nextSlug, setNextSlug] = React.useState(currentSlug);
  const [nextLogo, setNextLogo] = React.useState(logo ?? "");
  const save = useMutation({
    mutationFn: () =>
      api<{ slug: string }>(`/api/v1/workspaces/${slug}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: nextName,
          slug: nextSlug,
          logo: nextLogo.length > 0 ? nextLogo : null,
        }),
      }),
    onSuccess: async (updated) => {
      toast.success("Workspace saved");
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      await navigate({ to: "/w/$slug/settings", params: { slug: updated.slug }, search: { range: "7d" } });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not save workspace"),
  });
  return (
    <div className="grid gap-3">
      <Label htmlFor="ws-name">Name</Label>
      <Input id="ws-name" value={nextName} disabled={!manage} onChange={(event) => setNextName(event.target.value)} />
      <Label htmlFor="ws-slug">Slug</Label>
      <Input id="ws-slug" value={nextSlug} disabled={!manage} onChange={(event) => setNextSlug(event.target.value)} />
      <Label htmlFor="ws-logo">Logo URL</Label>
      <Input id="ws-logo" value={nextLogo} disabled={!manage} onChange={(event) => setNextLogo(event.target.value)} />
      {manage ? (
        <Button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
          Save
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">Members can view these settings.</p>
      )}
    </div>
  );
}

function DangerZone({ slug }: { slug: string }) {
  const navigate = useNavigate();
  const [confirm, setConfirm] = React.useState("");
  const remove = useMutation({
    mutationFn: () =>
      api(`/api/v1/workspaces/${slug}`, { method: "DELETE", body: JSON.stringify({ confirm: slug }) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      await navigate({ to: "/" });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not delete workspace"),
  });
  return (
    <div className="grid gap-3 rounded-lg border border-destructive/40 p-4">
      <p className="text-sm">Type the slug {slug} to delete this workspace.</p>
      <Input value={confirm} onChange={(event) => setConfirm(event.target.value)} aria-label="Confirm slug" />
      <Button type="button" variant="destructive" disabled={confirm !== slug || remove.isPending} onClick={() => remove.mutate()}>
        Delete workspace
      </Button>
    </div>
  );
}

const auditColumns: ColumnDef<DataTableFeatures, AuditEntry>[] = [
  {
    id: "at",
    accessorKey: "at",
    header: "When",
    cell: ({ row }) => <RelativeTime value={row.original.at} />,
  },
  { id: "action", accessorKey: "action", header: "Action", enableColumnFilter: true, meta: { label: "Action", variant: "text" } },
  { id: "actor", accessorKey: "actor", header: "Actor" },
  { id: "target", accessorKey: "target", header: "Target" },
];
