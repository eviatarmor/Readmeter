import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Subscribe, type ColumnDef, type Table as ReactTable } from "@tanstack/react-table";
import { Area, AreaChart, XAxis } from "recharts";
import * as React from "react";
import { toast } from "sonner";

import { SEVERITY_ORDER, type FindingStatus } from "@readmeter/console-api/contract";

import { CodeBlock } from "@/components/code-block";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { PageHeader, QueryError } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { ResourceTable } from "@/components/resource-table";
import { SeverityBadge, StatusBadge } from "@/components/severity-badge";
import {
  ActionBar,
  ActionBarGroup,
  ActionBarItem,
  ActionBarSelection,
  ActionBarSeparator,
} from "@/components/ui/action-bar";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { findingKeys, useFinding, useFindingRows, type FindingRow } from "@/features/findings/queries";
import { useMembers } from "@/features/members/queries";
import { ApiError, api } from "@/lib/api";
import type { DataTableFeatures } from "@/lib/data-table-features";
import { formatCount, formatMoney } from "@/lib/format-value";
import { ServiceName, serviceOptions } from "@/lib/services";
import { queryClient } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import type { WorkspaceSearch } from "@/lib/workspace-search";

const statuses: FindingStatus[] = ["open", "resolved", "ignored"];
const severityOptions = SEVERITY_ORDER.map((value) => ({
  label: value[0]!.toUpperCase() + value.slice(1),
  value,
}));
const hiddenFindingColumns = { message: false, callsite: false };
const sparkConfig = { occurrences: { label: "Occurrences", color: "var(--foreground)" } } satisfies ChartConfig;

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
    mutationFn: (input: { ids: Array<number | string>; status: FindingStatus }) =>
      api<{ updated: number }>(`/api/v1/workspaces/${slug}/findings/bulk`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (result) => {
      toast.success(`Updated ${result.updated} findings`);
      void queryClient.invalidateQueries({ queryKey: ["findings", slug] });
      void queryClient.invalidateQueries({ queryKey: ["finding-badge", slug] });
      void queryClient.invalidateQueries({ queryKey: ["overview", slug] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not update findings"),
  });

  if (query.isError) {
    return <QueryError message={query.error instanceof Error ? query.error.message : "Could not load findings"} onRetry={() => void query.refetch()} />;
  }

  return (
    <div className="grid gap-4">
      <PageHeader title="Findings" description="Each row is one issue: the same rule, template, and callsite across sessions." />
      <div data-testid="findings-table" className="min-w-0">
      <ResourceTable
        data={query.rows}
        columns={columns}
        getRowId={(row) => String(row.id)}
        queryKeys={findingKeys}
        isLoading={query.isLoading}
        columnVisibility={hiddenFindingColumns}
        tableClassName="table-fixed"
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
      </div>
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

function SelectionCount({ table }: { table: ReactTable<DataTableFeatures, FindingRow> }) {
  return (
    <Subscribe source={table.atoms.rowSelection} selector={() => table.getSelectedRowModel().rows.length}>
      {(count) => <span>{count} selected</span>}
    </Subscribe>
  );
}

function selectedIds(table: ReactTable<DataTableFeatures, FindingRow>): Array<number | string> {
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
      meta: { width: "4%" },
    },
    {
      id: "severity",
      accessorKey: "severity",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Severity" />,
      cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
      enableColumnFilter: true,
      meta: { label: "Severity", variant: "multiSelect", options: severityOptions, width: "10%" },
    },
    {
      id: "rule",
      accessorKey: "ruleTitle",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Rule" />,
      cell: ({ row }) => (
        <div className="grid min-w-0">
          <Truncate text={row.original.ruleTitle} />
          <Truncate text={row.original.rule} className="font-mono text-xs text-muted-foreground" />
        </div>
      ),
      enableColumnFilter: true,
      meta: { label: "Rule", variant: "text", placeholder: "Rule id", width: "24%" },
    },
    {
      id: "template",
      accessorKey: "template",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Template" />,
      cell: ({ row }) => <Truncate text={row.original.template} className="font-mono text-xs" />,
      enableColumnFilter: true,
      meta: { label: "Template", variant: "text", width: "8%" },
    },
    {
      id: "service",
      accessorKey: "service",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Service" />,
      cell: ({ row }) => <ServiceName service={row.original.service} />,
      enableColumnFilter: true,
      meta: { label: "Service", variant: "multiSelect", options: serviceOptions, width: "12%" },
    },
    {
      id: "sessions",
      accessorKey: "sessions",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Sessions" className="ml-auto" />,
      cell: ({ row }) => <div className="text-right tabular-nums">{formatCount(row.original.sessions)}</div>,
      meta: { label: "Sessions", width: "8%" },
    },
    {
      id: "occurrences",
      accessorKey: "occurrences",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Occurrences" className="ml-auto" />,
      cell: ({ row }) => <div className="text-right tabular-nums">{formatCount(row.original.occurrences)}</div>,
      meta: { label: "Occurrences", width: "10%" },
    },
    {
      id: "wastedMicros",
      accessorKey: "wastedMicros",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Wasted" className="ml-auto" />,
      cell: ({ row }) => {
        const units = formatUnits(row.original.wasted);
        return (
          <div className="grid justify-items-end text-right tabular-nums">
            <span>{formatMoney(row.original.wastedMicros)}</span>
            {units ? <span className="max-w-full truncate text-xs text-muted-foreground">{units}</span> : null}
          </div>
        );
      },
      meta: { label: "Wasted", width: "10%" },
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
        width: "8%",
      },
    },
    {
      id: "lastSeen",
      accessorKey: "lastSeen",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Last seen" />,
      cell: ({ row }) => <RelativeTime value={row.original.lastSeen} compact className="block max-w-full truncate text-right" />,
      meta: { label: "Last seen", width: "10%" },
    },
    {
      id: "callsite",
      accessorKey: "callsite",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Callsite" />,
      cell: ({ row }) => <Truncate text={row.original.callsite || "—"} className="font-mono text-xs" />,
      meta: { label: "Callsite" },
    },
    {
      id: "message",
      accessorKey: "message",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Message" />,
      cell: ({ row }) => <Truncate text={row.original.message} />,
      meta: { label: "Message" },
    },
  ];
}

