"use client";

import { type RowData, Subscribe, type Table } from "@tanstack/react-table";
import { cn } from "cn";
import * as React from "react";

import type { DataTableFeatures } from "@/lib/data-table-features";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Settings2 } from "lucide-react";

interface DataTableViewOptionsProps<
  TData extends RowData,
> extends React.ComponentProps<typeof PopoverContent> {
  table: Table<DataTableFeatures, TData>;
  disabled?: boolean;
}

export function DataTableViewOptions<TData extends RowData>({
  table,
  disabled,
  className,
  ...props
}: DataTableViewOptionsProps<TData>) {
  const columns = React.useMemo(
    () =>
      table
        .getAllColumns()
        .filter(
          (column) =>
            typeof column.accessorFn !== "undefined" && column.getCanHide(),
        ),
    [table],
  );

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label="Toggle columns"
            role="combobox"
            variant="outline"
            className="ml-auto hidden h-8 font-normal lg:flex"
            disabled={disabled}
          />
        }
      >
        <Settings2 className="text-muted-foreground" />
        View
      </PopoverTrigger>
      <PopoverContent className={cn("w-44 p-0", className)} {...props}>
        <Command>
          <CommandInput placeholder="Search columns..." />
          <CommandList>
            <CommandEmpty>No columns found.</CommandEmpty>
            <CommandGroup>
              <Subscribe source={table.atoms.columnVisibility}>
                {(columnVisibility) =>
                  columns.map((column) => {
                    const isVisible = columnVisibility[column.id] !== false;

                    return (
                      <CommandItem
                        key={column.id}
                        data-checked={isVisible}
                        onSelect={() => column.toggleVisibility(!isVisible)}
                      >
                        <span className="truncate">
                          {column.columnDef.meta?.label ?? column.id}
                        </span>
                      </CommandItem>
                    );
                  })
                }
              </Subscribe>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
