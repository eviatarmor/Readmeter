import { format, formatDistanceToNow } from "date-fns";

export function formatMoney(micros: number): string {
  if (!Number.isFinite(micros)) return "$0.00";
  if (micros === 0) return "$0.00";
  const dollars = micros / 1_000_000;
  if (dollars > 0 && dollars < 0.01) return "<$0.01";
  if (dollars < 0 && dollars > -0.01) return "-<$0.01";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars);
}

export function formatCount(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) {
    const scaled = abs / 1_000_000;
    const text = scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, "");
    return `${sign}${text}m`;
  }
  if (abs >= 1_000) {
    const scaled = abs / 1_000;
    const text = scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, "");
    return `${sign}${text}k`;
  }
  return new Intl.NumberFormat("en-US").format(value);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return "0 B";
  const sign = value < 0 ? "-" : "";
  let amount = Math.abs(value);
  let unit = 0;
  while (amount >= 1000 && unit < BYTE_UNITS.length - 1) {
    amount /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || amount >= 10 ? 0 : 1;
  return `${sign}${amount.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

export function formatAbsolute(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return format(date, "PPpp");
}

export function formatRelative(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return formatDistanceToNow(date, { addSuffix: true });
}

export function halfDelta(values: number[]): number | null {
  if (values.length < 2) return null;
  const mid = Math.floor(values.length / 2);
  const earlier = values.slice(0, mid).reduce((sum, value) => sum + value, 0);
  const later = values.slice(mid).reduce((sum, value) => sum + value, 0);
  if (earlier === 0) return later === 0 ? 0 : null;
  return (later - earlier) / earlier;
}
