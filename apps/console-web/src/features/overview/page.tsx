import { Link } from "@tanstack/react-router";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { PageHeader, QueryError } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { SeverityBadge } from "@/components/severity-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useOverview } from "@/features/overview/queries";
import { formatCount, formatMoney, halfDelta } from "@/lib/format-value";
import type { WorkspaceSearch } from "@/lib/workspace-search";

const chartConfig = {
  cost: { label: "Estimated cost", color: "var(--chart-1)" },
  waste: { label: "Wasted", color: "var(--chart-2)" },
  rules: { label: "Wasted", color: "var(--chart-3)" },
} satisfies ChartConfig;

export function OverviewPage({ slug, search }: { slug: string; search: WorkspaceSearch }) {
  const query = useOverview(slug, search.project, search.range);
  if (query.isLoading) return <Skeleton className="h-80 w-full" />;
  if (query.isError || !query.data) {
    return (
      <QueryError
        message={query.error instanceof Error ? query.error.message : "Could not load overview"}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const data = query.data;
  const series = data.series.map((point) => ({
    day: point.day.slice(5),
    cost: point.estimatedCostMicros / 1_000_000,
    waste: point.wastedMicros / 1_000_000,
    events: point.events,
  }));
  return (
    <div className="grid gap-4">
      <PageHeader
        title="Overview"
        description="Estimated cost and waste for the selected range. The change compares the later half of this range with the earlier half."
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Events" value={formatCount(data.kpis.events)} delta={halfDelta(data.series.map((point) => point.events))} />
        <Kpi label="Estimated cost" value={formatMoney(data.kpis.estimatedCostMicros)} delta={halfDelta(data.series.map((point) => point.estimatedCostMicros))} />
        <Kpi label="Wasted" value={formatMoney(data.kpis.wastedMicros)} delta={halfDelta(data.series.map((point) => point.wastedMicros))} />
        <Kpi label="Open findings" value={formatCount(data.kpis.openFindings)} delta={null} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Cost and waste</CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
            <AreaChart data={series}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} width={48} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area dataKey="cost" type="monotone" fill="var(--color-cost)" stroke="var(--color-cost)" fillOpacity={0.2} />
              <Area dataKey="waste" type="monotone" fill="var(--color-waste)" stroke="var(--color-waste)" fillOpacity={0.2} />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Top rules</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={chartConfig} className="aspect-auto h-56 w-full">
              <BarChart data={data.topRules.map((row) => ({ rule: row.rule, rules: row.wastedMicros / 1_000_000 }))}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="rule" tickLine={false} axisLine={false} interval={0} tick={{ fontSize: 10 }} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="rules" fill="var(--color-rules)" radius={4} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Open findings by severity</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {Object.entries(data.openFindingsBySeverity).map(([severity, count]) => (
              <span key={severity} className="flex items-center gap-2 text-sm">
                <SeverityBadge severity={severity} />
                {formatCount(count)}
              </span>
            ))}
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <SimpleTable
          title="Top templates"
          rows={data.topTemplates.map((row) => [row.template, formatCount(row.events)])}
        />
        <SimpleTable
          title="Top callsites"
          rows={data.topCallsites.map((row) => [row.callsite ?? "—", formatCount(row.events)])}
        />
      </div>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">Recent findings</CardTitle>
          <Link to="/w/$slug/findings" params={{ slug }} search={search} className="text-sm text-primary">
            View all
          </Link>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Open the findings table to triage {formatCount(data.kpis.openFindings)} open findings.
          <span className="sr-only">
            <RelativeTime value={data.from} />
          </span>
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({ label, value, delta }: { label: string; value: string; delta: number | null }) {
  const pct = delta == null ? null : Math.round(delta * 100);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {pct == null ? "No earlier half to compare" : `${pct > 0 ? "+" : ""}${pct}% vs earlier half`}
        </p>
      </CardContent>
    </Card>
  );
}

function SimpleTable({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Events</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={2} className="text-muted-foreground">
                  Nothing in this range.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row[0]}>
                  <TableCell className="max-w-xs truncate font-mono text-xs">{row[0]}</TableCell>
                  <TableCell className="text-right">{row[1]}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
