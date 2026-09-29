import type { ExtendedColumnFilter } from "@/lib/data-table-types";

function textOf(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function matchesFilter(row: object, filter: ExtendedColumnFilter<object>): boolean {
  const value = (row as Record<string, unknown>)[filter.id];
  const text = textOf(value);
  const list = (Array.isArray(filter.value) ? filter.value : [filter.value]).map((item) => String(item));
  const needle = (list[0] ?? "").toLowerCase();
  const haystack = text.toLowerCase();
  switch (filter.operator) {
    case "isEmpty":
      return text === "";
    case "isNotEmpty":
      return text !== "";
    case "inArray":
      return list.some((item) => haystack === item.toLowerCase());
    case "notInArray":
      return list.every((item) => haystack !== item.toLowerCase());
    case "eq":
      return haystack === needle;
    case "ne":
      return haystack !== needle;
    case "iLike":
      return haystack.includes(needle);
    case "notILike":
      return !haystack.includes(needle);
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const left = typeof value === "number" ? value : Number(text);
      const right = Number(list[0]);
      if (Number.isNaN(left) || Number.isNaN(right)) return false;
      if (filter.operator === "lt") return left < right;
      if (filter.operator === "lte") return left <= right;
      if (filter.operator === "gt") return left > right;
      return left >= right;
    }
    default:
      return true;
  }
}

export function applyFilters<T extends object>(
  rows: T[],
  filters: ExtendedColumnFilter<T>[],
  join: "and" | "or",
): T[] {
  if (filters.length === 0) return rows;
  return rows.filter((row) => {
    const checks = filters.map((filter) => matchesFilter(row, filter as ExtendedColumnFilter<object>));
    return join === "or" ? checks.some(Boolean) : checks.every(Boolean);
  });
}

export function applySort<T extends object>(rows: T[], sort: { id: string; desc: boolean }[]): T[] {
  const first = sort[0];
  if (!first) return rows;
  const copy = [...rows];
  copy.sort((left, right) => {
    const a = (left as Record<string, unknown>)[first.id];
    const b = (right as Record<string, unknown>)[first.id];
    const av = typeof a === "number" ? a : textOf(a);
    const bv = typeof b === "number" ? b : textOf(b);
    if (av < bv) return first.desc ? 1 : -1;
    if (av > bv) return first.desc ? -1 : 1;
    return 0;
  });
  return copy;
}

export function filterValues<T extends object>(filters: ExtendedColumnFilter<T>[], id: string): string[] {
  const match = filters.find((filter) => filter.id === id);
  if (!match) return [];
  const list = Array.isArray(match.value) ? match.value : [match.value];
  return list.map((item) => String(item)).filter((item) => item.length > 0);
}
