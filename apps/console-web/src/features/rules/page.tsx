import { useMutation } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import * as React from "react";
import { toast } from "sonner";

import { SEVERITY_ORDER, type RuleRow } from "@readmeter/console-api/contract";

import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { EmptyState, PageHeader, QueryError } from "@/components/page-header";
import { ResourceTable } from "@/components/resource-table";
import { Mono, SeverityBadge } from "@/components/severity-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRules } from "@/features/rules/queries";
import { ApiError, api } from "@/lib/api";
import type { DataTableFeatures } from "@/lib/data-table-features";
import type { QueryKeys } from "@/lib/data-table-types";
import { canManage } from "@/lib/permissions";
import { ServiceName, serviceOptions } from "@/lib/services";
import { queryClient } from "@/lib/query-client";
import type { WorkspaceSearch } from "@/lib/workspace-search";
import type { Role } from "@readmeter/console-api/contract";

const ruleKeys: QueryKeys = {
  page: "rpage",
  perPage: "rperPage",
  sort: "rsort",
  filters: "rfilters",
  joinOperator: "rjoin",
};

export function RulesPage({ slug, search, role }: { slug: string; search: WorkspaceSearch; role: Role | undefined }) {
  const query = useRules(slug, search.project);
  const [selected, setSelected] = React.useState<RuleRow | null>(null);
  const manage = canManage(role);
  const columns = React.useMemo(() => ruleColumns(manage), [manage]);
  if (!search.project) {
    return (
      <div className="grid gap-4">
        <PageHeader title="Rules" description="Pick a project in the navbar to view and override rules." />
        <EmptyState title="No project selected" body="Rule overrides are stored per project." />
      </div>
    );
  }
  if (query.isError) return <QueryError message="Could not load rules" onRetry={() => void query.refetch()} />;
  return (
    <div className="grid gap-4">
      <PageHeader title="Rules" description="Catalog defaults, plus any override saved for this project." />
      <ResourceTable
        data={query.data?.rules ?? []}
        columns={columns}
        getRowId={(row) => row.id}
        queryKeys={ruleKeys}
        isLoading={query.isLoading}
        onRowClick={setSelected}
      />
      <RuleSheet
        slug={slug}
        projectId={search.project}
        rule={selected}
        manage={manage}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function ruleColumns(manage: boolean): ColumnDef<DataTableFeatures, RuleRow>[] {
  return [
    {
      id: "title",
      accessorKey: "title",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Rule" />,
      cell: ({ row }) => (
        <div className="grid">
          <span>{row.original.title}</span>
          <Mono>{row.original.id}</Mono>
        </div>
      ),
      enableColumnFilter: true,
      meta: { label: "Rule", variant: "text" },
    },
    {
      id: "severity",
      accessorKey: "severity",
      header: "Severity",
      cell: ({ row }) => <SeverityBadge severity={row.original.effective?.severity ?? row.original.severity} />,
      enableColumnFilter: true,
      meta: {
        label: "Severity",
        variant: "multiSelect",
        options: SEVERITY_ORDER.map((value) => ({
          label: value,
          value,
        })),
      },
    },
    {
      id: "service",
      accessorKey: "service",
      header: "Service",
      cell: ({ row }) => <ServiceName service={row.original.service} />,
      enableColumnFilter: true,
      meta: { label: "Service", variant: "multiSelect", options: serviceOptions },
    },
    {
      id: "status",
      accessorKey: "status",
      header: "Catalog",
      cell: ({ row }) => row.original.status,
    },
    {
      id: "enabled",
      header: "Enabled",
      cell: ({ row }) => {
        const planned = row.original.status === "planned";
        const checked = row.original.effective?.enabled ?? row.original.default_enabled;
        const control = <Switch checked={checked} disabled={!manage || planned} aria-label={`Enable ${row.original.id}`} />;
        if (!planned) return control;
        return (
          <Tooltip>
            <TooltipTrigger asChild>{control}</TooltipTrigger>
            <TooltipContent>Planned rules cannot be enabled yet.</TooltipContent>
          </Tooltip>
        );
      },
    },
  ];
}

function RuleSheet({
  slug,
  projectId,
  rule,
  manage,
  onClose,
}: {
  slug: string;
  projectId: string;
  rule: RuleRow | null;
  manage: boolean;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = React.useState(true);
  const [severity, setSeverity] = React.useState("medium");
  const [params, setParams] = React.useState<Record<string, number | boolean | string>>({});
  React.useEffect(() => {
    if (!rule) return;
    setEnabled(rule.effective?.enabled ?? rule.default_enabled);
    setSeverity(rule.effective?.severity ?? rule.severity);
    setParams({ ...rule.params, ...rule.effective?.params });
  }, [rule]);
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/workspaces/${slug}/projects/${projectId}/rules/${encodeURIComponent(rule?.id ?? "")}`, {
        method: "PUT",
        body: JSON.stringify({ enabled, severity, params }),
      }),
    onSuccess: () => {
      toast.success("Override saved");
      void queryClient.invalidateQueries({ queryKey: ["rules", slug] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not save override"),
  });
  const reset = useMutation({
    mutationFn: () =>
      api(`/api/v1/workspaces/${slug}/projects/${projectId}/rules/${encodeURIComponent(rule?.id ?? "")}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Override removed");
      void queryClient.invalidateQueries({ queryKey: ["rules", slug] });
      onClose();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not reset override"),
  });
  const planned = rule?.status === "planned";
  return (
    <Sheet open={rule !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{rule?.title}</SheetTitle>
          <SheetDescription>
            <Mono>{rule?.id}</Mono>
          </SheetDescription>
        </SheetHeader>
        {rule ? (
          <div className="grid gap-4 px-4 pb-6 text-sm">
            <p>{rule.description}</p>
            <p className="text-muted-foreground">{rule.fix}</p>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="rule-enabled">Enabled</Label>
              <Switch id="rule-enabled" checked={enabled} disabled={!manage || planned} onCheckedChange={setEnabled} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rule-severity">Severity override</Label>
              <Select value={severity} disabled={!manage} onValueChange={(value) => value && setSeverity(value)}>
                <SelectTrigger id="rule-severity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITY_ORDER.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {Object.entries(params).map(([key, value]) => (
              <div key={key} className="grid gap-2">
                <Label htmlFor={`param-${key}`}>{key}</Label>
                {typeof value === "boolean" ? (
                  <Switch
                    id={`param-${key}`}
                    checked={value}
                    disabled={!manage}
                    onCheckedChange={(next) => setParams((current) => ({ ...current, [key]: next }))}
                  />
                ) : (
                  <Input
                    id={`param-${key}`}
                    type={typeof value === "number" ? "number" : "text"}
                    value={String(value)}
                    disabled={!manage}
                    onChange={(event) => {
                      const next = typeof value === "number" ? Number(event.target.value) : event.target.value;
                      setParams((current) => ({ ...current, [key]: next }));
                    }}
                  />
                )}
              </div>
            ))}
            {manage ? (
              <div className="flex gap-2">
                <Button type="button" disabled={planned || save.isPending} onClick={() => save.mutate()}>
                  Save override
                </Button>
                <Button type="button" variant="outline" disabled={reset.isPending} onClick={() => reset.mutate()}>
                  Reset
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground">Members can read rules. Owners and admins can save overrides.</p>
            )}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
