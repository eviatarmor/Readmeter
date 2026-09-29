import { Link } from "@tanstack/react-router";
import * as React from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { PageHeader, QueryError } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCosts, type CostGroup } from "@/features/costs/queries";
import { formatMoney } from "@/lib/format-value";
import type { WorkspaceSearch } from "@/lib/workspace-search";

const groups: { id: CostGroup; label: string }[] = [
  { id: "service", label: "Service" },
  { id: "rule", label: "Rule" },
  { id: "template", label: "Template" },
  { id: "day", label: "Day" },
];

const chartConfig = { cost: { label: "Estimated cost", color: "var(--chart-1)" } } satisfies ChartConfig;

export function CostsPage({ slug, search }: { slug: string; search: WorkspaceSearch }) {
  const [groupBy, setGroupBy] = React.useState<CostGroup>("service");
  const query = useCosts(slug, search.project, search.range, groupBy);
  if (query.isError || !query.data) {
    if (query.isLoading) return <PageHeader title="Costs" />;
    return <QueryError message="Could not load costs" onRetry={() => void query.refetch()} />;
  }
  const data = query.data;
  const points = data.items.map((item) => ({ key: item.key, cost: item.micros / 1_000_000 }));
  return (
    <div className="grid gap-4">
      <PageHeader
        title="Costs"
        description="Prices come from the rules bundle. Billed cost arrives with a billing connection."
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline">{data.source === "billed" ? "Billed" : "Estimated"}</Badge>
            <Button variant="outline" size="sm" onClick={() => downloadCsv(data.items)}>
              Export CSV
            </Button>
          </div>
        }
      />
      {data.source !== "billed" ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
          <span>These numbers are estimates. Connect Google Cloud billing to compare with the invoice.</span>
          <Button variant="outline" size="sm" asChild>
            <Link to="/w/$slug/integrations" params={{ slug }} search={search}>
              Integrations
            </Link>
          </Button>
        </div>
      ) : null}
      <Tabs value={groupBy} onValueChange={(value) => setGroupBy(value as CostGroup)}>
        <TabsList>
          {groups.map((group) => (
            <TabsTrigger key={group.id} value={group.id}>
              {group.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Estimated USD</CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
            <BarChart data={points}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="key" tickLine={false} axisLine={false} interval={0} tick={{ fontSize: 10 }} />
              <YAxis tickLine={false} axisLine={false} width={48} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="cost" fill="var(--color-cost)" radius={4} />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead className="text-right">Estimated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={2} className="text-muted-foreground">
                No cost in this range.
              </TableCell>
            </TableRow>
          ) : (
            data.items.map((item) => (
              <TableRow key={item.key}>
                <TableCell className="font-mono text-xs">{item.key}</TableCell>
                <TableCell className="text-right">{formatMoney(item.micros)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function downloadCsv(items: { key: string; micros: number }[]) {
  const lines = ["key,micros,usd", ...items.map((item) => `${csv(item.key)},${item.micros},${(item.micros / 1_000_000).toFixed(6)}`)];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "readmeter-costs.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function csv(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}
