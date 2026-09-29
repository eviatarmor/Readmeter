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
const compareConfig = {
  estimated: { label: "Estimated", color: "var(--chart-1)" },
  billed: { label: "Billed", color: "var(--chart-2)" },
} satisfies ChartConfig;

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
        description="Estimates come from the rules bundle. Billed rows come from the Cloud Billing export when a connection has synced."
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline">{data.source === "billed" ? "Billed" : "Estimated"}</Badge>
            <Button variant="outline" size="sm" onClick={() => downloadCsv(data)}>
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
      {data.billedMicros != null ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Estimate and billed</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer config={compareConfig} className="aspect-auto h-64 w-full">
                <BarChart
                  data={data.comparison.map((point) => ({
                    day: point.day.slice(5),
                    estimated: point.estimatedMicros / 1_000_000,
                    billed: point.billedMicros / 1_000_000,
                  }))}
                >
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} minTickGap={24} />
                  <YAxis tickLine={false} axisLine={false} width={48} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="estimated" fill="var(--color-estimated)" radius={4} />
                  <Bar dataKey="billed" fill="var(--color-billed)" radius={4} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>
          <Table data-testid="billed-table">
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Usage</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Credits</TableHead>
                <TableHead className="text-right">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.billedBySku.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    No billed SKUs in this range.
                  </TableCell>
                </TableRow>
              ) : (
                data.billedBySku.map((row) => (
                  <TableRow key={`${row.service}/${row.sku}`}>
                    <TableCell>{row.service}</TableCell>
                    <TableCell>{row.sku}</TableCell>
                    <TableCell className="text-right">
                      {row.usageAmount} {row.usageUnit}
                    </TableCell>
                    <TableCell className="text-right">{formatMoney(row.micros)}</TableCell>
                    <TableCell className="text-right">{formatMoney(row.creditsMicros)}</TableCell>
                    <TableCell className="text-right">{formatMoney(row.micros + row.creditsMicros)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </>
      ) : null}
      {data.sdkCoverage ? (
        <p data-testid="sdk-coverage" className="text-sm text-muted-foreground">
          SDK coverage: {Math.round(data.sdkCoverage.ratio * 100)}% of billed Firestore reads (
          {data.sdkCoverage.estimatedReads} estimated / {data.sdkCoverage.billedReads} billed).
        </p>
      ) : null}
    </div>
  );
}

function downloadCsv(data: {
  items: { key: string; micros: number }[];
  billedBySku: { service: string; sku: string; micros: number; creditsMicros: number }[];
}) {
  const lines = [
    "kind,key,micros,usd",
    ...data.items.map((item) => `estimate,${csv(item.key)},${item.micros},${(item.micros / 1_000_000).toFixed(6)}`),
    ...data.billedBySku.map((row) => {
      const net = row.micros + row.creditsMicros;
      return `billed,${csv(`${row.service} / ${row.sku}`)},${net},${(net / 1_000_000).toFixed(6)}`;
    }),
  ];
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
