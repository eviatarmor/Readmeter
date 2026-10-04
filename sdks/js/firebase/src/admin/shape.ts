/**
 * Admin `Query` / `DocumentReference` → raw query fields.
 * Duck-typed so this package loads when firebase-admin is not installed.
 * `instrument` itself is part 3.
 */

import { decodeValue } from "../web/values.ts";
import { warnShape } from "../web/warn.ts";
import { setAdminReader, type RawQueryShape } from "../web/shape.ts";

export interface AdminTarget {
  path: string;
  collectionGroup?: true;
  query?: RawQueryShape;
  kind: "query" | "document";
}

const ADMIN_OP: Record<string, string> = {
  EQUAL: "==",
  NOT_EQUAL: "!=",
  LESS_THAN: "<",
  LESS_THAN_OR_EQUAL: "<=",
  GREATER_THAN: ">",
  GREATER_THAN_OR_EQUAL: ">=",
  IN: "in",
  NOT_IN: "not-in",
  ARRAY_CONTAINS: "array-contains",
  ARRAY_CONTAINS_ANY: "array-contains-any",
};

function fieldName(field: unknown): string | undefined {
  if (typeof field === "string") return field;
  if (!field || typeof field !== "object") return undefined;
  const f = field as { formattedName?: string; canonicalString?: () => string };
  if (typeof f.formattedName === "string") return f.formattedName;
  if (typeof f.canonicalString === "function") {
    try {
      return f.canonicalString();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function mapOp(op: string, value: unknown): { op: string; value: unknown } | undefined {
  if (op === "IS_NULL") return { op: "==", value: null };
  if (op === "IS_NAN") return { op: "==", value: "NaN" };
  const mapped = ADMIN_OP[op];
  if (!mapped) return undefined;
  return { op: mapped, value: decodeValue(value) };
}

function asList(filters: unknown): unknown[] | undefined {
  if (Array.isArray(filters)) return filters;
  if (!filters || typeof filters !== "object") return undefined;
  const f = filters as { filters?: unknown; getFlattenedFilters?: () => unknown };
  if (typeof f.getFlattenedFilters === "function") {
    try {
      const flat = f.getFlattenedFilters();
      if (Array.isArray(flat)) return flat;
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(f.filters)) return f.filters;
  return undefined;
}

/** Depth-first field filters. Composite AND/OR nodes are flattened. */
export function flattenAdminFilters(filters: unknown): { field: string; op: string; value: unknown }[] | undefined {
  const list = asList(filters);
  if (!list) return filters == null ? [] : undefined;
  const out: { field: string; op: string; value: unknown }[] = [];
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    const f = node as Record<string, unknown>;
    const nested = asList(f.filters);
    const op = typeof f.op === "string" ? f.op : "";
    if (nested && (op === "AND" || op === "OR" || op === "and" || op === "or")) {
      for (const child of nested) {
        if (!walk(child)) return false;
      }
      return true;
    }
    if (typeof f.op !== "string") return false;
    const field = fieldName(f.field);
    const mapped = field ? mapOp(f.op, f.value) : undefined;
    if (!field || !mapped) return false;
    out.push({ field, op: mapped.op, value: mapped.value });
    return true;
  };
  for (const item of list) {
    if (!walk(item)) return undefined;
  }
  return out;
}

function orderOf(order: unknown): { field: string; direction?: "desc" } | undefined {
  if (!order || typeof order !== "object") return undefined;
  const o = order as { field?: unknown; direction?: unknown; dir?: unknown };
  const field = fieldName(o.field);
  if (!field) return undefined;
  const dir = typeof o.direction === "string" ? o.direction : typeof o.dir === "string" ? o.dir : "";
  if (dir === "DESCENDING" || dir === "desc" || dir === "DESC") return { field, direction: "desc" };
  return { field };
}

function cursorValues(cursor: unknown): unknown[] | undefined {
  if (!cursor || typeof cursor !== "object") return undefined;
  const c = cursor as { values?: unknown; position?: unknown };
  const values = Array.isArray(c.values) ? c.values : Array.isArray(c.position) ? c.position : undefined;
  if (!values) return undefined;
  return values.map((item) => decodeValue(item));
}

/** Admin document refs have a Firestore client. A plain `{ path }` does not. */
export function isAdminDocument(value: unknown): value is { path: string } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.path !== "string" || v.path.length === 0) return false;
  if (v.type === "document" || v.type === "query" || v.type === "collection") return false;
  const client = v.firestore ?? v._firestore;
  return !!client && typeof client === "object" && typeof v.id === "string";
}

export function readAdminTarget(target: unknown): AdminTarget | undefined {
  if (!target || typeof target !== "object") return undefined;
  const t = target as Record<string, unknown>;
  const opts = t._queryOptions;
  if (!opts || typeof opts !== "object") {
    if (!isAdminDocument(target)) return undefined;
    return { kind: "document", path: target.path };
  }
  const options = opts as Record<string, unknown>;
  if (typeof options.collectionId !== "string" || options.collectionId.length === 0) return undefined;
  const parent = (options.parentPath as { relativeName?: string } | undefined)?.relativeName ?? "";
  const group = options.allDescendants === true;
  const path = group ? options.collectionId : parent ? `${parent}/${options.collectionId}` : options.collectionId;
  const filters = flattenAdminFilters(options.filters);
  const ordersRaw = options.fieldOrders;
  const base: AdminTarget = { kind: "query", path, ...(group ? { collectionGroup: true as const } : {}) };
  if (filters === undefined) {
    warnShape("admin filters");
    return base;
  }
  const query: RawQueryShape = {};
  if (filters.length > 0) query.filters = filters;
  if (Array.isArray(ordersRaw) && ordersRaw.length > 0) {
    const orderBy: { field: string; direction?: "desc" }[] = [];
    for (const order of ordersRaw) {
      const mapped = orderOf(order);
      if (!mapped) {
        warnShape("admin order");
        return base;
      }
      orderBy.push(mapped);
    }
    query.order_by = orderBy;
  }
  if (typeof options.limit === "number") query.limit = options.limit;
  if (options.limitType === 1 || options.limitType === "LAST") query.limit_to_last = true;
  if (typeof options.offset === "number" && options.offset > 0) query.offset = options.offset;
  const start = cursorValues(options.startAt);
  const end = cursorValues(options.endAt);
  if (start) query.start = start;
  if (end) query.end = end;
  const shape: AdminTarget = { kind: "query", path };
  if (group) shape.collectionGroup = true;
  shape.query = query;
  return shape;
}

setAdminReader(readAdminTarget);
