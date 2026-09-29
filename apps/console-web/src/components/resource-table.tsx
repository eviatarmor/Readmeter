import {
  parseAsInteger,
  parseAsStringEnum,
  useQueryState,
} from "nuqs";
import * as React from "react";

import { DataTable } from "@/components/data-table/data-table";
import { DataTableAdvancedToolbar } from "@/components/data-table/data-table-advanced-toolbar";
import { DataTableFilterList } from "@/components/data-table/data-table-filter-list";
import { DataTableSortList } from "@/components/data-table/data-table-sort-list";
import { Skeleton } from "@/components/ui/skeleton";
import { useDataTable } from "@/hooks/use-data-table";
import type { DataTableFeatures } from "@/lib/data-table-features";
import type { QueryKeys } from "@/lib/data-table-types";
import { getValidFilters } from "@/lib/data-table-utils";
import { applyFilters, applySort } from "@/lib/filters";
import { getFiltersStateParser, getSortingStateParser } from "@/lib/parsers";
import type { ColumnDef, RowData, Table as TanstackTable } from "@tanstack/react-table";

interface ResourceTableProps<TData extends RowData> {
  data: TData[];
  columns: ColumnDef<DataTableFeatures, TData>[];
  getRowId: (row: TData) => string;
  queryKeys: QueryKeys;
  isLoading?: boolean;
  onRowClick?: (row: TData) => void;
  actionBar?: (table: TanstackTable<DataTableFeatures, TData>) => React.ReactNode;
  columnVisibility?: Record<string, boolean>;
  tableClassName?: string;
}

export function ResourceTable<TData extends RowData>({
  data,
  columns,
  getRowId,
  queryKeys,
  isLoading,
  onRowClick,
  actionBar,
  columnVisibility,
  tableClassName,
}: ResourceTableProps<TData>) {
  const sortParser = React.useMemo(() => getSortingStateParser<TData>().withDefault([]), []);
  const filterParser = React.useMemo(() => getFiltersStateParser<TData>().withDefault([]), []);
  const [page] = useQueryState(queryKeys.page, parseAsInteger.withDefault(1));
  const [perPage] = useQueryState(queryKeys.perPage, parseAsInteger.withDefault(20));
  const [sort] = useQueryState(queryKeys.sort, sortParser);
  const [filters] = useQueryState(queryKeys.filters, filterParser);
  const [joinOperator] = useQueryState(
    queryKeys.joinOperator,
    parseAsStringEnum(["and", "or"]).withDefault("and"),
  );
  const valid = getValidFilters(filters);
  const filtered = React.useMemo(
    () => applyFilters(data as object[], valid as never, joinOperator) as TData[],
    [data, valid, joinOperator],
  );
  const sorted = React.useMemo(
    () => applySort(filtered as object[], sort) as TData[],
    [filtered, sort],
  );
  const pageCount = Math.max(1, Math.ceil(sorted.length / perPage));
  const safePage = Math.min(page, pageCount);
  const rows = sorted.slice((safePage - 1) * perPage, safePage * perPage);
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    getRowId,
    queryKeys,
    initialState: {
      pagination: { pageIndex: 0, pageSize: 20 },
      ...(columnVisibility ? { columnVisibility } : {}),
    },
    enableAdvancedFilter: true,
    enableRowSelection: actionBar !== undefined,
  });
  const bar = actionBar?.(table);

  if (isLoading) {
    return (
      <div className="grid gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <DataTable table={table} actionBar={bar} onRowClick={onRowClick} tableClassName={tableClassName}>
      <DataTableAdvancedToolbar table={table}>
        <DataTableFilterList table={table} />
        <DataTableSortList table={table} />
      </DataTableAdvancedToolbar>
    </DataTable>
  );
}
