/**
 * Web (and, via `readTarget`, admin) Firestore values → raw call fields.
 * Every internal read is guarded. An unexpected query becomes "no query"
 * so rules that need it stay silent instead of throwing into the host.
 */

import { documentByteSize } from "../core/size.ts";
import type { AdminTarget } from "../admin/shape.ts";
import { decodeValue } from "./values.ts";
import { warnShape } from "./warn.ts";

export interface RawFilter {
  field: string;
  op: string;
  value: unknown;
}

export interface RawOrder {
  field: string;
  direction?: "desc";
}

export interface RawQueryShape {
  filters?: RawFilter[];
  order_by?: RawOrder[];
  limit?: number;
  limit_to_last?: true;
  offset?: number;
  start?: unknown[];
  end?: unknown[];
  aggregations?: string[];
}

export interface TargetShape {
  path: string;
  collectionGroup?: true;
  query?: RawQueryShape;
  kind: "query" | "document" | "aggregate";
}

const WEB_OPS = new Set(["==", "!=", "<", "<=", ">", ">=", "in", "not-in", "array-contains", "array-contains-any"]);

function fieldName(field: unknown): string | undefined {
  if (typeof field === "string") return field;
  if (!field || typeof field !== "object") return undefined;
  const f = field as { canonicalString?: () => string; formattedName?: string };
  try {
    if (typeof f.canonicalString === "function") return f.canonicalString();
  } catch {
    return undefined;
  }
  return typeof f.formattedName === "string" ? f.formattedName : undefined;
}

function mapWebOp(op: string, value: unknown): RawFilter | undefined {
  const fieldOp = WEB_OPS.has(op) ? op : undefined;
  if (!fieldOp) return undefined;
  return { field: "", op: fieldOp, value: decodeValue(value) };
}

function flattenWebFilters(filters: unknown): RawFilter[] | undefined {
  if (!Array.isArray(filters)) return undefined;
  const out: RawFilter[] = [];
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    const f = node as Record<string, unknown>;
    if (Array.isArray(f.filters) && (f.op === "and" || f.op === "or")) {
      for (const child of f.filters) {
        if (!walk(child)) return false;
      }
      return true;
    }
    if (typeof f.op !== "string") return false;
    const field = fieldName(f.field);
    const mapped = field ? mapWebOp(f.op, f.value) : undefined;
    if (!field || !mapped) return false;
    out.push({ field, op: mapped.op, value: mapped.value });
    return true;
  };
  for (const item of filters) {
    if (!walk(item)) return undefined;
  }
  return out;
}

function readOrders(orders: unknown): RawOrder[] | undefined {
  if (!Array.isArray(orders)) return undefined;
  const out: RawOrder[] = [];
  for (const order of orders) {
    if (!order || typeof order !== "object") return undefined;
    const o = order as { field?: unknown; dir?: unknown; direction?: unknown };
    const field = fieldName(o.field);
    if (!field) return undefined;
    const dir = o.dir ?? o.direction;
    if (dir === "desc" || dir === "DESCENDING") out.push({ field, direction: "desc" });
    else out.push({ field });
  }
  return out;
}

function cursor(bound: unknown): unknown[] | undefined {
  if (!bound || typeof bound !== "object") return undefined;
  const position = (bound as { position?: unknown }).position;
  if (!Array.isArray(position)) return undefined;
  return position.map((item) => decodeValue(item));
}

function webQuery(target: Record<string, unknown>): TargetShape | undefined {
  const internal = target._query;
  if (!internal || typeof internal !== "object") {
    warnShape("query has no _query");
    return undefined;
  }
  const q = internal as Record<string, unknown>;
  let canonical = "";
  try {
    const path = q.path as { canonicalString?: () => string } | undefined;
    canonical = path?.canonicalString?.() ?? "";
  } catch (error) {
    warnShape(error instanceof Error ? error.message : "path");
    return undefined;
  }
  const group = typeof q.collectionGroup === "string" && q.collectionGroup.length > 0 ? q.collectionGroup : undefined;
  const path = group ?? canonical;
  if (!path) {
    warnShape("empty query path");
    return undefined;
  }
  const shape: TargetShape = { kind: "query", path };
  if (group) shape.collectionGroup = true;
  try {
    const filters = Array.isArray(q.filters) ? flattenWebFilters(q.filters) : q.filters == null ? [] : undefined;
    const orders = Array.isArray(q.explicitOrderBy) ? readOrders(q.explicitOrderBy) : q.explicitOrderBy == null ? [] : undefined;
    if (filters === undefined || orders === undefined) {
      warnShape("web query constraints");
      return shape;
    }
    const query: RawQueryShape = {};
    if (filters.length > 0) query.filters = filters;
    if (orders.length > 0) query.order_by = orders;
    if (typeof q.limit === "number") query.limit = q.limit;
    if (q.limitType === "L") query.limit_to_last = true;
    if (typeof q.offset === "number" && q.offset > 0) query.offset = q.offset;
    const start = cursor(q.startAt);
    const end = cursor(q.endAt);
    if (start) query.start = start;
    if (end) query.end = end;
    // `{}` means the constraints were read and there is no limit(). Omitting it
    // made getDocs(collection(...)) look like an unreadable query.
    shape.query = query;
    return shape;
  } catch (error) {
    warnShape(error instanceof Error ? error.message : "web query");
    return shape;
  }
}

