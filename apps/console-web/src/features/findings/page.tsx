import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Subscribe, type ColumnDef, type Table } from "@tanstack/react-table";
import * as React from "react";
import { toast } from "sonner";

import type { FindingStatus } from "@readmeter/console-api/contract";

import { CodeBlock } from "@/components/code-block";
import { PageHeader, QueryError } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { ResourceTable } from "@/components/resource-table";
import { Mono, SeverityBadge, StatusBadge } from "@/components/severity-badge";
import {
  ActionBar,
  ActionBarGroup,
  ActionBarItem,
  ActionBarSelection,
  ActionBarSeparator,
} from "@/components/ui/action-bar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { findingKeys, useFinding, useFindingRows, type FindingRow } from "@/features/findings/queries";
import { useMembers } from "@/features/members/queries";
import { ApiError, api } from "@/lib/api";
import type { DataTableFeatures } from "@/lib/data-table-features";
import { formatCount, formatMoney } from "@/lib/format-value";
import { queryClient } from "@/lib/query-client";
import type { WorkspaceSearch } from "@/lib/workspace-search";

const statuses: FindingStatus[] = ["open", "resolved", "ignored"];

export function FindingsPage({
  slug,
  search,
  findingId,
}: {
  slug: string;
  search: WorkspaceSearch;
  findingId?: string;
}) {
  const navigate = useNavigate();
  const query = useFindingRows(slug, search.project, search.range);
  const columns = React.useMemo(() => findingColumns(), []);
  const bulk = useMutation({
    mutationFn: (input: { ids: number[]; status: FindingStatus }) =>
      api<{ updated: number }>(`/api/v1/workspaces/${slug}/findings/bulk`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (result) => {
      toast.success(`Updated ${result.updated} findings`);
      void queryClient.invalidateQueries({ queryKey: ["findings", slug] });
      void queryClient.invalidateQueries({ queryKey: ["finding-badge", slug] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not update findings"),
  });

  if (query.isError) {
    return <QueryError message={query.error instanceof Error ? query.error.message : "Could not load findings"} onRetry={() => void query.refetch()} />;
  }

  return (
    <div className="grid gap-4">
      <PageHeader title="Findings" description="Open issues from the rule catalog, priced from wasted work." />
      <ResourceTable
        data={query.rows}
        columns={columns}
        getRowId={(row) => String(row.id)}
        queryKeys={findingKeys}
        isLoading={query.isLoading}
        onRowClick={(row) => {
          void navigate({
            to: "/w/$slug/findings/$id",
            params: { slug, id: String(row.id) },
            search,
          });
        }}
        actionBar={(table) => (
          <ActionBar open>
            <ActionBarSelection>
              <SelectionCount table={table} />
            </ActionBarSelection>
            <ActionBarSeparator />
            <ActionBarGroup>
              <ActionBarItem onClick={() => bulk.mutate({ ids: selectedIds(table), status: "resolved" })}>
                Resolve
              </ActionBarItem>
              <ActionBarItem onClick={() => bulk.mutate({ ids: selectedIds(table), status: "ignored" })}>
                Ignore
              </ActionBarItem>
              <ActionBarItem onClick={() => bulk.mutate({ ids: selectedIds(table), status: "open" })}>
                Reopen
              </ActionBarItem>
            </ActionBarGroup>
          </ActionBar>
        )}
      />
      <FindingSheet
        slug={slug}
        search={search}
        findingId={findingId}
        onClose={() => {
          void navigate({ to: "/w/$slug/findings", params: { slug }, search });
        }}
      />
    </div>
  );
}

function SelectionCount({ table }: { table: Table<DataTableFeatures, FindingRow> }) {
  return (
    <Subscribe source={table.atoms.rowSelection} selector={() => table.getSelectedRowModel().rows.length}>
      {(count) => <span>{count} selected</span>}
    </Subscribe>
  );
}

function selectedIds(table: Table<DataTableFeatures, FindingRow>): number[] {
  return table.getSelectedRowModel().rows.map((row) => row.original.id);
}

function findingColumns(): ColumnDef<DataTableFeatures, FindingRow>[] {
  return [
    {
      id: "select",
      header: ({ table }) => (
        <Checkbox
          aria-label="Select all"
          checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")}
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(value === true)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label="Select row"
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(value === true)}
        />
      ),
      enableSorting: false,
      enableHiding: false,
    },
    {
      id: "severity",
      accessorKey: "severity",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Severity" />,
      cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
      enableColumnFilter: true,
      meta: {
        label: "Severity",
        variant: "multiSelect",
        options: ["critical", "high", "medium", "low", "info"].map((value) => ({
          label: value[0]!.toUpperCase() + value.slice(1),
          value,
        })),
      },
    },
    {
      id: "rule",
      accessorKey: "ruleTitle",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Rule" />,
      cell: ({ row }) => (
        <div className="grid">
          <span className="truncate">{row.original.ruleTitle}</span>
          <Mono>{row.original.rule}</Mono>
        </div>
      ),
      enableColumnFilter: true,
      meta: { label: "Rule", variant: "text", placeholder: "Rule id" },
    },
    {
      id: "message",
      accessorKey: "message",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Message" />,
      cell: ({ row }) => <span className="line-clamp-2 max-w-md">{row.original.message}</span>,
    },
    {
      id: "service",
      accessorKey: "service",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Service" />,
      enableColumnFilter: true,
      meta: { label: "Service", variant: "text" },
    },
    {
      id: "template",
      accessorKey: "template",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Template" />,
      cell: ({ row }) => <Mono>{row.original.template}</Mono>,
      enableColumnFilter: true,
      meta: { label: "Template", variant: "text" },
    },
    {
      id: "callsite",
      accessorKey: "callsite",
      header: "Callsite",
      cell: ({ row }) => <Mono>{row.original.callsite}</Mono>,
    },
    {
      id: "occurrences",
      accessorKey: "occurrences",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Count" />,
      cell: ({ row }) => formatCount(row.original.occurrences),
    },
    {
      id: "wastedMicros",
      accessorKey: "wastedMicros",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Wasted" />,
      cell: ({ row }) => (
        <div className="grid">
          <span>{formatMoney(row.original.wastedMicros)}</span>
          <span className="text-xs text-muted-foreground">{formatUnits(row.original.wasted)}</span>
        </div>
      ),
    },
    {
      id: "lastSeen",
      accessorKey: "lastSeen",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Last seen" />,
      cell: ({ row }) => <RelativeTime value={row.original.lastSeen} />,
    },
    {
      id: "status",
      accessorKey: "status",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      enableColumnFilter: true,
      meta: {
        label: "Status",
        variant: "multiSelect",
        options: statuses.map((value) => ({ label: value[0]!.toUpperCase() + value.slice(1), value })),
      },
    },
    {
      id: "assignee",
      accessorKey: "assignee",
      header: "Assignee",
      cell: ({ row }) => row.original.assignee ?? "—",
    },
  ];
}

function formatUnits(wasted: Record<string, number>): string {
  const parts = Object.entries(wasted).filter(([, value]) => value !== 0);
  if (parts.length === 0) return "—";
  return parts.map(([key, value]) => `${formatCount(value)} ${key}`).join(", ");
}

function FindingSheet({
  slug,
  search,
  findingId,
  onClose,
}: {
  slug: string;
  search: WorkspaceSearch;
  findingId?: string;
  onClose: () => void;
}) {
  const detail = useFinding(slug, findingId);
  const members = useMembers(slug);
  const [status, setStatus] = React.useState<FindingStatus>("open");
  const [assignee, setAssignee] = React.useState("none");
  const [note, setNote] = React.useState("");

  React.useEffect(() => {
    if (!detail.data) return;
    setStatus((detail.data.status === "resolved" || detail.data.status === "ignored" ? detail.data.status : "open"));
    setAssignee(detail.data.assignee ?? "none");
    setNote(detail.data.note ?? "");
  }, [detail.data]);

  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/workspaces/${slug}/findings/${findingId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status,
          assignee: assignee === "none" ? null : assignee,
          note: note.length > 0 ? note : null,
        }),
      }),
    onSuccess: () => {
      toast.success("Finding updated");
      void queryClient.invalidateQueries({ queryKey: ["findings", slug] });
      void queryClient.invalidateQueries({ queryKey: ["finding", slug, findingId] });
      void queryClient.invalidateQueries({ queryKey: ["finding-badge", slug] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not update finding"),
  });

  const row = detail.data;
  return (
    <Sheet open={Boolean(findingId)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{row?.rule?.title ?? "Finding"}</SheetTitle>
          <SheetDescription>{row?.message ?? "Loading finding"}</SheetDescription>
        </SheetHeader>
        {detail.isError ? (
          <QueryError message="Could not load this finding" onRetry={() => void detail.refetch()} />
        ) : null}
        {row ? (
          <div className="grid gap-4 px-4 pb-6">
            <div className="flex flex-wrap gap-2">
              <SeverityBadge severity={row.severity} />
              <StatusBadge status={row.status} />
              <span className="text-sm text-muted-foreground">{formatMoney(row.wastedMicros)} wasted</span>
            </div>
            {row.rule ? (
              <div className="grid gap-2 text-sm">
                <p>{row.rule.summary}</p>
                <p className="text-muted-foreground">{row.rule.fix}</p>
                {row.rule.docs.map((href) => (
                  <a key={href} href={href} className="text-primary underline" target="_blank" rel="noreferrer">
                    {href}
                  </a>
                ))}
              </div>
            ) : null}
            {row.rule?.examples.map((example) => (
              <div key={`${example.lang}-${example.bad}`} className="grid gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Avoid</p>
                <CodeBlock code={example.bad} lang={example.lang} />
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Prefer</p>
                <CodeBlock code={example.good} lang={example.lang} />
              </div>
            ))}
            <pre className="overflow-auto rounded-lg border bg-muted/40 p-3 text-xs">
              {JSON.stringify(row.evidence, null, 2)}
            </pre>
            <div className="grid gap-2">
              <Label htmlFor="finding-status">Status</Label>
              <Select value={status} onValueChange={(value) => value && setStatus(value as FindingStatus)}>
                <SelectTrigger id="finding-status" data-testid="finding-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statuses.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item[0]!.toUpperCase() + item.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="finding-assignee">Assignee</Label>
              <Select value={assignee} onValueChange={(value) => value && setAssignee(value)}>
                <SelectTrigger id="finding-assignee">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {(members.data ?? []).map((member) => (
                    <SelectItem key={member.user.id} value={member.user.id}>
                      {member.user.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="finding-note">Note</Label>
              <Textarea id="finding-note" value={note} onChange={(event) => setNote(event.target.value)} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
                Save
              </Button>
              <Button variant="outline" asChild>
                <Link to="/w/$slug/events" params={{ slug }} search={search}>
                  View events
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link to="/w/$slug/rules" params={{ slug }} search={{ ...search, project: row.projectId }}>
                  Configure rule
                </Link>
              </Button>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
