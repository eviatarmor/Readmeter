export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const steps: [number, string][] = [
    [1e12, "t"],
    [1e9, "g"],
    [1e6, "m"],
    [1e3, "k"],
  ];
  for (const [div, suffix] of steps) {
    if (abs >= div) {
      const scaled = abs / div;
      const text = scaled >= 10 || Number.isInteger(scaled) ? String(Math.round(scaled)) : scaled.toFixed(1);
      return sign + text.replace(/\.0$/, "") + suffix;
    }
  }
  return sign + String(abs);
}

/** `reads=120 egress_bytes=4k`. Empty units render as `-`. */
export function formatUnits(units: Record<string, number> | null | undefined): string {
  if (!units) return "-";
  const parts = Object.entries(units)
    .filter(([, value]) => value !== 0)
    .map(([name, value]) => `${name}=${compactNumber(value)}`);
  return parts.length ? parts.join(" ") : "-";
}

/** Whole units, floored: `45s ago`, `3m ago`, `2h ago`, `4d ago`. */
export function relativeTime(then: Date, now: Date): string {
  const sec = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function callsiteShort(callsite: string | null | undefined): string {
  if (!callsite) return "-";
  return callsite.slice(0, 8);
}

export function stamp(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

export function align(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

export function labeled(pairs: [string, string][]): string {
  const width = Math.max(...pairs.map(([label]) => label.length));
  return pairs.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
}

export function initSnippet(apiKey: string, hashKey: string): string {
  return [
    "init({",
    `  apiKey: ${JSON.stringify(apiKey)},`,
    `  hashKey: ${JSON.stringify(hashKey)},`,
    `  endpoint: "http://127.0.0.1:8090",`,
    "})",
  ].join("\n");
}

export interface FindingView {
  severity: string;
  rule: string;
  template: string;
  callsite: string;
  occurrences: number;
  wasted: Record<string, number>;
  lastSeen: Date;
  message: string;
}

const FINDING_HEADERS = ["severity", "rule", "template", "callsite", "occurrences", "wasted", "last seen", "message"];

export function formatFindings(rows: FindingView[], now: Date): string {
  return align(
    FINDING_HEADERS,
    rows.map((row) => [
      row.severity,
      row.rule,
      row.template,
      callsiteShort(row.callsite),
      String(row.occurrences),
      formatUnits(row.wasted),
      relativeTime(row.lastSeen, now),
      row.message,
    ]),
  );
}

export function findingsJson(rows: FindingView[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      severity: row.severity,
      rule: row.rule,
      template: row.template,
      callsite: row.callsite,
      occurrences: row.occurrences,
      wasted: row.wasted,
      last_seen: row.lastSeen.toISOString(),
      message: row.message,
    })),
    null,
    2,
  );
}

export interface EventView {
  ts: Date;
  op: string;
  template: string;
  items: number;
  units: Record<string, number>;
  signals: Record<string, unknown> | null;
}

export function formatEvents(rows: EventView[]): string {
  return align(
    ["ts", "op", "template", "items", "units"],
    rows.map((row) => [stamp(row.ts), row.op, row.template, String(row.items), formatUnits(row.units)]),
  );
}

export function eventsJson(rows: EventView[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      ts: row.ts.toISOString(),
      op: row.op,
      template: row.template,
      items: row.items,
      units: row.units,
      signals: row.signals,
    })),
    null,
    2,
  );
}

export interface StatsView {
  batches: number;
  events: number;
  findings: number;
  topTemplates: { template: string; reads: number }[];
}

export function formatStats(stats: StatsView): string {
  const counts = labeled([
    ["batches", String(stats.batches)],
    ["events", String(stats.events)],
    ["findings", String(stats.findings)],
  ]);
  const top = stats.topTemplates.length
    ? align(
        ["reads", "template"],
        stats.topTemplates.map((row) => [compactNumber(row.reads), row.template]),
      )
    : "(none)";
  return `${counts}\n\ntop templates by reads (24h)\n${top}`;
}

export function statsJson(stats: StatsView): string {
  return JSON.stringify(
    {
      batches: stats.batches,
      events: stats.events,
      findings: stats.findings,
      top_templates_24h: stats.topTemplates,
    },
    null,
    2,
  );
}