function aggregateSpec(target: Record<string, unknown>): Record<string, unknown> | undefined {
  const spec = target._aggregateSpec ?? target.aggregateSpec;
  if (spec && typeof spec === "object") return spec as Record<string, unknown>;
  return undefined;
}

function webAggregate(target: Record<string, unknown>): TargetShape | undefined {
  const inner = target.query ?? target._query;
  const base = inner && typeof inner === "object" ? readTarget(inner) : undefined;
  if (!base) {
    warnShape("aggregate query");
    return undefined;
  }
  const spec = aggregateSpec(target);
  const aggregations = spec ? aggregationsFromSpec(spec) : undefined;
  const shape: TargetShape = { ...base, kind: "aggregate" };
  if (aggregations && aggregations.length > 0) {
    shape.query = { ...(base.query ?? {}), aggregations };
  }
  return shape;
}

/** `count`, `sum:<field>`, `avg:<field>` from an aggregate spec object. */
export function aggregationsFromSpec(spec: unknown): string[] | undefined {
  if (!spec || typeof spec !== "object") return undefined;
  const out: string[] = [];
  for (const field of Object.values(spec as Record<string, unknown>)) {
    if (!field || typeof field !== "object") return undefined;
    const f = field as { aggregateType?: unknown; _internalFieldPath?: { canonicalString?: () => string } };
    if (f.aggregateType === "count") {
      out.push("count");
      continue;
    }
    if (f.aggregateType !== "sum" && f.aggregateType !== "avg") return undefined;
    let name = "";
    try {
      name = f._internalFieldPath?.canonicalString?.() ?? "";
    } catch {
      return undefined;
    }
    if (!name) return undefined;
    out.push(`${f.aggregateType}:${name}`);
  }
  return out;
}

/**
 * Admin SDK target reader. `admin/shape.ts` installs it when it loads (the
 * admin entry imports it, and so does the lazy chunk `init` starts), so it
 * stays out of the eager browser glue.
 */
let adminReader: ((target: unknown) => AdminTarget | undefined) | undefined;

export function setAdminReader(reader: (target: unknown) => AdminTarget | undefined): void {
  adminReader = reader;
}

export function readTarget(target: unknown): TargetShape | undefined {
  try {
    if (!target || typeof target !== "object") return undefined;
    const t = target as Record<string, unknown>;
    if (t.type === "query" || t.type === "collection") return webQuery(t);
    if (t.type === "document" && typeof t.path === "string") return { kind: "document", path: t.path };
    if (t.type === "AggregateQuery") return webAggregate(t);
    const admin = adminReader?.(target);
    if (!admin) return undefined;
    return admin as TargetShape;
  } catch (error) {
    warnShape(error instanceof Error ? error.message : "target");
    return undefined;
  }
}

export function mutationStats(batch: unknown): { writes: number; deletes: number; paths: string[] } | undefined {
  try {
    if (!batch || typeof batch !== "object") return undefined;
    const mutations = (batch as { _mutations?: unknown })._mutations;
    if (!Array.isArray(mutations)) return undefined;
    let writes = 0;
    let deletes = 0;
    const paths: string[] = [];
    for (const mutation of mutations) {
      if (!mutation || typeof mutation !== "object") continue;
      const m = mutation as { type?: unknown; key?: { path?: { canonicalString?: () => string } } };
      let path = "";
      try {
        path = m.key?.path?.canonicalString?.() ?? "";
      } catch {
        path = "";
      }
      if (path) paths.push(path);
      const type = m.type;
      const name = mutation.constructor?.name ?? "";
      if (type === 0 || type === 1 || name === "SetMutation" || name === "PatchMutation") writes += 1;
      else if (type === 2 || name === "DeleteMutation") deletes += 1;
    }
    return { writes, deletes, paths };
  } catch (error) {
    warnShape(error instanceof Error ? error.message : "mutations");
    return undefined;
  }
}

