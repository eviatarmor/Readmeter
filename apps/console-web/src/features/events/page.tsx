import type { ColumnDef } from "@tanstack/react-table";
import * as React from "react";

import type { TelemetryEvent } from "@readmeter/console-api/contract";

import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { PageHeader, QueryError } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { ResourceTable } from "@/components/resource-table";
import { Mono } from "@/components/severity-badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { eventKeys, useEvents } from "@/features/events/queries";
import type { DataTableFeatures } from "@/lib/data-table-features";
import { formatBytes, formatCount } from "@/lib/format-value";
import type { WorkspaceSearch } from "@/lib/workspace-search";

export function EventsPage({ slug, search }: { slug: string; search: WorkspaceSearch }) {
  const query = useEvents(slug, search.project, search.range);
  const [selected, setSelected] = React.useState<TelemetryEvent | null>(null);
  const columns = React.useMemo(() => eventColumns(), []);
  if (query.isError) {
    return <QueryError message="Could not load events" onRetry={() => void query.refetch()} />;
  }
  return (
    <div className="grid gap-4">
      <PageHeader title="Events" description="Ingested reads, newest first." />
      <ResourceTable
        data={query.data ?? []}
        columns={columns}
        getRowId={(row) => String(row.id)}
        queryKeys={eventKeys}
        isLoading={query.isLoading}
        onRowClick={setSelected}
      />
      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{selected ? `${selected.op} ${selected.template}` : "Event"}</SheetTitle>
            <SheetDescription>{selected?.service}</SheetDescription>
          </SheetHeader>
          {selected ? (
            <div className="grid gap-3 px-4 pb-6 text-sm">
              <p>
                <Mono>{selected.id}</Mono> · {selected.platform} · {formatBytes(selected.bytes ?? 0)}
              </p>
              <p className="text-muted-foreground">{selected.callsite ?? "No callsite"}</p>
              <pre className="overflow-auto rounded-lg border bg-muted/40 p-3 text-xs">
                {JSON.stringify(
                  {
                    signals: selected.signals,
                    opDetail: selected.opDetail,
                    query: selected.query,
                    durationUs: selected.durationUs,
                    listener: selected.listener,
                    mount: selected.mount,
                    dev: selected.dev,
                    attempt: selected.attempt,
                    targetKey: selected.targetKey,
                    idShape: selected.idShape,
                    collectionGroup: selected.collectionGroup,
                    errorCode: selected.errorCode,
                    units: selected.units,
                    items: selected.items,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function eventColumns(): ColumnDef<DataTableFeatures, TelemetryEvent>[] {
  return [
    {
      id: "ts",
      accessorKey: "ts",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Time" />,
      cell: ({ row }) => <RelativeTime value={row.original.ts} />,
    },
    {
      id: "op",
      accessorKey: "op",
      header: ({ column }) => <DataTableColumnHeader column={column} label="Op" />,
      enableColumnFilter: true,
      meta: { label: "Op", variant: "text" },
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
      id: "session",
      accessorKey: "session",
      header: "Session",
      cell: ({ row }) => <Mono>{row.original.session.slice(0, 8)}</Mono>,
      enableColumnFilter: true,
      meta: { label: "Session", variant: "text" },
    },
    {
      id: "bytes",
      accessorKey: "bytes",
      header: "Bytes",
      cell: ({ row }) => formatBytes(row.original.bytes ?? 0),
    },
    {
      id: "items",
      accessorKey: "items",
      header: "Items",
      cell: ({ row }) => formatCount(row.original.items ?? 0),
    },
    {
      id: "errorCode",
      accessorKey: "errorCode",
      header: "Error",
      cell: ({ row }) => row.original.errorCode ?? "—",
    },
  ];
}
