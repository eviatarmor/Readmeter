import { Link } from "@tanstack/react-router";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { SEVERITY_ORDER } from "@readmeter/console-api/contract";

import { EmptyState, PageHeader, QueryError } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { SeverityBadge } from "@/components/severity-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useOverview } from "@/features/overview/queries";
import { formatCount, formatMoney, halfDelta } from "@/lib/format-value";
import type { WorkspaceSearch } from "@/lib/workspace-search";

function costChartConfig(costLabel: string): ChartConfig {
  return {
    cost: { label: costLabel, color: "var(--foreground)" },
    waste: { label: "Wasted", color: "oklch(0.62 0.14 55)" },
  };
}

const severityBar: Record<(typeof SEVERITY_ORDER)[number], string> = {
  critical: "bg-red-600",
  high: "bg-orange-500",
  medium: "bg-amber-500",
  low: "bg-blue-500",
  info: "bg-muted-foreground/50",
};

function moneyTick(dollars: number): string {
  return formatMoney(dollars * 1_000_000);
}

/** Even-cent ceiling so the three ticks format as three different money labels. */
function costScale(series: { cost: number; waste: number }[]): { top: number; ticks: number[] } {
  const max = series.reduce((peak, point) => Math.max(peak, point.cost, point.waste), 0);
  const cents = Math.max(2, Math.ceil(max * 100 - 1e-9));
  const even = cents % 2 === 0 ? cents : cents + 1;
  const top = even / 100;
  return { top, ticks: [0, top / 2, top] };
}

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
  const billed = data.kpis.costLabel === "Billed";
  const costLabel = billed ? "Billed" : "Estimated";
  const chartConfig = costChartConfig(costLabel);
  const series = data.series.map((point) => ({
    day: point.day.slice(5),
    cost: (billed ? point.billedCostMicros : point.estimatedCostMicros) / 1_000_000,
    waste: point.wastedMicros / 1_000_000,
    events: point.events,
  }));
  const scale = costScale(series);
  return (
    <div className="grid gap-4">
      <PageHeader
        title="Overview"
        description="Estimated cost and waste for the selected range. The change compares the later half of this range with the earlier half."
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Events" value={formatCount(data.kpis.events)} delta={halfDelta(data.series.map((point) => point.events))} />
        <Kpi
          label={costLabel}
          value={formatMoney(billed ? data.kpis.costMicros : data.kpis.estimatedCostMicros)}
          delta={halfDelta(data.series.map((point) => (billed ? point.billedCostMicros : point.estimatedCostMicros)))}
        />
        <Kpi label="Wasted" value={formatMoney(data.kpis.wastedMicros)} delta={halfDelta(data.series.map((point) => point.wastedMicros))} />
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Open issues</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tracking-tight tabular-nums">{formatCount(data.kpis.openIssues ?? 0)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{formatCount(data.kpis.openFindings)} open findings</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Cost and waste</CardTitle>
        </CardHeader>
        <CardContent>
          {series.some((point) => point.cost > 0 || point.waste > 0) ? (
            <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full" data-testid="cost-chart">
              <AreaChart data={series} margin={{ left: 8, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="day" tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  domain={[0, scale.top]}
                  ticks={scale.ticks}
                  tickFormatter={moneyTick}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value, name) => (
                        <div className="flex w-full min-w-36 items-center justify-between gap-4">
                          <span className="text-muted-foreground">
                            {chartConfig[String(name) as "cost" | "waste"]?.label ?? name}
                          </span>
                          <span className="font-mono font-medium tabular-nums">{moneyTick(Number(value))}</span>
                        </div>
                      )}
                    />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                <Area
                  dataKey="cost"
                  type="monotone"
                  fill="var(--color-cost)"
                  stroke="var(--color-cost)"
                  strokeWidth={2}
                  fillOpacity={0.18}
                  dot={{ r: 3, strokeWidth: 0, fill: "var(--color-cost)" }}
                  isAnimationActive={false}
                />
                <Area
                  dataKey="waste"
                  type="monotone"
                  fill="var(--color-waste)"
                  stroke="var(--color-waste)"
                  strokeWidth={2}
                  fillOpacity={0.2}
                  dot={{ r: 3, strokeWidth: 0, fill: "var(--color-waste)" }}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ChartContainer>
          ) : (
            <EmptyState title="No cost in this range" body="Estimates appear after the project reports provider calls." />
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Top rules</CardTitle>
          </CardHeader>
          <CardContent data-testid="top-rules">
            <TopRules rules={data.topRules} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Open findings by severity</CardTitle>
          </CardHeader>
          <CardContent data-testid="severity-chart">
            <SeverityBar counts={data.openFindingsBySeverity} />
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
          Open the findings table to triage {formatCount(data.kpis.openIssues ?? 0)} open issues.
          <span className="sr-only">
            <RelativeTime value={data.from} />
          </span>
        </CardContent>
      </Card>
    </div>
  );
}

function TopRules({ rules }: { rules: { rule: string; title?: string; wastedMicros: number }[] }) {
  const top = rules.filter((row) => row.wastedMicros > 0).slice(0, 8);
  if (top.length === 0) {
    return <EmptyState title="Nothing wasted" body="Rules with wasted work show up here." />;
  }
  const max = top[0]?.wastedMicros ?? 1;
  return (
    <ul className="grid gap-3">
      {top.map((row) => {
        const title = row.title && row.title.length > 0 ? row.title : row.rule;
        const width = Math.max(4, Math.round((row.wastedMicros / max) * 100));
        return (
          <li key={row.rule} className="grid grid-cols-[minmax(0,16rem)_minmax(3rem,1fr)_4.75rem] items-center gap-3 text-sm">
            <span className="line-clamp-2 leading-5" title={title}>{title}</span>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-foreground/80" style={{ width: `${width}%` }} />
            </div>
            <span className="text-right tabular-nums text-muted-foreground">{formatMoney(row.wastedMicros)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function SeverityBar({ counts }: { counts: Record<string, number> }) {
  const rows = SEVERITY_ORDER.map((severity) => ({ severity, count: counts[severity] ?? 0 }));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) {
    return <EmptyState title="No open findings" body="Open issues are grouped by severity here." />;
  }
  return (
    <div className="grid gap-4">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {rows.map((row) =>
          row.count === 0 ? null : (
            <div
              key={row.severity}
              className={severityBar[row.severity]}
              style={{ width: `${(row.count / total) * 100}%` }}
            />
          ),
        )}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-2">
        {rows.map((row) => (
          <li key={row.severity} className="flex items-center gap-2 text-sm">
            <SeverityBadge severity={row.severity} />
            <span className="tabular-nums">{formatCount(row.count)}</span>
          </li>
        ))}
      </ul>
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