/** One document path when the writes don't share a parent collection. */
export function commitPath(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const first = paths[0] ?? "";
  if (paths.length === 1) return first;
  const parents = paths.map((path) => {
    const at = path.lastIndexOf("/");
    return at < 0 ? "" : path.slice(0, at);
  });
  const parent = parents[0] ?? "";
  if (parent.length > 0 && parents.every((item) => item === parent)) return parent;
  return first;
}

function docFields(doc: Record<string, unknown>): unknown {
  const proto = doc._fieldsProto;
  if (typeof proto === "function") {
    try {
      const fields = (proto as () => unknown).call(doc);
      if (fields) return fields;
    } catch {
      // Fall through to the document proto.
    }
  }
  const document = doc._document as { data?: { value?: { mapValue?: { fields?: unknown } } } } | null | undefined;
  return document?.data?.value?.mapValue?.fields;
}

function oneDocBytes(doc: unknown): number {
  if (!doc || typeof doc !== "object") return 0;
  const d = doc as Record<string, unknown>;
  if (typeof d.exists === "function" && d.exists() === false) return 0;
  if (d.exists === false) return 0;
  let path = "";
  try {
    const ref = d.ref as { path?: string } | undefined;
    if (typeof ref?.path === "string") path = ref.path;
    else {
      const key = d._key as { path?: { canonicalString?: () => string } } | undefined;
      path = key?.path?.canonicalString?.() ?? "";
    }
  } catch {
    path = "";
  }
  return documentByteSize(path, docFields(d));
}

/** Estimated stored bytes. Reads `docs` / document fields. Call before usage accessors. */
export function resultByteSize(snap: unknown): number {
  try {
    if (!snap || typeof snap !== "object") return 0;
    const docs = (snap as { docs?: unknown }).docs;
    if (Array.isArray(docs)) {
      let total = 0;
      for (const doc of docs) total += oneDocBytes(doc);
      return total;
    }
    return oneDocBytes(snap);
  } catch {
    return 0;
  }
}

export function docCount(snap: unknown, kind: TargetShape["kind"]): number {
  try {
    if (kind === "aggregate") return 1;
    if (kind === "query") {
      const size = (snap as { size?: unknown }).size;
      return typeof size === "number" && size >= 0 ? size : 0;
    }
    if (typeof (snap as { exists?: unknown }).exists === "function") {
      return (snap as { exists: () => boolean }).exists() ? 1 : 0;
    }
    if ((snap as { exists?: unknown }).exists === true) return 1;
    return 0;
  } catch {
    return 0;
  }
}

export function fromCache(snap: unknown): boolean {
  try {
    return (snap as { metadata?: { fromCache?: boolean } }).metadata?.fromCache === true;
  } catch {
    return false;
  }
}

export function hasOnlyLocalWrites(snap: unknown, kind: TargetShape["kind"]): boolean {
  try {
    const meta = (snap as { metadata?: { hasPendingWrites?: boolean; fromCache?: boolean } }).metadata;
    if (!meta?.hasPendingWrites || !meta.fromCache) return false;
    if (kind !== "query") return true;
    const changes = (snap as { docChanges?: () => unknown }).docChanges?.();
    return Array.isArray(changes) && changes.length === 0;
  } catch {
    return false;
  }
}

export function changedDocs(snap: unknown, kind: TargetShape["kind"], initial: boolean): number {
  if (initial) return docCount(snap, kind);
  if (kind !== "query") return 1;
  try {
    const changes = (snap as { docChanges?: () => unknown[] }).docChanges?.();
    return Array.isArray(changes) ? changes.length : 0;
  } catch {
    return 0;
  }
}

export function isAggregateSnapshot(snap: unknown): boolean {
  return !!snap && typeof snap === "object" && (snap as { type?: unknown }).type === "AggregateQuerySnapshot";
}

/** The alias whose aggregate is `count`, and the spec the snapshot came from, when present. */
export function aggregateCount(snap: unknown, spec: unknown): number | undefined {
  try {
    const data = (snap as { data?: () => Record<string, unknown> }).data?.();
    if (!data || !spec || typeof spec !== "object") {
      return typeof data?.count === "number" ? data.count : undefined;
    }
    for (const [alias, field] of Object.entries(spec as Record<string, unknown>)) {
      if ((field as { aggregateType?: string } | undefined)?.aggregateType === "count" && typeof data[alias] === "number") {
        return data[alias];
      }
    }
    return typeof data.count === "number" ? data.count : undefined;
  } catch {
    return undefined;
  }
}

export type { AdminTarget };
