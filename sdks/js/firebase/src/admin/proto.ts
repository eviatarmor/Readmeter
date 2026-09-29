/**
 * Admin RPC protos (`google.firestore.v1`) → raw call fields.
 * A shape we don't recognize returns without a query so the rule stays silent.
 */

import { commitPath } from "../web/shape.ts";
import type { RawQueryShape } from "../web/shape.ts";
import { decodeValue } from "../web/values.ts";

export interface ProtoTarget {
  path: string;
  collectionGroup?: true;
  query?: RawQueryShape;
}

export interface ClassifiedWrite {
  op: "set" | "update" | "create" | "delete";
  path: string;
}

export interface ClassifiedCommit {
  op: "set" | "update" | "create" | "delete" | "commit";
  path: string;
  commit?: { writes: number; deletes: number; transactional: boolean };
}

const OPS: Record<string, string> = {
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

/** `projects/{p}/databases/{d}/documents/{path}` → `{path}`. A root parent has no slash after `documents`. */
export function resourcePath(name: string): string {
  const marker = "/documents/";
  const at = name.indexOf(marker);
  if (at >= 0) return name.slice(at + marker.length);
  if (name.endsWith("/documents")) return "";
  return name.replace(/^\/+/, "");
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  if (value && typeof value === "object" && "value" in value) return asNumber((value as { value: unknown }).value);
  return undefined;
}

function fieldPath(field: unknown): string | undefined {
  if (typeof field === "string") return field;
  if (!field || typeof field !== "object") return undefined;
  const path = (field as { fieldPath?: unknown }).fieldPath;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

function mapFilter(node: unknown): { field: string; op: string; value: unknown } | undefined {
  if (!node || typeof node !== "object") return undefined;
  const f = node as Record<string, unknown>;
  if (f.unaryFilter && typeof f.unaryFilter === "object") {
    const unary = f.unaryFilter as { field?: unknown; op?: unknown };
    const field = fieldPath(unary.field);
    if (!field || typeof unary.op !== "string") return undefined;
    if (unary.op === "IS_NULL") return { field, op: "==", value: null };
    if (unary.op === "IS_NAN") return { field, op: "==", value: "NaN" };
    return undefined;
  }
  if (f.fieldFilter && typeof f.fieldFilter === "object") {
    const fieldFilter = f.fieldFilter as { field?: unknown; op?: unknown; value?: unknown };
    const field = fieldPath(fieldFilter.field);
    if (!field || typeof fieldFilter.op !== "string") return undefined;
    if (fieldFilter.op === "IS_NULL") return { field, op: "==", value: null };
    if (fieldFilter.op === "IS_NAN") return { field, op: "==", value: "NaN" };
    const op = OPS[fieldFilter.op];
    if (!op) return undefined;
    return { field, op, value: decodeValue(fieldFilter.value) };
  }
  return undefined;
}

/** Depth-first field filters. Composite AND/OR nodes are flattened. */
export function flattenProtoFilters(where: unknown): { field: string; op: string; value: unknown }[] | undefined {
  if (where == null) return [];
  const out: { field: string; op: string; value: unknown }[] = [];
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    const f = node as Record<string, unknown>;
    if (f.compositeFilter && typeof f.compositeFilter === "object") {
      const composite = f.compositeFilter as { filters?: unknown };
      if (!Array.isArray(composite.filters)) return false;
      for (const child of composite.filters) {
        if (!walk(child)) return false;
      }
      return true;
    }
    const mapped = mapFilter(node);
    if (!mapped) return false;
    out.push(mapped);
    return true;
  };
  return walk(where) ? out : undefined;
}

function readOrders(orderBy: unknown): { field: string; direction?: "desc" }[] | undefined {
  if (orderBy == null) return [];
  if (!Array.isArray(orderBy)) return undefined;
  const out: { field: string; direction?: "desc" }[] = [];
  for (const order of orderBy) {
    if (!order || typeof order !== "object") return undefined;
    const o = order as { field?: unknown; direction?: unknown };
    const field = fieldPath(o.field);
    if (!field) return undefined;
    if (o.direction === "DESCENDING" || o.direction === "desc" || o.direction === "DESC") out.push({ field, direction: "desc" });
    else out.push({ field });
  }
  return out;
}

function cursorValues(cursor: unknown): unknown[] | undefined {
  if (!cursor || typeof cursor !== "object") return undefined;
  const values = (cursor as { values?: unknown }).values;
  if (!Array.isArray(values)) return undefined;
  return values.map((item) => decodeValue(item));
}

export interface StructuredRead {
  target?: ProtoTarget;
  /** Set when a filter or order could not be read. The call still has a path. */
  warn?: string;
}

function collectionOf(structured: Record<string, unknown>): { id: string; group: boolean } | undefined {
  const from = structured.from;
  if (!Array.isArray(from) || from.length === 0) return undefined;
  const first = from[0];
  if (!first || typeof first !== "object") return undefined;
  const row = first as { collectionId?: unknown; allDescendants?: unknown };
  if (typeof row.collectionId !== "string" || row.collectionId.length === 0) return undefined;
  return { id: row.collectionId, group: row.allDescendants === true };
}

/**
 * `RunQuery` / listen target query → path and raw query.
 * `dropTrailingDocumentId` drops a trailing `__name__` order. Listen requests
 * add that order even when `get()` of the same query does not, and the two
 * calls have to hash to the same target.
 */
export function readStructuredQuery(request: unknown, dropTrailingDocumentId = false): StructuredRead {
  if (!request || typeof request !== "object") return { warn: "request" };
  const req = request as Record<string, unknown>;
  const structured = req.structuredQuery;
  if (!structured || typeof structured !== "object") return { warn: "structuredQuery" };
  const body = structured as Record<string, unknown>;
  const collection = collectionOf(body);
  if (!collection) return { warn: "from" };
  const parent = typeof req.parent === "string" ? resourcePath(req.parent) : "";
  const path = collection.group ? collection.id : parent ? `${parent}/${collection.id}` : collection.id;
  const filters = flattenProtoFilters(body.where);
  let orders = readOrders(body.orderBy);
  if (filters === undefined) return { target: { path, ...(collection.group ? { collectionGroup: true as const } : {}) }, warn: "filters" };
  if (orders === undefined) return { target: { path, ...(collection.group ? { collectionGroup: true as const } : {}) }, warn: "order" };
  if (dropTrailingDocumentId && orders.length > 0 && orders[orders.length - 1]?.field === "__name__") {
    orders = orders.slice(0, -1);
  }
  const query: RawQueryShape = {};
  if (filters.length > 0) query.filters = filters;
  if (orders.length > 0) query.order_by = orders;
  const limit = asNumber(body.limit);
  if (limit !== undefined) query.limit = limit;
  const offset = asNumber(body.offset);
  if (offset !== undefined && offset > 0) query.offset = offset;
  const start = cursorValues(body.startAt);
  const end = cursorValues(body.endAt);
  if (start && start.length > 0) query.start = start;
  if (end && end.length > 0) query.end = end;
  const target: ProtoTarget = { path };
  if (collection.group) target.collectionGroup = true;
  // Keep `{}` when the structured query has no limit, filter, or order.
  target.query = query;
  return { target };
}

export interface AggregationRead extends StructuredRead {
  aggregations?: string[];
  /** Alias of the count aggregation, when the request has one. */
  countAlias?: string;
}

export function readAggregation(request: unknown): AggregationRead {
  if (!request || typeof request !== "object") return { warn: "request" };
  const wrapped = (request as { structuredAggregationQuery?: unknown }).structuredAggregationQuery;
  if (!wrapped || typeof wrapped !== "object") return { warn: "structuredAggregationQuery" };
  const body = wrapped as { structuredQuery?: unknown; aggregations?: unknown };
  const read = readStructuredQuery({ parent: (request as { parent?: unknown }).parent, structuredQuery: body.structuredQuery });
  if (!Array.isArray(body.aggregations)) return { ...read, warn: read.warn ?? "aggregations" };
  const aggregations: string[] = [];
  let countAlias: string | undefined;
  for (const item of body.aggregations) {
    if (!item || typeof item !== "object") return { ...read, warn: "aggregation" };
    const agg = item as { alias?: unknown; count?: unknown; sum?: { field?: unknown }; avg?: { field?: unknown } };
    const alias = typeof agg.alias === "string" ? agg.alias : undefined;
    if ("count" in agg) {
      aggregations.push("count");
      if (alias) countAlias = alias;
      continue;
    }
    if (agg.sum) {
      const field = fieldPath(agg.sum.field);
      if (!field) return { ...read, warn: "sum" };
      aggregations.push(`sum:${field}`);
      continue;
    }
    if (agg.avg) {
      const field = fieldPath(agg.avg.field);
      if (!field) return { ...read, warn: "avg" };
      aggregations.push(`avg:${field}`);
      continue;
    }
    return { ...read, warn: "aggregation" };
  }
  return { ...read, aggregations, countAlias };
}

/** Integer count from an aggregation result, when this request asked for one. */
export function countResult(chunk: unknown, countAlias: string | undefined): number | undefined {
  if (!countAlias || !chunk || typeof chunk !== "object") return undefined;
  const result = (chunk as { result?: { aggregateFields?: unknown } }).result;
  const fields = result?.aggregateFields;
  if (!fields || typeof fields !== "object") return undefined;
  const value = (fields as Record<string, unknown>)[countAlias];
  const decoded = decodeValue(value);
  return typeof decoded === "number" && Number.isFinite(decoded) ? decoded : undefined;
}

export function classifyWrite(write: unknown): ClassifiedWrite | undefined {
  if (!write || typeof write !== "object") return undefined;
  const w = write as Record<string, unknown>;
  if (typeof w.delete === "string") return { op: "delete", path: resourcePath(w.delete) };
  const update = w.update;
  if (!update || typeof update !== "object") return undefined;
  const name = (update as { name?: unknown }).name;
  if (typeof name !== "string") return undefined;
  const path = resourcePath(name);
  if (w.updateMask) return { op: "update", path };
  const current = w.currentDocument;
  if (current && typeof current === "object" && (current as { exists?: unknown }).exists === false) return { op: "create", path };
  return { op: "set", path };
}

/**
 * One write becomes `set` / `update` / `create` / `delete`.
 * A transaction, and any batch, stays `commit`.
 */
export function classifyCommit(request: unknown): ClassifiedCommit | undefined {
  if (!request || typeof request !== "object") return undefined;
  const req = request as { writes?: unknown; transaction?: unknown };
  if (!Array.isArray(req.writes) || req.writes.length === 0) return undefined;
  const writes: ClassifiedWrite[] = [];
  for (const write of req.writes) {
    const classified = classifyWrite(write);
    if (!classified) return undefined;
    writes.push(classified);
  }
  const transactional = req.transaction != null;
  const only = writes.length === 1 ? writes[0] : undefined;
  if (!transactional && only) return { op: only.op, path: only.path };
  let updates = 0;
  let deletes = 0;
  for (const write of writes) {
    if (write.op === "delete") deletes += 1;
    else updates += 1;
  }
  return {
    op: "commit",
    path: commitPath(writes.map((write) => write.path)),
    commit: { writes: updates, deletes, transactional },
  };
}