function Truncate({ text, className }: { text: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("block truncate", className)}>{text}</span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

function formatUnits(wasted: Record<string, number>): string {
  const parts = Object.entries(wasted).filter(([, value]) => value !== 0);
  if (parts.length === 0) return "";
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
      void queryClient.invalidateQueries({ queryKey: ["overview", slug] });
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
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sessions</dt>
                <dd data-testid="finding-sessions" className="tabular-nums">{formatCount(row.sessions)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Occurrences</dt>
                <dd className="tabular-nums">{formatCount(row.occurrences)}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Callsite</dt>
                <dd data-testid="finding-callsite" className="truncate font-mono text-xs">{row.callsite || "—"}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Template</dt>
                <dd className="truncate font-mono text-xs">{row.template}</dd>
              </div>
            </dl>
            <div data-testid="finding-occurrences">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Occurrences</p>
              {row.occurrencesByDay.length === 0 ? (
                <p className="text-sm text-muted-foreground">No occurrences recorded.</p>
              ) : (
                <ChartContainer config={sparkConfig} className="aspect-auto h-24 w-full">
                  <AreaChart data={row.occurrencesByDay} margin={{ left: 0, right: 8, top: 8 }}>
                    <XAxis dataKey="day" tickLine={false} axisLine={false} tickFormatter={(value) => String(value).slice(5)} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Area
                      dataKey="occurrences"
                      type="monotone"
                      fill="var(--color-occurrences)"
                      stroke="var(--color-occurrences)"
                      strokeWidth={2}
                      fillOpacity={0.2}
                      dot={{ r: 3, strokeWidth: 0, fill: "var(--color-occurrences)" }}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ChartContainer>
              )}
            </div>
            {row.members.length > 0 ? (
              <div className="grid gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sessions</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Session</TableHead>
                      <TableHead className="text-right">Count</TableHead>
                      <TableHead>Last seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {row.members.map((member) => (
                      <TableRow key={member.id}>
                        <TableCell className={cn("max-w-40 truncate text-xs", member.session === "*" ? "" : "font-mono")}>
                          {member.session === "*" ? "All sessions" : member.session}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatCount(member.occurrences)}</TableCell>
                        <TableCell><RelativeTime value={member.lastSeen} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
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
